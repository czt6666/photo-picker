// 导出对话框：选范围（星标/选中/全部星标）→ 选目标文件夹 → 原图复制或缩小导出 → 进度 → 在访达中显示。

import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api, rawTag } from './api';
import { prefs, store } from './store';
import type { ExportMode, Photo, Progress } from './types';
import { esc, toast } from './ui';

type Scope = 'view-starred' | 'selected' | 'all-starred';

interface ExportPrefs {
  dest: string;
  mode: ExportMode;
  maxPx: number;
  quality: number;
  /** 同时导出同名 RAW（旧版保存的偏好里没有这个字段 → 默认开） */
  withRaw?: boolean;
}

const SIZES = [1280, 1600, 2048, 2560, 3840];

export function isExportOpen(): boolean {
  return !document.getElementById('export-dialog')!.hidden;
}

let closeCurrent: (() => void) | null = null;

export function closeExportDialog(): void {
  closeCurrent?.();
}

export function openExportDialog(): void {
  const el = document.getElementById('export-dialog')!;
  const p = prefs.get<ExportPrefs>('export', { dest: '', mode: 'original', maxPx: 2048, quality: 90 });
  const viewStarred = store.all.filter((x) => x.starred);
  const selected = store.selectedPhotos();
  const allStarred = store.totalStarred();
  const inStarredView = store.view.kind === 'starred';
  const viewName =
    store.view.kind === 'folder' ? (store.folder(store.view.path)?.name ?? '') : inStarredView ? '星标照片' : '';

  const withRawCount = (list: Photo[]) => list.filter((x) => rawTag(x)).length;
  const rawHint =
    store.view.kind === 'starred'
      ? '星标相册里的照片会按各自文件夹里的同名 RAW 导出。'
      : `当前相册的星标照片中有 ${withRawCount(viewStarred)} 张带 RAW；选中的照片中有 ${withRawCount(selected)} 张带 RAW。`;

  let scope: Scope = selected.length > 1 ? 'selected' : viewStarred.length ? 'view-starred' : 'all-starred';
  if (inStarredView && scope === 'view-starred') scope = 'all-starred';

  const radio = (value: Scope, label: string, n: number, hidden = false) =>
    hidden
      ? ''
      : `<label class="opt ${n ? '' : 'disabled'}"><input type="radio" name="scope" value="${value}" ${n ? '' : 'disabled'} ${
          scope === value ? 'checked' : ''
        }> ${label} <b>${n}</b> 张</label>`;

  el.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="导出照片">
      <h2>导出照片</h2>
      <div class="field">
        <div class="label">导出哪些</div>
        ${radio('view-starred', '当前文件夹中的星标照片', viewStarred.length, inStarredView)}
        ${radio('selected', '选中的照片', selected.length)}
        ${radio('all-starred', '全部星标照片（工作目录中的所有相册）', allStarred)}
      </div>
      <div class="field">
        <div class="label">导出到</div>
        <div class="row">
          <input class="input dest" readonly placeholder="请选择目标文件夹" value="${esc(p.dest)}">
          <button class="btn pick">选择…</button>
        </div>
        <div class="row">
          <span class="dim">并新建子文件夹</span>
          <input class="input sub" placeholder="（留空则直接放进目标文件夹）" value="${esc(viewName ? `${viewName} 精选` : '')}">
        </div>
      </div>
      <div class="field">
        <div class="label">图片尺寸</div>
        <label class="opt"><input type="radio" name="mode" value="original" ${p.mode === 'original' ? 'checked' : ''}>
          原图（直接复制文件，最快，画质无损）</label>
        <label class="opt"><input type="radio" name="mode" value="resize" ${p.mode === 'resize' ? 'checked' : ''}>
          缩小：长边
          <select class="input maxpx">${SIZES.map((s) => `<option value="${s}" ${s === p.maxPx ? 'selected' : ''}>${s}</option>`).join('')}</select>
          像素，质量 <input type="range" class="quality" min="60" max="100" step="1" value="${p.quality}"> <span class="qv">${p.quality}</span>
        </label>
        <div class="hint dim">缩小导出会保留 JPEG 原图的拍摄时间、相机参数、GPS 等 EXIF 信息；比目标尺寸还小的 JPEG 直接复制。</div>
      </div>
      <div class="field">
        <label class="opt"><input type="checkbox" class="with-raw" ${p.withRaw === false ? '' : 'checked'}>
          同时导出同名的 RAW 文件（RAW+JPG 一起导出，RAW 总是原样复制）</label>
        <div class="hint dim">${rawHint}</div>
      </div>
      <div class="progress" hidden>
        <div class="bar"><div class="fill"></div></div>
        <div class="ptext dim"></div>
      </div>
      <div class="actions">
        <button class="btn cancel">取消</button>
        <button class="btn primary go">导出</button>
      </div>
    </div>`;
  el.hidden = false;

  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const dest = $<HTMLInputElement>('.dest');
  const sub = $<HTMLInputElement>('.sub');
  const quality = $<HTMLInputElement>('.quality');
  const maxpx = $<HTMLSelectElement>('.maxpx');
  const go = $<HTMLButtonElement>('.go');
  const cancel = $<HTMLButtonElement>('.cancel');
  const progress = $('.progress');
  const fill = $('.fill');
  const ptext = $('.ptext');
  let running = false;
  let unlisten: (() => void) | null = null;

  const close = () => {
    if (running) return;
    unlisten?.();
    el.hidden = true;
    el.innerHTML = '';
    closeCurrent = null;
  };
  closeCurrent = close;

  el.onclick = (e) => {
    if (e.target === el) close();
  };
  quality.oninput = () => ($('.qv').textContent = quality.value);
  maxpx.onfocus = quality.onfocus = () => {
    el.querySelector<HTMLInputElement>('input[name=mode][value=resize]')!.checked = true;
  };
  $('.pick').onclick = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dest.value || undefined, title: '选择导出到哪个文件夹' });
    if (typeof picked === 'string') dest.value = picked;
  };
  cancel.onclick = () => {
    if (running) void api.cancelExport();
    else close();
  };

  go.onclick = async () => {
    if (go.dataset.done) return close();
    const scopeVal = el.querySelector<HTMLInputElement>('input[name=scope]:checked')?.value as Scope | undefined;
    const mode = (el.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'original') as ExportMode;
    if (!scopeVal) return toast('没有可导出的照片', 'warn');
    if (!dest.value) {
      $('.pick').click();
      return;
    }
    let photos: Photo[];
    if (scopeVal === 'selected') photos = selected;
    else if (scopeVal === 'view-starred') photos = viewStarred;
    else photos = await api.listStarred();
    if (!photos.length) return toast('没有可导出的照片', 'warn');

    const withRaw = $<HTMLInputElement>('.with-raw').checked;
    const settings: ExportPrefs = { dest: dest.value, mode, maxPx: Number(maxpx.value), quality: Number(quality.value), withRaw };
    prefs.set('export', settings);

    running = true;
    go.disabled = true;
    cancel.textContent = '停止';
    el.querySelectorAll<HTMLInputElement>('input, select').forEach((i) => (i.disabled = true));
    progress.hidden = false;
    fill.style.width = '0%';
    ptext.textContent = `准备导出 ${photos.length} 张…`;
    unlisten = await listen<Progress>('export-progress', (e) => {
      const { done, total, current } = e.payload;
      fill.style.width = `${(done / total) * 100}%`;
      ptext.textContent = `${done} / ${total}  ${current ?? ''}`;
    });

    try {
      const r = await api.exportPhotos({
        paths: photos.map((x) => x.path),
        dest: settings.dest,
        subfolder: sub.value.trim() || undefined,
        mode,
        maxPx: settings.maxPx,
        quality: settings.quality,
        includeCompanions: withRaw,
      });
      fill.style.width = '100%';
      const failed = r.failed.length
        ? `，${r.failed.length} 个文件失败：${r.failed.slice(0, 3).map((f) => `${f.path.split(/[\\/]/).pop()}（${f.error}）`).join('；')}`
        : '';
      const extra = r.files > r.exported ? `（共 ${r.files} 个文件，含同名 RAW）` : '';
      ptext.innerHTML = `${r.cancelled ? '已停止。' : '完成！'}导出了 <b>${r.exported}</b> 张${extra}${esc(failed)}<br><span class="path">${esc(r.dest)}</span>`;
      const reveal = document.createElement('button');
      reveal.className = 'btn';
      reveal.textContent = '在访达中显示';
      reveal.onclick = () => void revealItemInDir(r.dest).catch(() => {});
      cancel.replaceWith(reveal);
      go.textContent = '完成';
      go.dataset.done = '1';
    } catch (e) {
      ptext.textContent = `导出失败：${e}`;
      cancel.textContent = '关闭';
      go.dataset.done = '1';
      go.textContent = '关闭';
    } finally {
      running = false;
      go.disabled = false;
      unlisten?.();
      unlisten = null;
    }
  };
  go.focus();
}

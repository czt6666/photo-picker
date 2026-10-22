// 导出对话框：选范围（星标/选中/全部星标）→ 选目标文件夹 → 原图复制或缩小导出 → 进度 → 在访达 / 资源管理器中显示。

import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { REVEAL_LABEL } from './platform';
import { api } from './api';
import { prefs, store } from './store';
import type { ExportMode, Progress } from './types';
import { t } from './i18n';
import { esc, toast } from './ui';

type Scope = 'view-starred' | 'selected';

interface ExportPrefs {
  dest: string;
  mode: ExportMode;
  maxPx: number;
  quality: number;
  /** 同时导出同名 RAW（旧版保存的偏好里没有这个字段 → 默认开） */
  withRaw?: boolean;
}

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
  const workdirAtOpen = store.library.workdir;
  // 连续翻动时列表里接着好几个相册，“当前文件夹”只算正在看的那个
  const v = store.view;
  const viewStarred = store.all.filter((x) => x.starred && (v.kind !== 'folder' || x.dir === v.path));
  const selected = store.selectedPhotos();
  const inStarredView = store.view.kind === 'starred';
  const viewName = store.view.kind === 'folder' ? (store.folder(store.view.path)?.name ?? '') : '';

  const scope: Scope = selected.length > 1 || !viewStarred.length ? 'selected' : 'view-starred';

  const radio = (value: Scope, label: string, n: number) =>
    `<label class="opt ${n ? '' : 'disabled'}"><input type="radio" name="scope" value="${value}" ${n ? '' : 'disabled'} ${
          scope === value ? 'checked' : ''
        }> ${label} <b>${n}</b></label>`;

  el.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="${t('导出照片')}">
      <h2>${t('导出照片')}</h2>
      <div class="field">
        <div class="label">${t('范围')}</div>
        ${radio('view-starred', inStarredView ? t('星标照片') : t('当前相册的星标'), viewStarred.length)}
        ${radio('selected', t('选中的'), selected.length)}
      </div>
      <div class="field">
        <div class="label">${t('导出到')}</div>
        <div class="row">
          <input class="input dest" readonly value="${esc(p.dest)}">
          <button class="btn pick">${t('选择')}</button>
        </div>
        <div class="row">
          <span class="dim">${t('子文件夹')}</span>
          <input class="input sub" placeholder="${t('可留空')}" value="${esc(viewName ? t('{name} 精选', { name: viewName }) : '')}">
        </div>
      </div>
      <div class="field">
        <label class="opt"><input type="checkbox" class="with-raw" ${p.withRaw === false ? '' : 'checked'}>
          ${t('带上同名的')} RAW</label>
      </div>
      <div class="progress" hidden>
        <div class="bar"><div class="fill"></div></div>
        <div class="ptext dim"></div>
      </div>
      <div class="actions">
        <button class="btn cancel">${t('取消')}</button>
        <button class="btn primary go">${t('导出')}</button>
      </div>
    </div>`;
  el.hidden = false;

  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const dest = $<HTMLInputElement>('.dest');
  const sub = $<HTMLInputElement>('.sub');
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
  $('.pick').onclick = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dest.value || undefined, title: t('选择导出文件夹') });
    if (typeof picked === 'string') dest.value = picked;
  };
  cancel.onclick = () => {
    if (running) void api.cancelExport();
    else close();
  };

  go.onclick = async () => {
    if (go.dataset.done) return close();
    if (running) return;
    if (store.library.workdir !== workdirAtOpen) {
      toast(t('工作目录已切换，请重新打开'), 'warn');
      return close();
    }
    const scopeVal = el.querySelector<HTMLInputElement>('input[name=scope]:checked')?.value as Scope | undefined;
    if (!scopeVal) return toast(t('没有可导出的照片'), 'warn');
    if (!dest.value) {
      $('.pick').click();
      return;
    }
    const photos = scopeVal === 'selected' ? selected : viewStarred;
    if (!photos.length) return toast(t('没有可导出的照片'), 'warn');

    const withRaw = $<HTMLInputElement>('.with-raw').checked;
    // 只导出原图（直接复制文件）；缩小导出的后端能力还在，界面上不再提供
    const settings: ExportPrefs = { ...p, dest: dest.value, withRaw };
    prefs.set('export', settings);

    running = true;
    go.disabled = true;
    cancel.textContent = t('停止');
    el.querySelectorAll<HTMLInputElement>('input, select').forEach((i) => (i.disabled = true));
    progress.hidden = false;
    fill.style.width = '0%';
    ptext.textContent = t('准备导出 {n} 张…', { n: photos.length });
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
        mode: 'original',
        maxPx: settings.maxPx,
        quality: settings.quality,
        includeCompanions: withRaw,
      });
      fill.style.width = '100%';
      const failed = r.failed.length
        ? t('，{n} 个失败：{list}', {
            n: r.failed.length,
            list: r.failed.slice(0, 3).map((f) => `${f.path.split(/[\\/]/).pop()} (${f.error})`).join('; '),
          })
        : '';
      const extra = r.files > r.exported ? t('（{n} 个文件，含 RAW）', { n: r.files }) : '';
      const head = t(r.cancelled ? '已停止，导出了 {n} 张' : '已导出 {n} 张', { n: r.exported });
      ptext.innerHTML = `${esc(head + extra + failed)}<br><span class="path">${esc(r.dest)}</span>`;
      const reveal = document.createElement('button');
      reveal.className = 'btn';
      reveal.textContent = REVEAL_LABEL;
      reveal.onclick = () => void revealItemInDir(r.dest).catch(() => {});
      cancel.replaceWith(reveal);
      go.textContent = t('完成');
      go.dataset.done = '1';
    } catch (e) {
      ptext.textContent = t('导出失败：{e}', { e: String(e) });
      cancel.textContent = t('关闭');
      go.dataset.done = '1';
      go.textContent = t('关闭');
    } finally {
      running = false;
      go.disabled = false;
      unlisten?.();
      unlisten = null;
    }
  };
  go.focus();
}

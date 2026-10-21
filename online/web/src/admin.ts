// 摄影师管理页：/a/<管理令牌>
// 上传（浏览器里压缩）、共享码、设置、看谁选了什么、导出清单。

import { forgetAlbum, rememberAlbum } from './albums';
import {
  $, Album, api, ApiError, applyI18n, copyText, dialog, download, errMsg, fmt, h, Photo, Picker, previewUrl, sortPhotos, t, thumbUrl, timeAgo, toast,
} from './common';
import { pickedPhotos, toCsv, toStems, toTxt } from './export';
import { compress, groupFiles, PhotoGroup, SourceFile } from './upload';
import { Viewer, ViewerItem } from './viewer';

const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/admin/${encodeURIComponent(token)}`;

let album: Album;
let photos: Photo[] = [];
let pickers: Picker[] = [];
let photoFilter = ''; // '' 全部，'*' 有人选的，其它 = 某个人的名字

applyI18n();

async function load() {
  const data = await api<{ album: Album; photos: Photo[]; pickers: Picker[] }>('GET', base);
  album = data.album;
  photos = sortPhotos(data.photos);
  pickers = data.pickers;
  rememberAlbum(token, album.name);
}

async function main() {
  try {
    await load();
  } catch (e) {
    $('#loading').textContent = errMsg(e);
    if (e instanceof ApiError && e.status === 404) forgetAlbum(token);
    return;
  }
  $('#loading').hidden = true;
  $('#app').hidden = false;
  bind();
  render();
}

function shareUrl() {
  return `${location.origin}/s/${album.share_code}`;
}

function render() {
  document.title = album.name;
  $('#album-name').textContent = album.name + ' ✎';
  $('#code').textContent = album.share_code!;
  $('#link').textContent = shareUrl();
  $<HTMLInputElement>('#limit').value = String(album.pick_limit ?? 0);
  $<HTMLInputElement>('#closed').checked = album.closed;
  renderPickers();
  renderFilter();
  renderGrid();
}

// ---------- 选片结果 ----------

function renderPickers() {
  const box = $('#pickers');
  box.replaceChildren();
  if (!pickers.length) {
    box.append(h('p', { class: 'dim' }, t('还没有人来选。把共享码发给模特吧。', 'Nobody has picked yet. Send the share code.')));
    return;
  }
  const rows: (Picker | null)[] = [...pickers];
  if (pickers.length > 1) rows.push(null); // 合并
  for (const pk of rows) {
    const list = pickedPhotos(photos, pickers, pk ? pk.name : null);
    const title = pk ? pk.name : t('所有人合并', 'Everyone combined');
    const status = pk
      ? h('span', { class: 'badge ' + (pk.submitted ? 'ok' : '') }, pk.submitted ? t('已提交', 'Sent') : t('选片中', 'Picking'))
      : null;
    const meta = pk
      ? fmt(t('选了 {n} 张 · {ago}', '{n} picked · {ago}'), { n: pk.picks.length, ago: timeAgo(pk.updated_at) })
      : fmt(t('共 {n} 张', '{n} total'), { n: list.length });
    const fileBase = `${album.name}-${pk ? pk.name : t('全部', 'all')}`.replace(/[\\/:*?"<>|]/g, '_');
    const btn = (label: string, fn: () => void, cls = 'btn small') => {
      const b = h('button', { class: cls }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const actions = h(
      'div',
      { class: 'row wrap' },
      btn(t('下载清单 .txt', 'List .txt'), () => download(`${fileBase}.txt`, toTxt(list, `${album.name} · ${title}`))),
      btn(t('表格 .csv', 'Sheet .csv'), () => download(`${fileBase}.csv`, toCsv(list), 'text/csv')),
      btn(t('复制文件名', 'Copy names'), async () => {
        if (await copyText(toStems(list))) toast(fmt(t('已复制 {n} 个文件名', 'Copied {n} names'), { n: list.length }));
      }),
      btn(t('只看这些', 'Show'), () => {
        photoFilter = pk ? pk.name : '*';
        renderFilter();
        renderGrid();
        $('.photos').scrollIntoView({ behavior: 'smooth' });
      }),
      pk
        ? btn(
            t('删除', 'Delete'),
            async () => {
              const ok = await dialog({
                title: fmt(t('删除「{name}」的选片？', "Delete {name}'s picks?"), { name: pk.name }),
                body: t('比如测试时留下的记录。删除后无法恢复。', 'E.g. a test entry. This cannot be undone.'),
                ok: t('删除', 'Delete'),
                danger: true,
              });
              if (ok === null) return;
              await act(() => api('DELETE', `${base}/pickers/${encodeURIComponent(pk.name)}`));
              await refresh();
            },
            'btn small ghost',
          )
        : null,
    );
    box.append(
      h(
        'div',
        { class: 'picker' + (pk ? '' : ' combined') },
        h('div', { class: 'row' }, h('b', {}, title), status, h('span', { class: 'dim small' }, meta)),
        list.length ? actions : null,
      ),
    );
  }
}

// ---------- 照片网格 ----------

function renderFilter() {
  const sel = $<HTMLSelectElement>('#photo-filter');
  sel.replaceChildren(
    h('option', { value: '' }, t('全部', 'All')),
    h('option', { value: '*' }, t('有人选的', 'Picked by anyone')),
    ...pickers.map((p) => h('option', { value: p.name }, fmt(t('{name} 选的', 'Picked by {name}'), { name: p.name }))),
  );
  if (photoFilter && photoFilter !== '*' && !pickers.some((p) => p.name === photoFilter)) photoFilter = '';
  sel.value = photoFilter;
}

/** photo_id → 选了它的人和备注 */
function picksByPhoto() {
  const m = new Map<number, { name: string; note: string }[]>();
  for (const pk of pickers)
    for (const p of pk.picks) {
      if (!m.has(p.photo_id)) m.set(p.photo_id, []);
      m.get(p.photo_id)!.push({ name: pk.name, note: p.note });
    }
  return m;
}

let gridItems: ViewerItem[] = [];
let byPhoto = new Map<number, { name: string; note: string }[]>();

function visiblePhotos() {
  if (!photoFilter) return photos;
  return photos.filter((p) => {
    const by = byPhoto.get(p.id);
    return by && (photoFilter === '*' || by.some((b) => b.name === photoFilter));
  });
}

function renderGrid() {
  byPhoto = picksByPhoto();
  const list = visiblePhotos();
  $('#n-photos').textContent = photoFilter ? `${list.length} / ${photos.length}` : String(photos.length);
  gridItems = list.map(toItem);
  const grid = $('#grid');
  grid.replaceChildren(...list.map(cellFor));
  $('#empty').hidden = photos.length > 0;
}

function toItem(p: Photo): ViewerItem {
  return { id: p.id, name: p.name, width: p.width, height: p.height, thumb: thumbUrl(album.id, p), preview: previewUrl(album.id, p) };
}

function cellFor(p: Photo) {
  const by = byPhoto.get(p.id) ?? [];
  return h(
    'div',
    { class: 'cell' + (by.length ? ' picked' : '') + (by.some((b) => b.note) ? ' has-note' : ''), 'data-id': String(p.id), title: p.name },
    h('img', { src: thumbUrl(album.id, p), alt: p.name, loading: 'lazy', decoding: 'async', draggable: 'false' }),
    by.length ? h('span', { class: 'count' }, `♥${by.length > 1 ? by.length : ''}`) : null,
    h('span', { class: 'note-dot' }, '✎'),
    h('button', { class: 'del', title: t('删除这张', 'Delete') }, '✕'),
  );
}

const viewer = new Viewer({
  isPicked: (it) => byPhoto.has(it.id),
  noteOf: (it) =>
    (byPhoto.get(it.id) ?? [])
      .filter((b) => b.note)
      .map((b) => `${b.name}：${b.note}`)
      .join('\n'),
  extraOf: (it) => {
    const by = byPhoto.get(it.id);
    return by ? '♥ ' + by.map((b) => b.name).join('、') : '';
  },
});

// ---------- 交互 ----------

async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast(errMsg(e), 'error');
    return undefined;
  }
}

async function refresh() {
  await act(load);
  render();
}

async function patch(body: Record<string, unknown>) {
  const r = await act(() => api<{ album: Album }>('PATCH', base, body));
  if (r) album = r.album;
  render();
}

function bind() {
  $('#refresh').addEventListener('click', async () => {
    await refresh();
    toast(t('已刷新', 'Refreshed'));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !uploading) refresh();
  });

  $('#album-name').addEventListener('click', async () => {
    const v = await dialog({ title: t('相册名', 'Album name'), input: { value: album.name } });
    if (v && v.trim() !== album.name) await patch({ name: v });
  });

  $('#copy-link').addEventListener('click', async () => {
    if (await copyText(shareUrl())) toast(t('链接已复制', 'Link copied'));
  });
  $('#copy-invite').addEventListener('click', async () => {
    const limit = album.pick_limit ? fmt(t('，请选 {k} 张', ', pick {k}'), { k: album.pick_limit }) : '';
    const text = fmt(t('「{name}」的照片可以选啦{limit}。\n打开 {url}\n（共享码 {code}）', 'Photos from "{name}" are ready to pick{limit}.\nOpen {url}\n(code {code})'), {
      name: album.name,
      limit,
      url: shareUrl(),
      code: album.share_code!,
    });
    if (await copyText(text)) toast(t('邀请已复制，去微信粘贴给模特', 'Invite copied'));
  });
  $('#reset-code').addEventListener('click', async () => {
    const ok = await dialog({
      title: t('换个共享码？', 'Change share code?'),
      body: t('旧码和旧链接会立刻失效，已选的结果保留。', 'The old code and link stop working. Picks are kept.'),
      ok: t('换', 'Change'),
    });
    if (ok === null) return;
    const r = await act(() => api<{ share_code: string }>('POST', `${base}/code`));
    if (r) {
      album.share_code = r.share_code;
      render();
    }
  });

  $<HTMLInputElement>('#limit').addEventListener('change', (e) => {
    const n = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
    patch({ pick_limit: n });
  });
  $<HTMLInputElement>('#closed').addEventListener('change', (e) => patch({ closed: (e.target as HTMLInputElement).checked }));

  $<HTMLSelectElement>('#photo-filter').addEventListener('change', (e) => {
    photoFilter = (e.target as HTMLSelectElement).value;
    renderGrid();
  });

  $('#grid').addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const cell = target.closest<HTMLElement>('.cell');
    if (!cell) return;
    const id = Number(cell.dataset.id);
    if (target.closest('.del')) {
      const p = photos.find((x) => x.id === id)!;
      const ok = await dialog({ title: fmt(t('删除 {name}？', 'Delete {name}?'), { name: p.name }), body: t('只删线上的预览，不动你电脑上的原图。', 'Only the online preview is deleted.'), ok: t('删除', 'Delete'), danger: true });
      if (ok === null) return;
      if (await act(() => api('DELETE', `${base}/photos/${id}`))) {
        photos = photos.filter((x) => x.id !== id);
        for (const pk of pickers) pk.picks = pk.picks.filter((x) => x.photo_id !== id);
        cell.remove();
        renderPickers();
        gridItems = gridItems.filter((x) => x.id !== id);
      }
      return;
    }
    viewer.open(gridItems, gridItems.findIndex((it) => it.id === id));
  });

  $('#delete-album').addEventListener('click', async () => {
    const v = await dialog({
      title: t('删除整个相册？', 'Delete the whole album?'),
      body: fmt(t('预览图和所有选片结果都会删掉，无法恢复。输入相册名「{name}」确认。', 'Previews and all picks will be gone. Type "{name}" to confirm.'), { name: album.name }),
      input: { value: '' },
      ok: t('删除', 'Delete'),
      danger: true,
    });
    if (v === null) return;
    if (v.trim() !== album.name) {
      toast(t('名字不对，没删', 'Name mismatch, not deleted'), 'error');
      return;
    }
    if (await act(() => api('DELETE', base))) {
      forgetAlbum(token);
      location.href = '/';
    }
  });

  bindUpload();
}

// ---------- 上传 ----------

let uploading = false;
let cancelled = false;

function bindUpload() {
  const folderIn = $<HTMLInputElement>('#in-folder');
  const filesIn = $<HTMLInputElement>('#in-files');
  $('#pick-folder').addEventListener('click', () => folderIn.click());
  $('#pick-files').addEventListener('click', () => filesIn.click());
  for (const input of [folderIn, filesIn]) {
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      input.value = '';
      startUpload(files);
    });
  }
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const entries = [...(e.dataTransfer?.items ?? [])].map((it) => it.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    const files: SourceFile[] = [];
    for (const entry of entries) await walkEntry(entry, files);
    startUpload(files);
  });
  $('#cancel').addEventListener('click', () => (cancelled = true));
  window.addEventListener('beforeunload', (e) => {
    if (uploading) e.preventDefault();
  });
}

/** 拖进来的文件夹要自己递归展开 */
async function walkEntry(entry: FileSystemEntry, out: SourceFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)).catch(() => null);
    if (file) out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // 每次最多返回 100 个，要一直读到空
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)).catch(() => []);
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, out);
  }
}

async function uploadOne(g: PhotoGroup): Promise<Photo> {
  const c = await compress(g.source);
  const meta = { key: g.key, name: g.source.file.name, folder: g.folder, originals: g.originals, width: c.width, height: c.height };
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('thumb', c.thumb, 'thumb.jpg');
    form.append('preview', c.preview, 'preview.jpg');
    try {
      const r = await api<{ photo: Photo }>('POST', `${base}/photos`, form);
      return r.photo;
    } catch (e) {
      // 网络抖动或服务器临时出错就等一下重试，参数错误直接放弃
      const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retryable || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function startUpload(files: SourceFile[]) {
  if (uploading) {
    toast(t('正在上传，等这批传完', 'Upload in progress'), 'error');
    return;
  }
  const groups = groupFiles(files);
  if (!groups.length) {
    toast(t('没找到能用的照片（支持 JPG/PNG/HEIC/RAW 等）', 'No usable photos found'), 'error');
    return;
  }
  const have = new Set(photos.map((p) => p.key));
  const todo = groups.filter((g) => !have.has(g.key));
  const skipped = groups.length - todo.length;
  if (!todo.length) {
    toast(fmt(t('这 {n} 张都传过了', 'All {n} already uploaded'), { n: groups.length }));
    return;
  }

  uploading = true;
  cancelled = false;
  const failures = $('#failures');
  failures.replaceChildren();
  $('#progress').hidden = false;
  $('#cancel').hidden = false;
  let done = 0;
  let failed = 0;
  let next = 0;
  const t0 = performance.now();
  const grid = $('#grid');
  $('#empty').hidden = true;

  const progress = () => {
    const finished = done + failed;
    ($('#pbar') as HTMLElement).style.width = `${(finished / todo.length) * 100}%`;
    let text = fmt(t('{d} / {n} 张', '{d} / {n}'), { d: finished, n: todo.length });
    if (skipped) text += fmt(t('，跳过已传 {s} 张', ', {s} skipped'), { s: skipped });
    if (failed) text += fmt(t('，失败 {f}', ', {f} failed'), { f: failed });
    if (finished > 2 && finished < todo.length) {
      const left = ((performance.now() - t0) / finished) * (todo.length - finished);
      text += fmt(t(' · 约剩 {m} 分钟', ' · ~{m} min left'), { m: Math.max(1, Math.round(left / 60000)) });
    }
    $('#ptext').textContent = text;
  };
  progress();

  // 2~4 张同时处理：压缩吃 CPU，上传吃网络，并行起来两边都不闲着；再多内存会吃紧（一张 2400 万像素图解开约 100MB）
  const workers = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const work = async () => {
    while (!cancelled && next < todo.length) {
      const g = todo[next++];
      try {
        const photo = await uploadOne(g);
        done++;
        if (!photos.some((p) => p.id === photo.id)) {
          photos.push(photo);
          if (!photoFilter) {
            grid.append(cellFor(photo));
            gridItems.push(toItem(photo));
          }
          $('#n-photos').textContent = String(photos.length);
        }
      } catch (e) {
        failed++;
        failures.append(h('li', {}, `${g.source.path}：${errMsg(e)}`));
      }
      progress();
    }
  };
  await Promise.all(Array.from({ length: workers }, work));
  uploading = false;
  $('#cancel').hidden = true;
  const msg = cancelled
    ? fmt(t('已停止，传了 {d} 张。再选同一个文件夹可续传。', 'Stopped after {d}. Choose the same folder to resume.'), { d: done })
    : fmt(t('完成：传了 {d} 张', 'Done: {d} uploaded'), { d: done }) + (failed ? fmt(t('，{f} 张失败（见下方）', ', {f} failed (see below)'), { f: failed }) : '');
  $('#ptext').textContent = msg;
  toast(msg, failed ? 'error' : 'info');
  await refresh();
}

main();

// 模特选片页：/s/<共享码>
//
// 选中/取消是“先改界面、后台再存”（乐观更新）：点了立刻变红心，不用等网络。
// 请求按顺序排队发出，失败了再把界面改回来并提示。

import {
  $, Album, api, applyI18n, dialog, errMsg, fmt, h, Photo, Picker, previewUrl, sortPhotos, t, thumbUrl, toast,
} from './common';
import { Viewer, ViewerItem } from './viewer';

const code = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
const NAME_KEY = 'pp-picker-name';

let album: Album;
let photos: Photo[] = [];
let items: ViewerItem[] = [];
const byId = new Map<number, Photo>();
const cells = new Map<number, HTMLElement>();
let name = '';
/** 已选：photo_id → 备注 */
const picks = new Map<number, string>();
let submitted = false;
let filter: 'all' | 'picked' = 'all';
let queue: Promise<unknown> = Promise.resolve();

applyI18n();

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function saveName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* 隐私模式存不了也没关系 */
  }
}

async function main() {
  try {
    const data = await api<{ album: Album; photos: Photo[] }>('GET', `/share/${encodeURIComponent(code)}`);
    album = data.album;
    photos = sortPhotos(data.photos);
  } catch (e) {
    $('#loading').textContent = errMsg(e);
    $('#loading').append(h('p', {}, h('a', { href: '/' }, t('重新输入共享码', 'Enter another code'))));
    return;
  }
  document.title = album.name;
  items = photos.map((p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, thumb: thumbUrl(album.id, p), preview: previewUrl(album.id, p) }));
  photos.forEach((p) => byId.set(p.id, p));
  $('#loading').hidden = true;

  const saved = loadName();
  if (saved && (await join(saved))) return;
  showGate(saved);
}

function showGate(prefill: string) {
  const gate = $<HTMLFormElement>('#gate');
  gate.hidden = false;
  $('#app').hidden = true;
  $('#gate-album').textContent = album.name;
  $('#gate-info').textContent = album.pick_limit
    ? fmt(t('共 {n} 张，请选 {k} 张', '{n} photos, pick {k}'), { n: photos.length, k: album.pick_limit })
    : fmt(t('共 {n} 张', '{n} photos'), { n: photos.length });
  const input = $<HTMLInputElement>('#gate-name');
  input.value = prefill;
  input.focus();
  gate.onsubmit = async (e) => {
    e.preventDefault();
    if (await join(input.value)) gate.hidden = true;
  };
}

async function join(n: string): Promise<boolean> {
  try {
    const { picker } = await api<{ picker: Picker }>('POST', `/share/${encodeURIComponent(code)}/join`, { name: n });
    name = picker.name;
    saveName(name);
    picks.clear();
    picker.picks.forEach((p) => picks.set(p.photo_id, p.note));
    submitted = picker.submitted;
    showApp();
    return true;
  } catch (e) {
    toast(errMsg(e), 'error');
    return false;
  }
}

// ---------- 主界面 ----------

let viewer: Viewer;

function showApp() {
  $('#app').hidden = false;
  $('#gate').hidden = true;
  $('#album-name').textContent = album.name;
  $('#who').textContent = name;
  if (!cells.size) buildGrid();
  for (const id of cells.keys()) paintCell(id);
  applyFilter();
  updateBar();
  if (album.closed) {
    const b = $('#banner');
    b.textContent = t('摄影师已结束选片，现在只能看。', 'Picking is closed. View only.');
    b.hidden = false;
  }
  viewer ??= new Viewer({
    isPicked: (it) => picks.has(it.id),
    onTogglePick: (it) => toggle(it.id),
    noteOf: (it) => picks.get(it.id) ?? '',
    onEditNote: (it) => editNote(it.id),
    onClose: (it) => cells.get(it.id)?.scrollIntoView({ block: 'nearest' }),
  });
}

function buildGrid() {
  const grid = $('#grid');
  const frag = document.createDocumentFragment();
  photos.forEach((p, i) => {
    const img = h('img', { src: items[i].thumb, alt: p.name, loading: 'lazy', decoding: 'async', draggable: 'false' });
    const cell = h(
      'div',
      { class: 'cell', 'data-id': String(p.id) },
      img,
      h('button', { class: 'heart', 'aria-label': t('选这张', 'Pick') }, '♥'),
      h('span', { class: 'note-dot', title: t('有备注', 'Has note') }, '✎'),
    );
    cells.set(p.id, cell);
    frag.append(cell);
  });
  grid.append(frag);
  grid.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cell = target.closest<HTMLElement>('.cell');
    if (!cell) return;
    const id = Number(cell.dataset.id);
    if (target.closest('.heart')) {
      toggle(id);
      return;
    }
    const list = visibleItems();
    viewer.open(list, list.findIndex((it) => it.id === id));
    firstViewerHint();
  });

  $('#filter').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    filter = b.dataset.f as typeof filter;
    $('#filter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    applyFilter();
    window.scrollTo({ top: 0 });
  });
  $('#submit').addEventListener('click', submit);
  $('#who').addEventListener('click', async () => {
    const n = await dialog({ title: t('换个名字', 'Change name'), body: t('换名字后看到的是那个名字的选片。', "You'll see that name's picks."), input: { value: name } });
    if (n && n.trim() !== name) await join(n);
  });
}

function visibleItems(): ViewerItem[] {
  return filter === 'all' ? items : items.filter((it) => picks.has(it.id));
}

function paintCell(id: number) {
  const cell = cells.get(id);
  if (!cell) return;
  cell.classList.toggle('picked', picks.has(id));
  cell.classList.toggle('has-note', !!picks.get(id));
}

function applyFilter() {
  let shown = 0;
  for (const [id, cell] of cells) {
    const show = filter === 'all' || picks.has(id);
    cell.hidden = !show;
    if (show) shown++;
  }
  const empty = $('#empty');
  empty.hidden = shown > 0;
  empty.textContent = filter === 'picked' ? t('还没选。点照片右下角的 ♥ 或打开大图选。', 'Nothing picked yet. Tap ♥ on a photo.') : t('相册里还没有照片', 'No photos yet');
}

function updateBar() {
  const n = picks.size;
  const limit = album.pick_limit;
  $('#n-all').textContent = String(photos.length);
  const np = $('#n-picked');
  np.textContent = limit ? `${n}/${limit}` : String(n);
  np.classList.toggle('over', !!limit && n > limit);
  const sb = $<HTMLButtonElement>('#submit');
  sb.textContent = submitted ? t('已提交 ✓', 'Sent ✓') : t('选好了', 'Done');
  sb.classList.toggle('done', submitted);
  sb.disabled = album.closed;
}

function toggle(id: number) {
  setPick(id, !picks.has(id));
}

function setPick(id: number, picked: boolean, note?: string) {
  if (album.closed) {
    toast(t('选片已结束', 'Picking is closed'), 'error');
    return;
  }
  const had = picks.has(id);
  const oldNote = picks.get(id);
  const oldSubmitted = submitted;
  if (picked) picks.set(id, note ?? oldNote ?? '');
  else picks.delete(id);
  submitted = false;
  if (picked && !had && album.pick_limit && picks.size === album.pick_limit + 1) {
    toast(fmt(t('已超过 {k} 张，提交前请取消几张', 'Over {k}. Unpick some before sending.'), { k: album.pick_limit }));
  }
  paintCell(id);
  updateBar();
  viewer.refresh();
  if (filter === 'picked' && !viewer.isOpen) applyFilter();

  queue = queue
    .then(() => api('PUT', `/share/${encodeURIComponent(code)}/pick`, { name, photo_id: id, picked, note }))
    .catch((e) => {
      if (had) picks.set(id, oldNote ?? '');
      else picks.delete(id);
      submitted = oldSubmitted;
      paintCell(id);
      updateBar();
      viewer.refresh();
      toast(errMsg(e) + t('（没保存上）', ' (not saved)'), 'error');
    });
}

async function editNote(id: number) {
  const p = byId.get(id)!;
  const v = await dialog({
    title: fmt(t('给摄影师留言：{name}', 'Note for {name}'), { name: p.name }),
    body: picks.has(id) ? undefined : t('留言会同时选中这张。', 'Adding a note also picks this photo.'),
    input: { value: picks.get(id) ?? '', placeholder: t('比如：脸修瘦一点、去掉路人', 'e.g. remove the passer-by'), multiline: true },
    ok: t('保存', 'Save'),
  });
  if (v === null) return;
  setPick(id, true, v.trim());
}

async function submit() {
  if (submitted) {
    toast(t('已经提交了。还想改的话直接改，改完再点一次。', 'Already sent. Change picks and tap again.'));
    return;
  }
  const n = picks.size;
  const limit = album.pick_limit;
  if (!n) {
    toast(t('还没选照片', 'Nothing picked yet'), 'error');
    return;
  }
  if (limit && n > limit) {
    toast(fmt(t('最多选 {k} 张，现在 {n} 张', 'Max {k}, you have {n}'), { k: limit, n }), 'error');
    return;
  }
  const ok = await dialog({
    title: fmt(t('选好了？共 {n} 张', 'Send {n} picks?'), { n }),
    body: limit && n < limit ? fmt(t('还可以再选 {m} 张。', 'You can pick {m} more.'), { m: limit - n }) : t('摄影师会看到你的选择。提交后还能改。', 'The photographer will see them. You can still change later.'),
    ok: t('提交', 'Send'),
  });
  if (ok === null) return;
  try {
    await queue;
    await api('POST', `/share/${encodeURIComponent(code)}/submit`, { name, submitted: true });
    submitted = true;
    updateBar();
    toast(t('已提交，谢谢！', 'Sent. Thanks!'));
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function firstViewerHint() {
  try {
    if (localStorage.getItem('pp-hint')) return;
    localStorage.setItem('pp-hint', '1');
  } catch {
    return;
  }
  const touch = matchMedia('(pointer: coarse)').matches;
  toast(touch ? t('左右滑翻页，双击放大', 'Swipe to flip, double-tap to zoom') : t('滚轮或 ←→ 翻页，空格选中', 'Scroll or ←→ to flip, Space to pick'));
}

main();

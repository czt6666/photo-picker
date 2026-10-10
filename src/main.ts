// 入口：把侧栏、网格、看图器、导出对话框接到一起，处理全局快捷键。

import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api } from './api';
import { closeExportDialog, isExportOpen, openExportDialog } from './exportDialog';
import { Grid } from './grid';
import { baseName, Sidebar } from './sidebar';
import { prefs, store, type View } from './store';
import type { Library, Photo, Progress } from './types';
import { closeMenu, contextMenu, esc, toast } from './ui';
import { formatBytes, Viewer } from './viewer';
import { isBrowserShortcut, mod as modKey, MOD_NAME, REVEAL_LABEL } from './platform';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const gridEl = $('grid');
const emptyEl = $('empty');
const titleEl = $('view-title');
const countEl = $('status-count');
const thumbsEl = $('status-thumbs');
const starBtn = $<HTMLButtonElement>('btn-star');
const zoom = $<HTMLInputElement>('zoom');
const chkStarred = $<HTMLInputElement>('chk-starred');
const search = $<HTMLInputElement>('search');

const grid = new Grid(gridEl, $('grid-inner'), {
  open: (i) => openViewer(i),
  toggleStar: (photos) => void toggleStar(photos),
  selectionChanged: () => updateStatus(),
});

const viewer = new Viewer($('viewer'), {
  toggleStar,
  close(lastPath) {
    // 看图时可能改了星标：按过滤条件刷新，并把网格光标放到刚才看的那张上
    store.refilter();
    grid.reset(true);
    const i = store.indexOf(lastPath);
    if (i >= 0) {
      grid.selectIndex(i, 'single');
      grid.scrollToIndex(i, true);
    }
    updateStatus();
    gridEl.focus({ preventScroll: true });
  },
});

const sidebar = new Sidebar($('sidebar'), {
  openFolder: (path) => void openFolder(path),
  openStarred: () => void openStarred(),
  folderMenu(path, x, y) {
    contextMenu(x, y, [
      { label: REVEAL_LABEL, action: () => void revealItemInDir(path).catch(() => {}) },
      { label: '重新扫描工作目录', action: () => void rescan() },
    ]);
  },
  workdirMenu: (x, y) => void showWorkdirMenu(x, y),
});

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

function setLibrary(lib: Library): void {
  store.setLibrary(lib);
  sidebar.render();
  const wd = lib.workdir;
  workdirBtn.textContent = wd ? `📁 ${baseName(wd)} ▾` : '📁 选择工作目录…';
  workdirBtn.title = wd ? `工作目录：${wd}\n点击切换（${modKey('O')}）` : `选择一个文件夹作为工作目录，扫描它下面的所有相册（${modKey('O')}）`;
}

let viewSeq = 0;

async function showView(view: View, load: () => Promise<Photo[]>): Promise<boolean> {
  const seq = ++viewSeq;
  let photos: Photo[];
  try {
    await store.starsSettled(); // 刚打的星还在排队写盘时，等它写完再读列表
    photos = await load();
  } catch (e) {
    if (seq !== viewSeq) return true; // 用户已经去了别处，这次失败无所谓
    toast(`读取失败：${e}`, 'error');
    return false;
  }
  if (seq !== viewSeq) return true; // 用户已经点了别的文件夹
  store.setPhotos(view, photos);
  if (store.library.workdir) prefs.set(`lastView:${store.library.workdir}`, view);
  sidebar.render();
  grid.reset();
  renderChrome();
  // 后台把整个文件夹的缩略图生成好，往下滚时就不用等
  void api.prefetchThumbs(photos.map((p) => p.path)).catch(() => {});
  return true;
}

const openFolder = (path: string) => showView({ kind: 'folder', path }, () => api.listFolder(path));
const openStarred = () => showView({ kind: 'starred' }, () => api.listStarred());

function showEmptyView(): void {
  ++viewSeq; // 让还在路上的旧相册加载结果作废
  store.setPhotos({ kind: 'none' }, []);
  sidebar.render();
  grid.reset();
  renderChrome();
}

function openViewer(i: number): void {
  if (!store.visible.length) return;
  viewer.open(store.visible, Math.max(0, Math.min(i, store.visible.length - 1)));
}

function renderChrome(): void {
  const v = store.view;
  if (v.kind === 'folder') {
    const f = store.folder(v.path);
    titleEl.innerHTML = `<b>${esc(f?.name ?? v.path.split(/[\\/]/).pop() ?? '')}</b> <span class="dim">${esc(v.path)}</span>`;
  } else if (v.kind === 'starred') {
    titleEl.innerHTML = '<b><span class="star">★</span> 已加星标的照片</b> <span class="dim">工作目录中的所有相册</span>';
  } else {
    titleEl.textContent = '';
  }
  chkStarred.disabled = v.kind === 'starred';
  renderEmpty();
  updateStatus();
}

function renderEmpty(): void {
  let html = '';
  if (!store.library.workdir) {
    html = `<div class="empty-card">
      <div class="big">📁</div>
      <h2>先选择一个工作目录</h2>
      <p class="dim">比如“图片”或某次拍摄的文件夹。它下面所有含照片的子文件夹都会作为相册列在左侧。<br>也可以直接把文件夹拖进这个窗口。</p>
      <button class="btn primary" id="empty-add">选择工作目录…</button></div>`;
  } else if (!store.library.folders.length) {
    html = `<div class="empty-card"><h2>这个工作目录下没有找到照片</h2>
      <p class="dim">${esc(store.library.workdir)}</p>
      <button class="btn primary" id="empty-add">换一个工作目录…</button></div>`;
  } else if (store.view.kind === 'none') {
    html = '<div class="empty-card"><p class="dim">从左侧选择一个相册</p></div>';
  } else if (!store.visible.length) {
    if (store.view.kind === 'starred') html = '<div class="empty-card"><h2>还没有星标照片</h2><p class="dim">看照片时按 <kbd>空格</kbd> 加星标，工作目录里所有星标照片都会汇总到这里。</p></div>';
    else if (store.query) html = `<div class="empty-card"><p class="dim">没有文件名包含“${esc(store.query)}”的照片</p></div>`;
    else if (store.starredOnly) html = '<div class="empty-card"><h2>这个相册里还没有星标照片</h2><p class="dim">取消“仅显示星标”，选中照片后按 <kbd>空格</kbd> 加星标。</p></div>';
    else html = '<div class="empty-card"><p class="dim">这个文件夹里没有照片</p></div>';
  }
  emptyEl.innerHTML = html;
  emptyEl.hidden = !html;
  gridEl.hidden = !!html;
  emptyEl.querySelector('#empty-add')?.addEventListener('click', () => void chooseWorkdir());
}

function updateStatus(): void {
  const total = store.visible.length;
  const starred = store.visible.filter((p) => p.starred).length;
  const sel = store.selection.size;
  let s = store.view.kind === 'none' ? '' : `${total} 张照片`;
  if (starred && store.view.kind !== 'starred') s += `  ·  ★ ${starred}`;
  if (sel) {
    const bytes = store.selectedPhotos().reduce((n, p) => n + p.size, 0);
    s += `  ·  已选 ${sel} 张（${formatBytes(bytes)}）`;
  }
  countEl.textContent = s;
  const targets = starTargets();
  starBtn.disabled = !targets.length;
  const allStarred = targets.length > 0 && targets.every((p) => p.starred);
  starBtn.textContent = allStarred ? '★ 取消星标' : '☆ 加星标';
  starBtn.classList.toggle('on', allStarred);
}

// ---------------------------------------------------------------------------
// 星标
// ---------------------------------------------------------------------------

function starTargets(): Photo[] {
  const sel = store.selectedPhotos();
  if (sel.length) return sel;
  const i = store.indexOf(store.focus);
  return i >= 0 ? [store.visible[i]] : [];
}

/** 像 Picasa 一样：选中的照片里只要有没加星的，就全部加星；否则全部取消。 */
async function toggleStar(photos: Photo[]): Promise<void> {
  if (!photos.length) return;
  const target = photos.some((p) => !p.starred);
  const changed = photos.filter((p) => p.starred !== target);
  // 先改界面（乐观更新），写盘失败再改回来：按下 S 的瞬间就要看到星星
  changed.forEach((p) => (p.starred = target));
  grid.refreshCells();
  viewer.refreshStar();
  updateStatus();
  const paths = changed.map((p) => p.path);
  const job = store.queueStarWrite(() => api.setStar(paths, target));
  try {
    const r = await job;
    for (const [dir, n] of Object.entries(r.folders)) {
      const f = store.folder(dir);
      if (f) f.starred = n;
    }
    sidebar.render();
    if (r.fallback) toast('照片所在文件夹不可写，星标已保存在本机的 App 数据里', 'warn', 4000);
    // “仅显示星标”或星标相册里取消星标：照片应当消失（看图器里先不动，回网格时再刷新）
    if (!target && !viewer.opened && (store.starredOnly || store.view.kind === 'starred')) {
      store.refilter();
      grid.reset(true);
      renderEmpty();
      updateStatus();
    }
  } catch (e) {
    // 只回滚“还停留在这次设置的状态”的照片（之后又被改过的以后来的为准）
    changed.forEach((p) => {
      if (p.starred === target) p.starred = !target;
    });
    grid.refreshCells();
    viewer.refreshStar();
    updateStatus();
    toast(`星标保存失败：${e}`, 'error', 4000);
  }
}

// ---------------------------------------------------------------------------
// 图库管理
// ---------------------------------------------------------------------------

/** 弹出系统的选择文件夹对话框，选好后切换工作目录 */
async function chooseWorkdir(): Promise<void> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: '选择工作目录（会扫描它下面的所有相册）',
    defaultPath: store.library.workdir ?? undefined,
  });
  if (typeof picked === 'string') await switchWorkdir(picked);
}

let switchSeq = 0;
/** 最新一次切换（switchSeq）已经以失败告终时等于它：这时更早发出、后来才成功的切换就是后台的最终状态，应当采用 */
let failedSeq = 0;
/** 每次界面切到某个工作目录 +1，用来识别“等待期间界面已被别的结果改过” */
let applyEpoch = 0;

/** 切换工作目录：扫描它下面所有含照片的子文件夹（相册），打开上次看的或第一个相册。
 *  扫描期间旧目录照常可用（后端扫完才切换）；期间又选了别的目录，以最后一次为准。 */
async function switchWorkdir(path: string): Promise<void> {
  const dialog = $('export-dialog');
  if (isExportOpen() && !dialog.querySelector('.help')) {
    toast('请先关闭导出对话框', 'warn');
    return;
  }
  if (dialog.querySelector('.help')) {
    dialog.hidden = true;
    dialog.innerHTML = '';
  }
  const seq = ++switchSeq;
  toast(`正在扫描 ${baseName(path)} …`);
  thumbsEl.textContent = `正在扫描 ${baseName(path)} …`;
  let lib: Library;
  try {
    lib = await api.setWorkdir(path);
  } catch (e) {
    if (String(e).includes('superseded')) return; // 被后来的有效切换取代了，由它收尾
    if (seq !== switchSeq) return; // 有更新的切换在途，由它收尾
    failedSeq = seq;
    thumbsEl.textContent = '';
    const missing = String(e).includes('不存在');
    toast(missing ? `找不到 ${path}（移动硬盘没连接？）。可在工作目录菜单里把它从“最近”中移除。` : `无法打开：${e}`, 'error', 5000);
    // 这次失败了，但更早发出的一次有效切换可能已经在后台生效：以后台为准对齐界面
    await syncWithBackend(seq);
    return;
  }
  // 本次结果过时：更新的切换还在途就交给它；更新的切换都失败了，那后台的最终状态就是本次
  if (seq !== switchSeq && failedSeq !== switchSeq) return;
  applyWorkdir(lib);
  await openInitialView(lib);
  if (lib.folders.length) {
    const n = lib.folders.reduce((s, f) => s + f.count, 0);
    toast(`找到 ${lib.folders.length} 个相册，共 ${n} 张照片`);
  }
}

/** 后台当前的工作目录和界面显示的不一致时（切换请求交错、失败），把界面对齐到后台。
 *  只有最新一次切换才对齐，而且等待期间界面若已被别的结果更新过就放弃（那份快照已过时）。 */
async function syncWithBackend(seq: number): Promise<void> {
  if (seq !== switchSeq) return;
  const epoch = applyEpoch;
  const lib = await api.getLibrary().catch(() => null);
  if (!lib || seq !== switchSeq || epoch !== applyEpoch) return;
  if (lib.workdir !== store.library.workdir) {
    applyWorkdir(lib);
    await openInitialView(lib);
  } else {
    setLibrary(lib); // 至少刷新“未连接”状态
  }
}

/** 界面切到一个新的工作目录：关掉还停留在旧目录照片上的看图器和（没在导出的）导出对话框 */
function applyWorkdir(lib: Library): void {
  applyEpoch++;
  thumbsEl.textContent = '';
  if (viewer.opened) viewer.close();
  if (isExportOpen()) closeExportDialog(); // 正在导出时它不会关，导出用的是开始时的照片列表，不受影响
  setLibrary(lib);
}

/** 打开该工作目录上次看的相册；打不开（被删、改名、磁盘没插）就退到第一个相册，再不行显示空状态 */
async function openInitialView(lib: Library): Promise<void> {
  const last = lib.workdir ? prefs.get<View>(`lastView:${lib.workdir}`, { kind: 'none' }) : { kind: 'none' as const };
  if (last.kind === 'starred' && (await openStarred())) return;
  if (last.kind === 'folder' && lib.folders.some((f) => f.path === last.path) && (await openFolder(last.path))) return;
  for (const f of lib.folders.slice(0, 3)) {
    if (f.path !== (last.kind === 'folder' ? last.path : '') && (await openFolder(f.path))) return;
  }
  showEmptyView();
}

/** 太长的路径只保留后半段：…/2024/旅行 */
function shortPath(p: string, max = 46): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

async function showWorkdirMenu(x: number, y: number): Promise<void> {
  // 打开菜单时现查一次：哪些目录现在连不上了（中途拔掉的移动硬盘）、哪些又接上了
  const fresh = await api.getLibrary().catch(() => null);
  if (fresh && fresh.workdir === store.library.workdir) setLibrary(fresh);
  const { workdir, recent, missing } = store.library;
  const others = recent.filter((r) => r !== workdir);
  const gone = new Set(missing);
  const forgetMissing = async () => {
    let lib: Library | null = null;
    for (const m of missing.filter((m) => m !== workdir)) lib = await api.forgetWorkdir(m).catch(() => lib);
    if (lib) setLibrary(lib);
  };
  contextMenu(x, y, [
    { label: '选择工作目录…', detail: modKey('O'), action: () => void chooseWorkdir() },
    ...(workdir
      ? [
          { label: '重新扫描', action: () => void rescan() },
          { label: REVEAL_LABEL, action: () => void revealItemInDir(workdir).catch(() => {}) },
        ]
      : []),
    ...(others.length ? [{ separator: true, label: '最近的工作目录', action: () => {} }] : []),
    ...others.map((r) => ({
      label: gone.has(r) ? `${baseName(r)}（未连接）` : baseName(r),
      detail: shortPath(r),
      disabled: gone.has(r),
      action: () => void switchWorkdir(r),
    })),
    ...(others.some((r) => gone.has(r)) ? [{ label: '从列表中移除未连接的目录', action: () => void forgetMissing() }] : []),
  ]);
}

async function rescan(): Promise<void> {
  toast('正在重新扫描工作目录…');
  setLibrary(await api.rescan());
  const v = store.view;
  if (v.kind === 'folder' && store.folder(v.path)) await openFolder(v.path);
  else if (v.kind === 'starred') await openStarred();
  else await openInitialView(store.library);
}

// ---------------------------------------------------------------------------
// 工具栏 / 状态栏
// ---------------------------------------------------------------------------

const workdirBtn = $<HTMLButtonElement>('btn-workdir');
workdirBtn.addEventListener('click', () => {
  const r = workdirBtn.getBoundingClientRect();
  void showWorkdirMenu(r.left, r.bottom + 4);
});
$('btn-rescan').addEventListener('click', () => void rescan());
$('btn-export').addEventListener('click', () => openExportDialog());
starBtn.addEventListener('click', () => void toggleStar(starTargets()));

function setStarredOnly(on: boolean): void {
  store.starredOnly = on;
  chkStarred.checked = on;
  prefs.set('starredOnly', on);
  store.refilter();
  grid.reset();
  renderEmpty();
  updateStatus();
}
chkStarred.addEventListener('change', () => setStarredOnly(chkStarred.checked));

let searchTimer = 0;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    store.query = search.value;
    store.refilter();
    grid.reset();
    renderEmpty();
    updateStatus();
  }, 120);
});

zoom.value = String(prefs.get('thumbSize', 160));
grid.setCellSize(Number(zoom.value));
zoom.addEventListener('input', () => {
  grid.setCellSize(Number(zoom.value));
  prefs.set('thumbSize', Number(zoom.value));
});

// 触控板捏合（webview 里是带 ctrlKey 的滚轮事件）或 ⌘/Ctrl+滚轮：调整缩略图大小
let pinchAcc = 0;
gridEl.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    pinchAcc -= e.deltaY;
    const steps = Math.trunc(pinchAcc / 8);
    if (!steps) return;
    pinchAcc -= steps * 8;
    const v = Math.max(Number(zoom.min), Math.min(Number(zoom.max), Number(zoom.value) + steps * Number(zoom.step)));
    if (String(v) === zoom.value) return;
    zoom.value = String(v);
    zoom.dispatchEvent(new Event('input'));
  },
  { passive: false },
);

const HELP = [
  ['图库', ''],
  ['方向键 / Shift+方向键', '移动 / 连选'],
  [`${MOD_NAME} 点击、Shift 点击`, '多选 / 范围选择'],
  [modKey('A'), '全选'],
  ['回车、双击', '看大图'],
  [`空格（或 S、${modKey('8')}）`, '加 / 取消星标（多选时：有未加星的就全部加星）'],
  ['Shift+S', '仅显示星标 开 / 关'],
  [modKey('E'), '导出'],
  [modKey('F'), '搜索文件名'],
  [modKey('O'), '选择 / 切换工作目录'],
  [`捏合 / ${MOD_NAME}+滚轮`, '缩略图大小'],
  ['看大图', ''],
  ['滚轮、← →', '上一张 / 下一张'],
  [`空格（或 S、${modKey('8')}）`, '加 / 取消星标'],
  ['1、Z、双击', '适合窗口 ↔ 1:1 实际像素'],
  [`捏合 / ${MOD_NAME}+滚轮`, '缩放；放大后拖动或滚动可平移'],
  ['F', '全屏'],
  ['Esc', '返回图库'],
];

function showHelp(): void {
  const el = $('export-dialog');
  el.innerHTML = `<div class="modal-card help"><h2>快捷键</h2><table>${HELP.map(([k, v]) =>
    v ? `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>` : `<tr><th colspan="2">${esc(k)}</th></tr>`,
  ).join('')}</table><div class="actions"><button class="btn primary">知道了</button></div></div>`;
  el.hidden = false;
  const close = () => {
    el.hidden = true;
    el.innerHTML = '';
  };
  el.querySelector('button')!.addEventListener('click', close);
  el.onclick = (e) => e.target === el && close();
}
$('btn-help').addEventListener('click', showHelp);

gridEl.addEventListener('contextmenu', (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
  if (!cell) return;
  e.preventDefault();
  const i = Number(cell.dataset.i);
  const p = store.visible[i];
  if (!store.selection.has(p.path)) grid.selectIndex(i, 'single');
  const targets = starTargets();
  const allStarred = targets.every((t) => t.starred);
  contextMenu(e.clientX, e.clientY, [
    { label: '查看大图', action: () => openViewer(i) },
    { label: allStarred ? '取消星标' : '加星标', action: () => void toggleStar(targets) },
    { label: REVEAL_LABEL, action: () => void revealItemInDir(p.path).catch(() => {}) },
    { label: '导出…', action: () => openExportDialog() },
  ]);
});

// 屏蔽 webview 自带的右键菜单（“重新载入”等），输入框除外
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

// 启动时先显示上次的图库缓存，后台扫描完成后在这里更新（新增/删除的文件夹、照片数）
void listen<Library>('library-updated', (e) => {
  setLibrary(e.payload);
  const v = store.view;
  if ((v.kind === 'folder' && !store.folder(v.path)) || (v.kind === 'none' && e.payload.folders.length)) {
    if (!viewer.opened) void openInitialView(e.payload);
  } else {
    renderChrome();
  }
});

void listen<Progress>('thumb-progress', (e) => {
  const { done, total } = e.payload;
  thumbsEl.textContent = total && done < total ? `正在生成缩略图 ${done} / ${total}` : '';
});

// 把文件夹拖进窗口 = 添加到图库
void getCurrentWebview()
  .onDragDropEvent((e) => {
    document.body.classList.toggle('drop-target', e.payload.type === 'over' || e.payload.type === 'enter');
    // 拖进来一个文件夹（或其中的照片）= 把它设为工作目录
    if (e.payload.type === 'drop' && e.payload.paths.length) void switchWorkdir(e.payload.paths[0]);
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  // 先拦下 WebView2 自带的浏览器快捷键（刷新、打印…），否则一按 F5 整个界面就重载了
  if (isBrowserShortcut(e)) e.preventDefault();
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  // 菜单开着时按任何键都先关掉它（菜单里的“加星标/取消星标”文字是打开时算好的，按键改了状态就过时了）
  closeMenu();
  if (isExportOpen()) {
    if (k === 'Escape') {
      closeExportDialog();
      if (!$('export-dialog').querySelector('.help')) return;
      $('export-dialog').hidden = true;
      $('export-dialog').innerHTML = '';
    }
    return;
  }
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (k === 'Escape' || k === 'Enter') (e.target as HTMLElement).blur();
    return;
  }
  // 按住空格/S 不放时系统会自动连发按键：星标只认第一下，否则会一闪一闪地反复切换
  const isStarKey = k === ' ' || k === 's' || k === 'S' || (mod && k === '8');
  if (isStarKey && e.repeat) {
    e.preventDefault();
    return;
  }
  if (viewer.opened) {
    if (viewer.onKey(e)) e.preventDefault();
    return;
  }
  let handled = true;
  if (mod && k.toLowerCase() === 'a') grid.selectAll();
  else if (mod && k === '8') void toggleStar(starTargets());
  else if (mod && k.toLowerCase() === 'e') openExportDialog();
  else if (mod && k.toLowerCase() === 'f') search.focus();
  else if (mod && k.toLowerCase() === 'o') void chooseWorkdir();
  else if (mod) handled = false;
  else if (k === 'ArrowRight') grid.moveFocus(1, 0, e.shiftKey);
  else if (k === 'ArrowLeft') grid.moveFocus(-1, 0, e.shiftKey);
  else if (k === 'ArrowDown') grid.moveFocus(0, 1, e.shiftKey);
  else if (k === 'ArrowUp') grid.moveFocus(0, -1, e.shiftKey);
  else if (k === 'Home') grid.jumpTo('start', e.shiftKey);
  else if (k === 'End') grid.jumpTo('end', e.shiftKey);
  else if (k === 'Enter') openViewer(Math.max(0, store.indexOf(store.focus)));
  else if (k === ' ' || k === 's') void toggleStar(starTargets());
  else if (k === 'S' && e.shiftKey) setStarredOnly(!store.starredOnly);
  else if (k === '?') showHelp();
  else if (k === 'Escape') {
    store.selection.clear();
    grid.refreshCells();
    updateStatus();
  } else handled = false;
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  store.starredOnly = prefs.get('starredOnly', false);
  chkStarred.checked = store.starredOnly;
  titleEl.innerHTML = '<span class="dim">正在扫描工作目录…</span>';
  let lib: Library;
  try {
    lib = await api.getLibrary();
  } catch (e) {
    toast(`读取工作目录失败：${e}`, 'error', 6000);
    return;
  }
  setLibrary(lib);
  await openInitialView(lib);
  gridEl.focus({ preventScroll: true });
}

void boot();

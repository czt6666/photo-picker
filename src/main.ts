// 入口：把侧栏、网格、看图器、导出对话框接到一起，处理全局快捷键。

import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api } from './api';
import { closeExportDialog, isExportOpen, openExportDialog } from './exportDialog';
import { Grid } from './grid';
import { applyStatic, langPref, setLangPref, t, type LangPref } from './i18n';
import { baseName, makeSidebarResizable, Sidebar } from './sidebar';
import { planRate, planToggle } from './rating';
import { isStarMode, prefs, store, type View } from './store';
import type { Library, Photo, Progress } from './types';
import { closeMenu, contextMenu, esc, toast } from './ui';
import { formatBytes, Viewer } from './viewer';
import { isBrowserShortcut, isMac, mod as modKey, MOD_NAME, REVEAL_LABEL } from './platform';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

applyStatic();
document.querySelector<HTMLElement>('.content')!.dataset.drop = t('drop.hint');
$('btn-export').title = t('export.btnTitle', { key: modKey('E') });

const gridEl = $('grid');
const emptyEl = $('empty');
const titleEl = $('view-title');
const countEl = $('status-count');
const thumbsEl = $('status-thumbs');
const starBtn = $<HTMLButtonElement>('btn-star');
const zoom = $<HTMLInputElement>('zoom');
const search = $<HTMLInputElement>('search');

const grid = new Grid(gridEl, $('grid-inner'), {
  open: (i) => openViewer(i),
  toggleStar: (photos) => void toggleStar(photos),
  selectionChanged: () => updateStatus(),
  sectionName: (dir) => store.folder(dir)?.name ?? baseName(dir),
  sectionChanged: (dir) => onSectionAtTop(dir),
  nearEnd: () => void loadNextAlbum(),
});

const viewer = new Viewer($('viewer'), {
  toggleStar,
  rate,
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

makeSidebarResizable($('sb-resizer'));

const sidebar = new Sidebar($('sidebar'), {
  // 星标筛选开着时点相册：筛选保持，只看这个相册里的星标照片
  openFolder: (path) => void openFolder(path, isStarMode(store.view)),
  toggleStarred: () => toggleStarredView(),
  folderMenu(path, x, y) {
    contextMenu(x, y, [
      { label: REVEAL_LABEL, action: () => void revealItemInDir(path).catch(() => {}) },
      { label: t('rescan.title'), action: () => void rescan() },
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
  workdirBtn.textContent = wd ? `📁 ${baseName(wd)} ▾` : `📁 ${t('wd.choose')}`;
  workdirBtn.title = wd ? t('wd.btnTitle', { path: wd, key: modKey('O') }) : t('wd.btnTitleNone', { key: modKey('O') });
}

let viewSeq = 0;
/** 最近打开的相册：关掉星标筛选时回到这里 */
let lastFolder: string | null = null;

async function showView(view: View, load: () => Promise<Photo[]>): Promise<boolean> {
  const seq = ++viewSeq;
  let photos: Photo[];
  try {
    await store.starsSettled(); // 刚打的星还在排队写盘时，等它写完再读列表
    photos = await load();
  } catch (e) {
    if (seq !== viewSeq) return true; // 用户已经去了别处，这次失败无所谓
    toast(t('err.read', { e: String(e) }), 'error');
    return false;
  }
  if (seq !== viewSeq) return true; // 用户已经点了别的文件夹
  chain = view.kind === 'folder' ? [view.path] : [];
  chainEnded = false;
  lastChunk = photos;
  store.setPhotos(view, photos);
  if (view.kind === 'folder') lastFolder = view.path;
  if (store.library.workdir) prefs.set(`lastView:${store.library.workdir}`, view);
  sidebar.render();
  grid.reset();
  renderChrome();
  // 后台把整个文件夹的缩略图生成好，往下滚时就不用等
  void api.prefetchThumbs(photos.map((p) => p.path)).catch(() => {});
  return true;
}

const openFolder = (path: string, starredOnly = false) =>
  showView(starredOnly ? { kind: 'folder', path, starredOnly } : { kind: 'folder', path }, () => api.listFolder(path));
const openStarred = () => showView({ kind: 'starred' }, () => api.listStarred());

function showEmptyView(): void {
  ++viewSeq; // 让还在路上的旧相册加载结果作废
  chain = [];
  store.setPhotos({ kind: 'none' }, []);
  sidebar.render();
  grid.reset();
  renderChrome();
}

// ---------------------------------------------------------------------------
// 连续翻动：往下滚到当前相册的末尾，下一个相册接着出现（中间一条分界线），不用回侧栏去点。
// 顺序就是侧栏里的顺序；星标筛选开着时只接有星标的相册。
// ---------------------------------------------------------------------------

/** 已经显示在网格里的相册，按顺序：第一个是点开的那个，后面是滚动时接上来的 */
let chain: string[] = [];
let chainBusy = false;
/** 接下一个相册失败了：这个视图里不再重试，免得一直转 */
let chainEnded = false;
/** 最近接上来的那批照片：预生成缩略图时连它一起发（后端每次调用会替换掉上一批排队） */
let lastChunk: Photo[] = [];

function nextAlbumPath(): string | null {
  const v = store.view;
  // 搜索时只在已经显示的相册里找，不往后接（否则没有结果时会把整个工作目录读一遍）
  if (v.kind !== 'folder' || store.query.trim() || !chain.length) return null;
  const list = v.starredOnly ? store.library.folders.filter((f) => f.starred > 0 || chain.includes(f.path)) : store.library.folders;
  const i = list.findIndex((f) => f.path === chain[chain.length - 1]);
  return i >= 0 ? (list[i + 1]?.path ?? null) : null;
}

async function loadNextAlbum(): Promise<void> {
  if (chainBusy || chainEnded) return;
  const path = nextAlbumPath();
  if (!path) return;
  const seq = viewSeq;
  chainBusy = true;
  try {
    await store.starsSettled();
    const photos = await api.listFolder(path);
    if (seq !== viewSeq) return; // 期间换了视图
    chain.push(path);
    store.appendPhotos(photos);
    grid.extend();
    updateStatus();
    void api.prefetchThumbs([...lastChunk, ...photos].map((p) => p.path)).catch(() => {});
    lastChunk = photos;
  } catch {
    if (seq === viewSeq) chainEnded = true;
  } finally {
    chainBusy = false;
    grid.poke(); // 接上来的相册太短、还没填满视口，或者期间换了视图：再检查一次
  }
}

/** 滚动后视口最上面换了相册：侧栏高亮、顶栏标题、状态栏都跟着换 */
function onSectionAtTop(dir: string): void {
  const v = store.view;
  if (v.kind !== 'folder' || v.path === dir || !chain.includes(dir)) return;
  store.view = { ...v, path: dir };
  lastFolder = dir;
  if (store.library.workdir) prefs.set(`lastView:${store.library.workdir}`, store.view);
  sidebar.render();
  renderTitle();
  updateStatus();
}

function openViewer(i: number): void {
  if (!store.visible.length) return;
  viewer.open(store.visible, Math.max(0, Math.min(i, store.visible.length - 1)));
}

function renderChrome(): void {
  renderTitle();
  renderEmpty();
  updateStatus();
}

function renderTitle(): void {
  const v = store.view;
  if (v.kind === 'folder') {
    const f = store.folder(v.path);
    const tag = v.starredOnly ? ` <span class="star">★</span> <span class="dim">${t('title.starOnly')} ·</span>` : '';
    titleEl.innerHTML = `<b>${esc(f?.name ?? v.path.split(/[\\/]/).pop() ?? '')}</b>${tag} <span class="dim">${esc(v.path)}</span>`;
  } else if (v.kind === 'starred') {
    titleEl.innerHTML = `<b><span class="star">★</span> ${t('title.starred')}</b> <span class="dim">${t('title.starredSub')}</span>`;
  } else {
    titleEl.textContent = '';
  }
}

function renderEmpty(): void {
  let html = '';
  if (!store.library.workdir) {
    html = `<div class="empty-card">
      <div class="big">📁</div>
      <h2>${t('empty.noWd.h')}</h2>
      <p class="dim">${t('empty.noWd.p')}</p>
      <button class="btn primary" id="empty-add">${t('wd.choose')}</button></div>`;
  } else if (!store.library.folders.length) {
    html = `<div class="empty-card"><h2>${t('empty.noPhotos.h')}</h2>
      <p class="dim">${esc(store.library.workdir)}</p>
      <button class="btn primary" id="empty-add">${t('empty.noPhotos.btn')}</button></div>`;
  } else if (store.view.kind === 'none') {
    html = `<div class="empty-card"><p class="dim">${t('empty.pick')}</p></div>`;
  } else if (!store.visible.length) {
    if (store.view.kind === 'starred') html = `<div class="empty-card"><h2>${t('empty.noStar.h')}</h2><p class="dim">${t('empty.noStar.p')}</p></div>`;
    else if (store.view.kind === 'folder' && store.view.starredOnly && !store.query)
      html = `<div class="empty-card"><p class="dim">${t('empty.albumNoStar')}</p><p class="dim">${t('empty.albumNoStar.p')}</p></div>`;
    else if (store.query) html = `<div class="empty-card"><p class="dim">${t('empty.noMatch', { q: esc(store.query) })}</p></div>`;
    else html = `<div class="empty-card"><p class="dim">${t('empty.folder')}</p></div>`;
  }
  emptyEl.innerHTML = html;
  emptyEl.hidden = !html;
  gridEl.hidden = !!html;
  emptyEl.querySelector('#empty-add')?.addEventListener('click', () => void chooseWorkdir());
}

function updateStatus(): void {
  // 连续翻动时列表里接着好几个相册，张数只报正在看的那个
  const v = store.view;
  const sec = v.kind === 'folder' ? store.sections.find((s) => s.dir === v.path) : undefined;
  const shown = sec ? store.visible.slice(sec.start, sec.start + sec.count) : store.visible;
  const total = shown.length;
  const starred = shown.filter((p) => p.starred).length;
  const sel = store.selection.size;
  let s = store.view.kind === 'none' ? '' : t('status.count', { n: total });
  if (starred && !isStarMode(store.view)) s += `  ·  ★ ${starred}`;
  if (sel) {
    const bytes = store.selectedPhotos().reduce((n, p) => n + p.size, 0);
    s += `  ·  ${t('status.selected', { n: sel, size: formatBytes(bytes) })}`;
  }
  countEl.textContent = s;
  const targets = starTargets();
  starBtn.disabled = !targets.length;
  const allStarred = targets.length > 0 && targets.every((p) => p.starred);
  starBtn.textContent = t(allStarred ? 'star.remove' : 'star.add');
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

/** 像 Picasa 一样：选中的照片里只要有没加星的，就全部加星；否则全部取消。（相当于 Lightroom 的“选取”，不动星级） */
async function toggleStar(photos: Photo[]): Promise<void> {
  const { starred: target, changed } = planToggle(photos);
  if (!changed.length) return;
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
    if (r.fallback) toast(t('star.fallback'), 'warn', 4000);
    // 星标筛选下取消星标：照片应当消失（看图器里先不动，回网格时再刷新）
    if (!target && !viewer.opened && isStarMode(store.view)) {
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
    toast(t('star.fail', { e: String(e) }), 'error', 4000);
  }
}

/** 星级（Lightroom 的星级）：数字键 1～5 标成几星，已经全是这个星级时再按一次 = 清除；0 = 清除。不动星标。 */
async function rate(photos: Photo[], n: number): Promise<void> {
  const { rating, changed } = planRate(photos, n);
  if (!changed.length) return;
  const before = new Map(changed.map((p) => [p, p.rating]));
  changed.forEach((p) => (p.rating = rating));
  grid.refreshCells();
  viewer.refreshStar();
  const paths = changed.map((p) => p.path);
  // 和星标写同一个 .picasa.ini，排同一个队
  try {
    const fallback = await store.queueStarWrite(() => api.setRating(paths, rating));
    if (fallback) toast(t('rate.fallback'), 'warn', 4000);
  } catch (e) {
    changed.forEach((p) => {
      if (p.rating === rating) p.rating = before.get(p) ?? 0;
    });
    grid.refreshCells();
    viewer.refreshStar();
    toast(t('rate.fail', { e: String(e) }), 'error', 4000);
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
    title: t('wd.dialogTitle'),
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
    toast(t('export.closeFirst'), 'warn');
    return;
  }
  if (dialog.querySelector('.help')) {
    dialog.hidden = true;
    dialog.innerHTML = '';
  }
  const seq = ++switchSeq;
  toast(t('scan.progress', { name: baseName(path) }));
  thumbsEl.textContent = t('scan.progress', { name: baseName(path) });
  let lib: Library;
  try {
    lib = await api.setWorkdir(path);
  } catch (e) {
    if (String(e).includes('superseded')) return; // 被后来的有效切换取代了，由它收尾
    if (seq !== switchSeq) return; // 有更新的切换在途，由它收尾
    failedSeq = seq;
    thumbsEl.textContent = '';
    const missing = String(e).includes('不存在');
    toast(missing ? t('wd.missing', { path }) : t('wd.openFail', { e: String(e) }), 'error', 5000);
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
    toast(t('wd.found', { albums: lib.folders.length, photos: n }));
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
  if (last.kind === 'folder' && lib.folders.some((f) => f.path === last.path) && (await openFolder(last.path, !!last.starredOnly))) return;
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
    { label: t('wd.choose'), detail: modKey('O'), action: () => void chooseWorkdir() },
    ...(workdir
      ? [
          { label: t('rescan.title'), action: () => void rescan() },
          { label: REVEAL_LABEL, action: () => void revealItemInDir(workdir).catch(() => {}) },
        ]
      : []),
    ...(others.length ? [{ separator: true, label: t('menu.recent'), action: () => {} }] : []),
    ...others.map((r) => ({
      label: gone.has(r) ? t('menu.offline', { name: baseName(r) }) : baseName(r),
      detail: shortPath(r),
      disabled: gone.has(r),
      action: () => void switchWorkdir(r),
    })),
    ...(others.some((r) => gone.has(r)) ? [{ label: t('menu.forget'), action: () => void forgetMissing() }] : []),
  ]);
}

async function rescan(): Promise<void> {
  toast(t('rescan.toast'));
  setLibrary(await api.rescan());
  const v = store.view;
  if (v.kind === 'folder' && store.folder(v.path)) await openFolder(v.path, !!v.starredOnly);
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

/**
 * 点侧栏“已加星标的照片”或按 Shift+S：星标筛选开 / 关。
 * 打开：先看所有相册的星标汇总，侧栏只剩有星标的相册，点哪个就看哪个的星标照片。
 * 关闭：正在看某个相册就留在这个相册（显示全部照片）；在汇总里就回到之前看的相册。
 */
function toggleStarredView(): void {
  const v = store.view;
  if (!isStarMode(v)) {
    void openStarred();
    return;
  }
  if (v.kind === 'folder' && store.folder(v.path)) {
    void openFolder(v.path);
    return;
  }
  const back = lastFolder && store.folder(lastFolder) ? lastFolder : store.library.folders[0]?.path;
  if (back) void openFolder(back);
  else showEmptyView();
}

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

const ALT = isMac ? '⌥' : 'Alt';
const helpRows = (): [string, string][] => [
  [t('help.library'), ''],
  [t('hk.arrows'), t('hd.arrows')],
  [t('hk.click', { mod: MOD_NAME }), t('hd.click')],
  [modKey('A'), t('hd.selectAll')],
  [t('hk.open'), t('hd.open')],
  [t('hk.scroll'), t('hd.scroll')],
  [t('hk.star', { key: modKey('8') }), t('hd.star')],
  [t('hk.rate'), t('hd.rate')],
  ['Shift+S', t('hd.starFilter')],
  [modKey('E'), t('hd.export')],
  [modKey('F'), t('hd.search')],
  [modKey('O'), t('hd.workdir')],
  [t('hk.pinch', { mod: MOD_NAME }), t('hd.thumbSize')],
  [t('help.viewer'), ''],
  [t('hk.page'), t('hd.page')],
  [t('hk.star', { key: modKey('8') }), t('hd.star')],
  [t('hk.rate'), t('hd.rate')],
  [t('hk.actual'), t('hd.actual')],
  [t('hk.pinch', { mod: MOD_NAME }), t('hd.zoom')],
  [t('hk.pan', { alt: ALT }), t('hd.pan')],
  ['F', t('hd.full')],
  ['Esc', t('hd.back')],
];

function showHelp(): void {
  const el = $('export-dialog');
  const pref = langPref();
  const langs: [LangPref, string][] = [
    ['auto', t('lang.auto')],
    ['zh', '中文'],
    ['en', 'English'],
  ];
  el.innerHTML = `<div class="modal-card help"><h2>${t('help.title')}</h2><table>${helpRows()
    .map(([k, v]) => (v ? `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>` : `<tr><th colspan="2">${esc(k)}</th></tr>`))
    .join('')}</table><div class="actions"><label class="lang">${t('help.lang')} <select class="input">${langs
    .map(([v, name]) => `<option value="${v}" ${v === pref ? 'selected' : ''}>${name}</option>`)
    .join('')}</select></label><div class="spacer"></div><button class="btn primary">${t('help.ok')}</button></div></div>`;
  el.hidden = false;
  const close = () => {
    el.hidden = true;
    el.innerHTML = '';
  };
  el.querySelector('button')!.addEventListener('click', close);
  el.querySelector('select')!.addEventListener('change', (e) => setLangPref((e.target as HTMLSelectElement).value as LangPref));
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
    { label: t('menu.open'), action: () => openViewer(i) },
    { label: t(allStarred ? 'menu.unstar' : 'menu.star'), action: () => void toggleStar(targets) },
    { label: REVEAL_LABEL, action: () => void revealItemInDir(p.path).catch(() => {}) },
    { label: t('export.btn'), action: () => openExportDialog() },
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
  thumbsEl.textContent = total && done < total ? t('status.thumbs', { done, total }) : '';
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
  const isRateKey = !mod && k.length === 1 && k >= '0' && k <= '5';
  const isStarKey = k === ' ' || k === 's' || k === 'S' || (mod && k === '8') || isRateKey;
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
  else if (isRateKey) void rate(starTargets(), Number(k));
  else if (k === 'S' && e.shiftKey) toggleStarredView();
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
  titleEl.innerHTML = `<span class="dim">${t('boot.scanning')}</span>`;
  let lib: Library;
  try {
    lib = await api.getLibrary();
  } catch (e) {
    toast(t('boot.fail', { e: String(e) }), 'error', 6000);
    return;
  }
  setLibrary(lib);
  await openInitialView(lib);
  gridEl.focus({ preventScroll: true });
}

void boot();

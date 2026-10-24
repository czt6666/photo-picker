// 入口：把侧栏、网格、看图器、导出对话框接到一起，处理全局快捷键。

import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api } from './api';
import { closeExportDialog, isExportOpen, openExportDialog } from './exportDialog';
import { Grid } from './grid';
import { baseName, makeSidebarResizable, Sidebar } from './sidebar';
import { planRate, planToggle } from './rating';
import { isStarMode, prefs, store, type View } from './store';
import type { Library, Photo, Progress } from './types';
import { ICONS } from './icons';
import { LANGS, langPref, setLang, t, translateDom, type Lang } from './i18n';
import { closeMenu, contextMenu, esc, toast, type MenuItem } from './ui';
import { formatBytes, Viewer } from './viewer';
import { isBrowserShortcut, isMac, isTauri, isTouch, isWeb, mod as modKey, MOD_NAME, REVEAL_LABEL } from './platform';
import {
  albumPath,
  folderPath,
  isRemotePath,
  parseRemotePath,
  parseShareInput,
  remote,
  SERVER,
  type RemoteAlbum,
  type RemoteEvent,
  type ServerComment,
} from './remote';
import { confirmBox, continueUpload, showConnect, showCreate, showShare, stopUpload, uploadingCode } from './remoteUi';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

translateDom(document);
document.body.classList.toggle('web', isWeb);
document.body.classList.toggle('touch', isTouch);

/**
 * 网页版兜底：有的内置浏览器（微信）不守缓存规矩，还拿着旧网页。
 * 打开时、切回来时去服务器拿一眼最新的网页，看它引用的脚本文件名（带内容哈希）和自己的一样不一样，
 * 不一样就说明发了新版，刷新一次。同一个新版本只刷一次，免得万一刷完还是旧的就一直刷。
 */
function checkForNewVersion(): void {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  if (!mine) return; // 开发模式
  void fetch(import.meta.env.BASE_URL, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      const latest = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
      if (!latest || latest === mine) return;
      try {
        if (sessionStorage.getItem('pp.reloadedFor') === latest) return;
        sessionStorage.setItem('pp.reloadedFor', latest);
      } catch {
        return;
      }
      location.reload();
    })
    .catch(() => {});
}
if (isWeb) {
  checkForNewVersion();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForNewVersion());
}

const gridEl = $('grid');
const emptyEl = $('empty');
const titleEl = $('view-title');
const countEl = $('status-count');
const thumbsEl = $('status-thumbs');
const zoom = $<HTMLInputElement>('zoom');
const search = $<HTMLInputElement>('search');

const grid = new Grid(gridEl, $('grid-inner'), {
  open: (i) => openViewer(i),
  toggleStar: (photos) => void toggleStar(photos),
  selectionChanged: () => updateStatus(),
  sectionName: (dir) => store.folder(dir)?.name ?? baseName(dir),
  sectionChanged: (dir) => onSectionAtTop(dir),
  nearEnd: () => void loadNextAlbum(),
  nearStart: () => void loadPrevAlbum(),
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
  thumbRect(path) {
    const i = store.indexOf(path);
    if (i < 0) return null;
    grid.scrollToIndex(i);
    return grid.thumbOf(i)?.getBoundingClientRect() ?? null;
  },
});

makeSidebarResizable($('sb-resizer'));

const sidebar = new Sidebar($('sidebar'), {
  // 星标筛选开着时点相册：筛选保持，只看这个相册里的星标照片
  openFolder: (path) => void openFolder(path, isStarMode(store.view)),
  toggleStarred: () => toggleStarredView(),
  folderMenu(path, x, y) {
    if (isRemotePath(path)) return void showWorkdirMenu(x, y);
    contextMenu(x, y, [
      { label: REVEAL_LABEL, action: () => void revealItemInDir(path).catch(() => {}) },
      { label: t('重新扫描'), action: () => void rescan() },
      { label: t('共享为远程相册'), action: () => createRemote(path) },
    ]);
  },
  workdirMenu: (x, y) => void showWorkdirMenu(x, y),
  workdirLabel: (wd) => (isRemotePath(wd) ? (remote.get(parseRemotePath(wd).code)?.name ?? '') : baseName(wd)),
});

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

function setLibrary(lib: Library): void {
  store.setLibrary(lib);
  sidebar.render();
  const wd = lib.workdir;
  const a = wd && isRemotePath(wd) ? remote.get(parseRemotePath(wd).code) : undefined;
  const label = (icon: string, text: string, more = true) => {
    workdirBtn.innerHTML = `${icon}<span class="label"></span>${more ? ICONS.down : ''}`;
    workdirBtn.querySelector('.label')!.textContent = text;
  };
  if (a) {
    label(ICONS.cloud, a.name);
    workdirBtn.title = t('远程相册 · 点击切换');
  } else {
    if (wd) label(ICONS.folder, baseName(wd));
    else if (isWeb) label(ICONS.cloud, t('打开远程相册'), false);
    else label(ICONS.folder, t('选择工作目录'), false);
    workdirBtn.title = wd ? `${t('{path}\n点击切换', { path: wd })}（${modKey('O')}）` : `${t('选择照片文件夹')}（${modKey('O')}）`;
  }
  shareBtn.hidden = !a;
  document.body.classList.toggle('remote', !!a);
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
    toast(t('读取失败：{e}', { e: String(e) }), 'error');
    return false;
  }
  if (seq !== viewSeq) return true; // 用户已经点了别的文件夹
  chain = view.kind === 'folder' ? [view.path] : [];
  chainEnded = chainStartEnded = false;
  lastChunk = photos;
  store.setPhotos(view, photos);
  if (view.kind === 'folder') lastFolder = view.path;
  prefs.set(`lastView:${store.library.workdir ?? ''}`, view);
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
/** 往上接（上一个相册）也一样，单独记 */
let chainStartBusy = false;
let chainStartEnded = false;
/** 最近接上来的那批照片：预生成缩略图时连它一起发（后端每次调用会替换掉上一批排队） */
let lastChunk: Photo[] = [];

/** 已显示的相册前一个（step=-1）/ 后一个（step=1）是谁 */
function neighborAlbumPath(step: 1 | -1): string | null {
  const v = store.view;
  // 搜索时只在已经显示的相册里找，不往后接（否则没有结果时会把整个工作目录读一遍）
  if (v.kind !== 'folder' || store.query.trim() || !chain.length) return null;
  const all = store.library.folders;
  const list = v.starredOnly ? all.filter((f) => f.starred > 0 || chain.includes(f.path)) : all;
  const i = list.findIndex((f) => f.path === (step > 0 ? chain[chain.length - 1] : chain[0]));
  return i >= 0 ? (list[i + step]?.path ?? null) : null;
}
const nextAlbumPath = () => neighborAlbumPath(1);

/** 往上滚到当前相册的开头：把侧栏里排在它前面的相册接到前面（从下面的相册点进来，也能一路滑回上面） */
async function loadPrevAlbum(): Promise<void> {
  if (chainStartBusy || chainStartEnded) return;
  const path = neighborAlbumPath(-1);
  if (!path) return;
  const seq = viewSeq;
  chainStartBusy = true;
  try {
    await store.starsSettled();
    const photos = await api.listFolder(path);
    if (seq !== viewSeq) return;
    chain.unshift(path);
    store.prependPhotos(photos);
    grid.prepend();
    updateStatus();
    void api.prefetchThumbs(photos.map((p) => p.path)).catch(() => {});
  } catch {
    if (seq === viewSeq) chainStartEnded = true;
  } finally {
    chainStartBusy = false;
    grid.poke();
  }
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
  prefs.set(`lastView:${store.library.workdir ?? ''}`, store.view);
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
    const tag = v.starredOnly ? ` <span class="star">★</span> <span class="dim">${t('仅星标')} ·</span>` : '';
    let sub = esc(v.path);
    if (isRemotePath(v.path)) {
      sub = '';
    }
    titleEl.innerHTML = `<b>${esc(f?.name ?? v.path.split(/[\\/]/).pop() ?? '')}</b>${tag} <span class="dim">${sub}</span>`;
  } else if (v.kind === 'starred') {
    titleEl.innerHTML = `<b><span class="star">★</span> ${t('已加星标的照片')}</b> <span class="dim">${t('所有相册')}</span>`;
  } else {
    titleEl.textContent = '';
  }
}

function renderEmpty(): void {
  let html = '';
  if (isWeb && !store.library.workdir) {
    html = `<div class="empty-card">
      <div class="big">☁</div>
      <h2>${t('PhotoPicker 网页版')}</h2>
      <p class="dim">${t('打开链接一起挑，或传照片发给别人。')}</p>
      <div class="row center"><button class="btn primary" id="empty-connect">${t('连接远程相册')}</button>
      <button class="btn" id="empty-create">${t('创建远程相册')}</button></div></div>`;
  } else if (!store.library.workdir) {
    html = `<div class="empty-card">
      <div class="big">📁</div>
      <h2>${t('选择一个照片文件夹')}</h2>
      <p class="dim">${t('子文件夹会列成相册，也能直接拖进来。')}</p>
      <button class="btn primary" id="empty-add">${t('选择文件夹')}</button></div>`;
  } else if (store.library.workdir && !store.library.folders.length && store.view.kind === 'none') {
    html = `<div class="empty-card"><h2>${t('这里没有找到照片')}</h2>
      <p class="dim">${esc(store.library.workdir)}</p>
      <button class="btn primary" id="empty-add">${t('换一个文件夹')}</button></div>`;
  } else if (store.view.kind === 'none') {
    html = `<div class="empty-card"><p class="dim">${t('从左侧选择一个相册')}</p></div>`;
  } else if (!store.visible.length) {
    if (store.view.kind === 'starred')
      html = `<div class="empty-card"><h2>${t('还没有星标')}</h2><p class="dim">${t('按 {key} 加星标', { key: `<kbd>${t('空格')}</kbd>` })}</p></div>`;
    else if (store.view.kind === 'folder' && store.view.starredOnly && !store.query)
      html = `<div class="empty-card"><h2>${t('这个相册没有星标照片')}</h2><p class="dim">${t('按 {key} 取消筛选', { key: '<kbd>Shift+S</kbd>' })}</p></div>`;
    else if (store.query) html = `<div class="empty-card"><p class="dim">${t('没有匹配“{q}”的照片', { q: esc(store.query) })}</p></div>`;
    else html = `<div class="empty-card"><p class="dim">${t('没有照片')}</p></div>`;
  }
  emptyEl.innerHTML = html;
  emptyEl.hidden = !html;
  gridEl.hidden = !!html;
  emptyEl.querySelector('#empty-add')?.addEventListener('click', () => void chooseWorkdir());
  emptyEl.querySelector('#empty-connect')?.addEventListener('click', () => showConnect((a) => void openRemote(a.code)));
  emptyEl.querySelector('#empty-create')?.addEventListener('click', () => void createRemote(null));
}

function updateStatus(): void {
  // 连续翻动时列表里接着好几个相册，张数只报正在看的那个
  const v = store.view;
  const sec = v.kind === 'folder' ? store.sections.find((s) => s.dir === v.path) : undefined;
  const shown = sec ? store.visible.slice(sec.start, sec.start + sec.count) : store.visible;
  const total = shown.length;
  const starred = shown.filter((p) => p.starred).length;
  const sel = store.selection.size;
  let s = store.view.kind === 'none' ? '' : t('{n} 张照片', { n: total });
  if (starred && !isStarMode(store.view)) s += `  ·  ★ ${starred}`;
  if (sel) {
    const bytes = store.selectedPhotos().reduce((n, p) => n + p.size, 0);
    s += `  ·  ${t('已选 {n} 张（{size}）', { n: sel, size: formatBytes(bytes) })}`;
  }
  countEl.textContent = s;
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
    if (r.fallback) toast(t('文件夹不可写，星标已存到本机'), 'warn', 4000);
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
    toast(t('星标保存失败：{e}', { e: String(e) }), 'error', 4000);
  }
}

/** 星级（Lightroom 的星级）：数字键 1～5 标成几星，已经全是这个星级时再按一次 = 清除；0 = 清除。不动星标。 */
async function rate(photos: Photo[], n: number): Promise<void> {
  if (photos.some((p) => p.remote)) {
    toast(t('远程相册不支持星级'), 'warn');
    photos = photos.filter((p) => !p.remote);
  }
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
    if (fallback) toast(t('文件夹不可写，星级已存到本机'), 'warn', 4000);
  } catch (e) {
    changed.forEach((p) => {
      if (p.rating === rating) p.rating = before.get(p) ?? 0;
    });
    grid.refreshCells();
    viewer.refreshStar();
    toast(t('星级保存失败：{e}', { e: String(e) }), 'error', 4000);
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
    title: t('选择照片文件夹'),
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
    toast(t('请先关闭导出对话框'), 'warn');
    return;
  }
  if (dialog.querySelector('.help')) {
    dialog.hidden = true;
    dialog.innerHTML = '';
  }
  const seq = ++switchSeq;
  toast(t('正在扫描 {name}…', { name: baseName(path) }));
  thumbsEl.textContent = t('正在扫描 {name}…', { name: baseName(path) });
  let lib: Library;
  try {
    lib = await api.setWorkdir(path);
  } catch (e) {
    if (String(e).includes('superseded')) return; // 被后来的有效切换取代了，由它收尾
    if (seq !== switchSeq) return; // 有更新的切换在途，由它收尾
    failedSeq = seq;
    thumbsEl.textContent = '';
    const missing = String(e).includes('不存在');
    toast(missing ? t('找不到 {path}，移动硬盘没接上？', { path }) : t('打不开：{e}', { e: String(e) }), 'error', 5000);
    // 这次失败了，但更早发出的一次有效切换可能已经在后台生效：以后台为准对齐界面
    await syncWithBackend(seq);
    return;
  }
  // 本次结果过时：更新的切换还在途就交给它；更新的切换都失败了，那后台的最终状态就是本次
  if (seq !== switchSeq && failedSeq !== switchSeq) return;
  remote.activate(null);
  applyWorkdir(lib);
  await openInitialView(lib);
  if (lib.folders.length) {
    const n = lib.folders.reduce((s, f) => s + f.count, 0);
    toast(t('{n} 个相册，{m} 张照片', { n: lib.folders.length, m: n }));
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
  const last = prefs.get<View>(`lastView:${lib.workdir ?? ''}`, { kind: 'none' });
  if (last.kind === 'starred' && (await openStarred())) return;
  if (last.kind === 'folder' && store.folder(last.path) && (await openFolder(last.path, !!last.starredOnly))) return;
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
  const localLib = await api.localLibrary().catch(() => null);
  if (localLib && !remote.active && localLib.workdir === store.library.workdir) setLibrary(localLib);
  const workdir = store.library.workdir;
  const { recent = [], missing = [] } = localLib ?? {};
  const others = recent.filter((r) => r !== workdir);
  const gone = new Set(missing);
  const forgetMissing = async () => {
    let lib: Library | null = null;
    for (const m of missing.filter((m) => m !== workdir)) lib = await api.forgetWorkdir(m).catch(() => lib);
    if (lib && !remote.active) setLibrary(lib);
  };
  const active = remote.active ? remote.get(remote.active) : undefined;
  const remotes = remote.albums;
  const items: MenuItem[] = [];
  if (isTauri) items.push({ label: t('打开文件夹'), detail: modKey('O'), action: () => void chooseWorkdir() });
  if (active) items.push(...remoteItems(active));
  else if (workdir) {
    items.push(
      { label: t('重新扫描'), action: () => void rescan() },
      { label: REVEAL_LABEL, action: () => void revealItemInDir(workdir).catch(() => {}) },
    );
  }
  items.push(
    { separator: true, label: t('远程相册'), action: () => {} },
    { label: t('连接远程相册'), action: () => showConnect((a) => void openRemote(a.code)) },
    { label: t('创建远程相册'), action: () => void createRemote(null) },
    ...remotes.map((a) => ({
      label: a.name,
      icon: ICONS.cloud,
      detail: t('{n} 张', { n: a.count }),
      current: a.code === remote.active,
      action: () => void (a.code === remote.active ? undefined : openRemote(a.code)),
      trail: {
        icon: ICONS.trash,
        title: t('从列表中移除'),
        action: async () => {
          const body = a.ownerToken ? t('只是不在这台设备上显示，线上相册还在') : t('只是不在这台设备上显示，以后打开链接还能再连上');
          if (await confirmBox(t('从列表中移除「{name}」？', { name: a.name }), body, t('移除'))) void forgetRemote(a.code);
        },
      },
    })),
  );
  if (others.length) {
    items.push(
      { separator: true, label: t('最近'), action: () => {} },
      ...others.map((r) => ({
        label: gone.has(r) ? t('{name}（未连接）', { name: baseName(r) }) : baseName(r),
        detail: shortPath(r),
        disabled: gone.has(r),
        action: () => void switchWorkdir(r),
      })),
    );
    if (others.some((r) => gone.has(r))) items.push({ label: t('移除未连接的'), action: () => void forgetMissing() });
  }
  contextMenu(x, y, items);
}

async function rescan(): Promise<void> {
  if (remote.active) return void reloadRemote();
  toast(t('正在扫描…'));
  setLibrary(await api.rescan());
  const v = store.view;
  if (v.kind === 'folder' && store.folder(v.path)) await openFolder(v.path, !!v.starredOnly);
  else if (v.kind === 'starred') await openStarred();
  else await openInitialView(store.library);
}

// ---------------------------------------------------------------------------
// 工具栏 / 状态栏
// ---------------------------------------------------------------------------

// 工具栏按钮换成 SVG 图标（文字只留 title / 旁边的 label）
$('btn-menu').innerHTML = ICONS.menu;
$('btn-settings').innerHTML = ICONS.settings;
$('btn-help').innerHTML = ICONS.help;
$('btn-rescan').innerHTML = ICONS.refresh;
{
  const share = $('btn-share');
  const text = share.querySelector('.label')!.textContent ?? '';
  share.innerHTML = `${ICONS.share}<span class="label"></span>`;
  share.querySelector('.label')!.textContent = text;
  const back = document.querySelector<HTMLElement>('.v-back')!;
  const bt = back.textContent!.replace('←', '').trim();
  back.innerHTML = `${ICONS.back}<span class="label"></span>`;
  back.querySelector('.label')!.textContent = bt;
}

/** 导出时移动了文件：本地相册重新扫描（挪走的照片消失、新文件夹出现）；远程相册的原图在本机别处，不用动 */
const onMoved = () => {
  if (!remote.active) void rescan();
};

const workdirBtn = $<HTMLButtonElement>('btn-workdir');
const shareBtn = $<HTMLButtonElement>('btn-share');
workdirBtn.addEventListener('click', () => {
  const r = workdirBtn.getBoundingClientRect();
  void showWorkdirMenu(r.left, r.bottom + 4);
});
$('btn-rescan').addEventListener('click', () => void rescan());
$('btn-export').addEventListener('click', () => openExportDialog(onMoved));

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

// 手机：像“照片”App 一样方格铺满屏幕，两指捏合改每行几张（2～6）
const phone = matchMedia('(max-width: 760px)');
const applyCompact = () => grid.setCompact(isTouch && phone.matches ? prefs.get('touchCols', 3) : null);
applyCompact();
phone.addEventListener('change', applyCompact);
{
  // 学 iPhone：捏的过程中整片方格跟着手指缩放，松手后吸到最近的列数，再用动画落位。
  // 手指中间那张照片始终待在手指中间。
  const inner = $('grid-inner');
  // 用 touch 事件而不是 pointer：两根手指放上去时要 preventDefault，不然浏览器把它当滚动，半路就把手指“收走”了
  let pinch: { d: number; cols: number; mx: number; my: number; i: number; fx: number; fy: number; s: number } | null = null;
  const MIN_COLS = 1;
  const MAX_COLS = 7;
  const two = (e: TouchEvent) => [e.touches[0], e.touches[1]];
  gridEl.addEventListener(
    'touchstart',
    (e) => {
      const cols = grid.columns;
      if (e.touches.length !== 2 || !cols) return;
      e.preventDefault();
      const [a, b] = two(e);
      const mx = (a.clientX + b.clientX) / 2;
      const my = (a.clientY + b.clientY) / 2;
      let i = grid.indexAt(mx, my);
      if (i < 0) i = grid.indexAt(gridEl.getBoundingClientRect().left + 4, my);
      const box = i >= 0 ? grid.cellBox(i) : null;
      const ir = inner.getBoundingClientRect();
      const fx = box ? (mx - ir.left - box.x) / box.w : 0.5;
      const fy = box ? (my - ir.top - box.y) / box.h : 0.5;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cols, mx, my, i, fx, fy, s: 1 };
      inner.style.transition = 'none';
      inner.style.transformOrigin = `${mx - ir.left}px ${my - ir.top}px`;
    },
    { passive: false },
  );
  gridEl.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length < 2) return;
      e.preventDefault();
      const [a, b] = two(e);
      // 灵敏一点：手指距离的变化放大 1.4 倍；到头了像橡皮筋一样越拉越紧
      const raw = Math.pow(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / Math.max(1, pinch.d), 1.4);
      const lo = pinch.cols / MAX_COLS;
      const hi = pinch.cols / MIN_COLS;
      pinch.s = raw < lo ? lo * Math.pow(raw / lo, 0.3) : raw > hi ? hi * Math.pow(raw / hi, 0.3) : raw;
      inner.style.transform = `scale(${pinch.s})`;
    },
    { passive: false },
  );
  const settle = () => {
    const p = pinch!;
    pinch = null;
    const s = p.s;
    // 稍微捏一点就换一档；捏得多就按比例跳几档
    let next = Math.round(p.cols / s);
    if (s > 1.08) next = Math.min(next, p.cols - 1);
    if (s < 0.92) next = Math.max(next, p.cols + 1);
    next = Math.max(MIN_COLS, Math.min(MAX_COLS, next));
    if (next !== p.cols) {
      prefs.set('touchCols', next);
      grid.setCompact(next);
    }
    // 换了列数后，把手指下的那张照片挪回手指下面，再从当前的大小动画缩放到 1
    const box = p.i >= 0 ? grid.cellBox(p.i) : null;
    const gr = gridEl.getBoundingClientRect();
    let ox = p.mx - gr.left;
    let oy = p.my - gr.top + gridEl.scrollTop;
    if (box) {
      const px = box.x + p.fx * box.w;
      const py = box.y + p.fy * box.h;
      gridEl.scrollTop = py - (p.my - gr.top);
      ox = px;
      oy = py;
    }
    const k = s * (next / p.cols);
    inner.style.transition = 'none';
    inner.style.transformOrigin = `${ox}px ${oy}px`;
    inner.style.transform = `scale(${k})`;
    void inner.offsetWidth;
    inner.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.9, 0.25, 1)';
    inner.style.transform = '';
  };
  const end = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) settle();
  };
  gridEl.addEventListener('touchend', end);
  gridEl.addEventListener('touchcancel', end);
  // iPhone 的 Safari 不管 maximum-scale，自己会缩放整个网页：拦掉
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

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

const HELP = (): string[][] => [
  [t('图库'), ''],
  [t('方向键'), t('移动；按住 Shift 连选')],
  [t('{mod} / Shift 点击', { mod: MOD_NAME }), t('多选 / 连选')],
  [modKey('A'), t('全选')],
  [t('回车、双击'), t('看大图')],
  [`${t('空格')} / S`, t('星标（选取）')],
  [t('1～5、0'), t('星级；0 清除')],
  ['Shift+S', t('星标筛选')],
  [modKey('E'), t('导出')],
  [modKey('F'), t('搜索文件名')],
  [modKey('O'), t('选择 / 切换文件夹')],
  [modKey(','), t('设置')],
  [t('捏合、{mod}+滚轮', { mod: MOD_NAME }), t('缩略图大小')],
  [t('看大图时'), ''],
  [t('滚轮、← →'), t('上一张 / 下一张')],
  [`${t('空格')} / S`, t('星标（选取）')],
  [t('1～5、0'), t('星级；0 清除')],
  [t('Z、双击'), t('1:1 / 适合窗口')],
  [t('捏合、{mod}+滚轮', { mod: MOD_NAME }), t('缩放')],
  [t('{alt}+滚动、拖动', { alt: isMac ? '⌥' : 'Alt' }), t('平移（翻页时保持）')],
  ['F', t('全屏')],
  ['Esc', t('返回')],
];

function showHelp(): void {
  const el = $('export-dialog');
  el.innerHTML = `<div class="modal-card help"><h2>${t('快捷键')}</h2><table>${HELP().map(([k, v]) =>
    v ? `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>` : `<tr><th colspan="2">${esc(k)}</th></tr>`,
  ).join('')}</table><div class="actions"><button class="btn primary">${t('知道了')}</button></div></div>`;
  el.hidden = false;
  const close = () => {
    el.hidden = true;
    el.innerHTML = '';
  };
  el.querySelector('button')!.addEventListener('click', close);
  el.onclick = (e) => e.target === el && close();
}
$('btn-help').addEventListener('click', showHelp);

/** 设置：目前只有语言。和快捷键帮助共用一个弹层 */
function showSettings(): void {
  const el = $('export-dialog');
  const opts = [{ id: '', label: t('跟随系统') }, ...LANGS]
    .map((l) => `<option value="${l.id}" ${l.id === (langPref ?? '') ? 'selected' : ''}>${esc(l.label)}</option>`)
    .join('');
  el.innerHTML = `<div class="modal-card help settings"><h2>${t('设置')}</h2>
    <div class="field"><label class="lang">${t('语言')} <select class="input">${opts}</select></label></div>
    <div class="actions"><button class="btn primary">${t('关闭')}</button></div></div>`;
  el.hidden = false;
  const close = () => {
    el.hidden = true;
    el.innerHTML = '';
  };
  el.querySelector('button')!.addEventListener('click', close);
  el.querySelector('select')!.addEventListener('change', (e) => setLang(((e.target as HTMLSelectElement).value || null) as Lang | null));
  el.onclick = (e) => e.target === el && close();
}
$('btn-settings').addEventListener('click', showSettings);


$('btn-settings').title = `${t('设置')}（${modKey(',')}）`;

gridEl.addEventListener('contextmenu', (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
  if (!cell) return;
  e.preventDefault();
  const i = Number(cell.dataset.i);
  const p = store.visible[i];
  if (!store.selection.has(p.path)) grid.selectIndex(i, 'single');
  const targets = starTargets();
  const allStarred = targets.every((x) => x.starred);
  const items: MenuItem[] = [
    { label: t('查看大图'), action: () => openViewer(i) },
    { label: allStarred ? t('取消星标') : t('加星标'), action: () => void toggleStar(targets) },
  ];
  if (isTauri && !isRemotePath(p.path)) items.push({ label: REVEAL_LABEL, action: () => void revealItemInDir(p.path).catch(() => {}) });
  if (isTauri) items.push({ label: t('导出'), action: () => openExportDialog(onMoved) });
  const ra = p.remote ? remote.get(p.remote.code) : undefined;
  if (ra?.ownerToken) items.push({ label: t('从相册里删除'), danger: true, action: () => void deleteFromAlbum(ra, targets) });
  contextMenu(e.clientX, e.clientY, items);
});

// 屏蔽 webview 自带的右键菜单（“重新载入”等），输入框除外
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

// 启动时先显示上次的图库缓存，后台扫描完成后在这里更新（新增/删除的文件夹、照片数）
if (isTauri) void listen<Library>('library-updated', (e) => {
  if (remote.active) return; // 正开着远程相册，本地扫描结果等切回来再用
  setLibrary(e.payload);
  const v = store.view;
  if ((v.kind === 'folder' && !store.folder(v.path)) || (v.kind === 'none' && e.payload.folders.length)) {
    if (!viewer.opened) void openInitialView(e.payload);
  } else {
    renderChrome();
  }
});

if (isTauri) void listen<Progress>('thumb-progress', (e) => {
  const { done, total } = e.payload;
  thumbsEl.textContent = total && done < total ? t('正在生成缩略图 {done} / {total}', { done, total }) : '';
});

// 把文件夹拖进窗口 = 添加到图库
if (isTauri) void getCurrentWebview()
  .onDragDropEvent((e) => {
    document.body.classList.toggle('drop-target', e.payload.type === 'over' || e.payload.type === 'enter');
    // 拖进来一个文件夹（或其中的照片）= 把它设为工作目录
    if (e.payload.type === 'drop' && e.payload.paths.length) void switchWorkdir(e.payload.paths[0]);
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// 远程相册
// ---------------------------------------------------------------------------

/** 上传进度在上传面板里，这里不用再显示 */
const progress = () => {};

/** 创建远程相册：先选要共享的文件夹（默认停在当前工作目录；右键某个相册就停在它） */
async function createRemote(sourceDir: string | null): Promise<void> {
  if (isTauri && !sourceDir) sourceDir = (await api.localLibrary().catch(() => null))?.workdir ?? null;
  await showCreate(sourceDir, (a) => void openRemote(a.code), progress);
}

/** 把远程相册当工作目录打开 */
async function openRemote(code: string): Promise<boolean> {
  closeDrawer();
  const prev = remote.active;
  remote.activate(code);
  let lib: Library;
  try {
    lib = await remote.library(code);
  } catch (e) {
    remote.activate(prev);
    toast(e instanceof Error ? e.message : String(e), 'error', 6000);
    return false;
  }
  applyWorkdir(lib);
  await openInitialView(lib);
  notifyUnreadOnOpen(code);
  return true;
}

// ---------- 留言通知：顶部横幅，点一下跳到那张照片的留言 ----------

let bannerTimer = 0;
function showBanner(thumb: string | null, who: string, text: string, onClick: () => void, ms = 6000): void {
  document.querySelector('.banner')?.remove();
  clearTimeout(bannerTimer);
  const b = document.createElement('div');
  b.className = 'banner';
  b.innerHTML = `${thumb ? `<img alt="">` : `<span class="b-ico">${ICONS.bubble}</span>`}<div class="b-body"><div class="b-who"></div><div class="b-text"></div></div><button class="b-close" title="${t('关闭')}">×</button>`;
  if (thumb) b.querySelector('img')!.src = thumb;
  b.querySelector('.b-who')!.textContent = who;
  b.querySelector('.b-text')!.textContent = text;
  const close = () => {
    clearTimeout(bannerTimer);
    b.classList.add('out');
    window.setTimeout(() => b.remove(), 250);
  };
  b.addEventListener('click', (e) => {
    close();
    if (!(e.target as HTMLElement).closest('.b-close')) onClick();
  });
  document.body.appendChild(b);
  bannerTimer = window.setTimeout(close, ms);
}

/** 跳到某张远程照片并打开它的留言：不在当前网格里就先打开它所在的相册 */
async function goToComment(code: string, photoId: number): Promise<void> {
  if (remote.active !== code) return;
  const path = `${albumPath(code)}#${photoId}`;
  const info = remote.photoInfo(path);
  if (!info) return;
  if (viewer.opened) viewer.close();
  if (store.indexOf(path) < 0) await openFolder(folderPath(code, info.folder));
  const i = store.indexOf(path);
  if (i < 0) return;
  grid.selectIndex(i, 'single');
  openViewer(i);
  viewer.showComments();
}

/** 别人刚留了言：正在看的这张、留言栏也开着，就不打扰了 */
function notifyComment(code: string, c: ServerComment): void {
  // 自己发的留言，推送可能比发送请求的回应先到：稍等一下再判断是不是自己的
  window.setTimeout(() => {
    if (remote.active !== code || remote.isMine(code, c.id)) return;
    if (viewer.opened && viewer.current?.remote?.id === c.photo_id && document.querySelector('.viewer.sheet-open.sheet-comments')) return;
    const info = remote.photoInfo(`${albumPath(code)}#${c.photo_id}`);
    const thumb = info ? `${remote.toPhoto(code, info).remote!.img}_t.jpg` : null;
    showBanner(thumb, c.name || t('有人留言'), c.text, () => void goToComment(code, c.photo_id));
  }, 500);
}

/** 刚打开相册：离开这段时间有几条新留言 */
function notifyUnreadOnOpen(code: string): void {
  const list = remote.unreadComments(code);
  if (!list.length) return;
  const first = list[0];
  const text = list.length === 1 ? first.text : t('点一下从最早的一条开始看');
  showBanner(null, t('有 {n} 条新留言', { n: list.length }), text, () => void goToComment(code, first.photo_id), 10000);
}

async function connectAndOpen(link: string): Promise<boolean> {
  try {
    const a = await remote.connect(link);
    return await openRemote(a.code);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error', 6000);
    return false;
  }
}

/** 选中的照片从远程相册里删掉（只有创建者能删）；删完服务器推 deleted，各端自己刷新 */
async function deleteFromAlbum(a: RemoteAlbum, photos: Photo[]): Promise<void> {
  const ids = photos.filter((p) => p.remote?.code === a.code).map((p) => p.remote!.id);
  if (!ids.length) return void toast(t('先选中要删的照片'), 'warn');
  if (!(await confirmBox(t('从相册里删除 {n} 张照片？', { n: ids.length }), t('线上图片、星标和留言都会删掉，原图不受影响'), t('删除')))) return;
  try {
    await remote.deletePhotos(a.code, ids);
    store.selection.clear();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** 当前远程相册的管理菜单项：继续上传、从相册里删除（都只有创建者有）。删除整个相册先关掉了 */
function remoteItems(a: RemoteAlbum): MenuItem[] {
  const code = a.code;
  const owner = !!a.ownerToken;
  const sel = starTargets();
  return [
    ...(owner
      ? [
          uploadingCode() === code
            ? { label: t('停止上传'), action: () => stopUpload() }
            : { label: t('继续上传'), detail: a.sourceDir ? baseName(a.sourceDir) : '', action: () => void continueUpload(a, progress) },
          {
            label: t('从相册里删除'),
            detail: sel.length ? t('{n} 张', { n: sel.length }) : '',
            disabled: !sel.length,
            action: () => void deleteFromAlbum(a, sel),
          },
        ]
      : []),
  ];
}

/** 从本机列表拿掉；正开着它就退回本地工作目录（网页版退回欢迎页） */
async function forgetRemote(code: string): Promise<void> {
  const wasActive = remote.active === code;
  remote.forget(code);
  if (!wasActive) return;
  const lib = await api.localLibrary().catch(() => ({ workdir: null, recent: [], missing: [], folders: [] }) as Library);
  applyWorkdir(lib);
  await openInitialView(lib);
}

/** 重新从服务器拉一遍当前远程相册 */
async function reloadRemote(): Promise<void> {
  const code = remote.active;
  if (!code) return;
  try {
    await remote.fetch(code);
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), 'error');
  }
  setLibrary(remote.libraryFromCache(code));
  await reloadRemoteView();
}

let reloadTimer = 0;
/** 别人的改动推过来了：更新界面 */
function onRemoteEvent(code: string, ev: RemoteEvent): void {
  if (code !== remote.active) return;
  if (ev.type === 'stars') {
    const ids = new Set(ev.ids);
    for (const p of store.all) {
      if (p.remote?.code === code && ids.has(p.remote.id)) {
        p.starred = ev.starred;
        p.starredBy = ev.starred ? ev.by : null;
      }
    }
    setLibrary(remote.libraryFromCache(code)); // 侧栏星标数
    grid.refreshCells();
    viewer.refreshStar();
    updateStatus();
    // 星标筛选下别人取消了星：照片消失（看大图时先不动）
    if (isStarMode(store.view) && !viewer.opened && !ev.starred) {
      store.refilter();
      grid.reset(true);
      renderEmpty();
      updateStatus();
    }
  } else if (ev.type === 'comment' || ev.type === 'comment_deleted') {
    if (ev.type === 'comment') notifyComment(code, ev.comment);
    // 留言数显示在格子上，看大图时留言列表跟着刷新
    for (const p of store.all)
      if (p.remote?.code === code) {
        p.comments = remote.commentCount(code, p.remote.id);
        p.unread = remote.unreadCount(code, p.remote.id);
      }
    grid.refreshCells();
    viewer.refreshComments();
  } else if (ev.type === 'presence') {
    renderTitle();
  } else if (ev.type === 'album') {
    setLibrary(remote.libraryFromCache(code));
    renderTitle();
  } else if (ev.type === 'gone') {
    toast(t('远程相册「{name}」已被创建者删除', { name: remote.get(code)?.name ?? code }), 'warn', 5000);
    void forgetRemote(code);
  } else {
    // 新传了照片 / 删了照片 / 重连：攒一下再整体刷新（上传时每秒好几张）
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      if (ev.type === 'reload') return void reloadRemote();
      setLibrary(remote.libraryFromCache(code));
      if (!viewer.opened) void reloadRemoteView();
    }, 600);
  }
}

async function reloadRemoteView(): Promise<void> {
  const v = store.view;
  if (viewer.opened) return;
  if (v.kind === 'none' || (v.kind === 'folder' && !store.folder(v.path))) return void openInitialView(store.library);
  const seq = viewSeq;
  try {
    const photos = v.kind === 'starred' ? await api.listStarred() : await api.listFolder(v.path);
    if (seq !== viewSeq || viewer.opened) return;
    store.all = photos;
    chain = v.kind === 'folder' ? [v.path] : [];
    chainEnded = chainStartEnded = false;
    store.refilter();
    grid.reset(true);
    renderChrome();
  } catch {
    /* 下次再说 */
  }
}

remote.onEvent(onRemoteEvent);

shareBtn.addEventListener('click', () => {
  const a = remote.active ? remote.get(remote.active) : undefined;
  if (a) showShare(a);
});

// ---------- 窄屏（手机）：侧栏是抽屉 ----------

const menuBtn = $<HTMLButtonElement>('btn-menu');
function closeDrawer(): void {
  document.body.classList.remove('drawer-open');
}
menuBtn.addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('drawer-mask').addEventListener('click', closeDrawer);
$('sidebar').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.sb-item')) closeDrawer();
});

// 粘贴链接 = 连接远程相册（在没有输入框获得焦点时）
document.addEventListener('paste', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text') ?? '';
  if (parseShareInput(text, '') && /\/r\//.test(text)) void connectAndOpen(text);
});

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
      if (!$('export-dialog').querySelector('.help, .remote-dlg')) return;
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
  else if (mod && k.toLowerCase() === 'e') isTauri && openExportDialog(onMoved);
  else if (mod && k.toLowerCase() === 'f') search.focus();
  else if (mod && k.toLowerCase() === 'o') isTauri && void chooseWorkdir();
  else if (mod && k === ',') showSettings();
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
  titleEl.innerHTML = `<span class="dim">${t('正在扫描…')}</span>`;
  let lib: Library;
  try {
    lib = await api.getLibrary().catch((e) => {
      if (!remote.active) throw e;
      // 上次开着的远程相册连不上（断网、被删）：先回本地工作目录
      toast(e instanceof Error ? e.message : String(e), 'warn', 5000);
      remote.activate(null);
      return api.localLibrary();
    });
  } catch (e) {
    toast(t('读取工作目录失败：{e}', { e: String(e) }), 'error', 6000);
    return;
  }
  // 通过 /r/<相册码> 打开（网页版）：自动连上并打开这个相册
  const m = location.pathname.slice(import.meta.env.BASE_URL.length - 1).match(/^\/r\/([0-9A-Za-z]{4,32})/);
  if (m) {
    const ok = await connectAndOpen(`${SERVER}/r/${m[1]}`);
    history.replaceState(null, '', import.meta.env.BASE_URL);
    if (ok) return;
  }
  if (remote.active) remote.activate(remote.active); // 挂上实时通道
  setLibrary(lib);
  await openInitialView(lib);
  // 上次开着的远程相册（网页版打开过链接后，地址就变回首页了，再进来走的是这里）
  if (remote.active) notifyUnreadOnOpen(remote.active);
  gridEl.focus({ preventScroll: true });
}

void boot();

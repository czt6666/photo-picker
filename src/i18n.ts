// 多语言：简体中文 + English。不用库，两张表加一个 t()。
//
// 默认跟随系统语言（中文系统显示中文，其它显示英文），也可以在快捷键面板（?）里手动选，记在本地偏好里。
// 切换语言时整页重新载入：界面是手写 DOM，到处都有拼好的文字，重载最省事也最不容易漏。
//
// 写文案的规矩：短。按钮和提示只说“做什么 + 快捷键”，不解释原理。

import { prefs } from './store';

export type Lang = 'zh' | 'en';
export type LangPref = Lang | 'auto';

const zh = {
  // 顶栏 / 状态栏
  'wd.choose': '选择工作目录…',
  'wd.btnTitle': '工作目录：{path}（{key}）',
  'wd.btnTitleNone': '选择工作目录（{key}）',
  'wd.dialogTitle': '选择工作目录',
  'rescan.title': '重新扫描',
  'search.ph': '搜索文件名',
  'help.btnTitle': '快捷键（?）',
  'resizer.title': '拖动调整宽度，双击复原',
  'star.title': '星标（空格）',
  'star.add': '☆ 加星标',
  'star.remove': '★ 取消星标',
  'zoom.title': '缩略图大小',
  'export.btn': '导出…',
  'export.btnTitle': '导出（{key}）',
  'drop.hint': '松开以打开这个文件夹',

  // 看大图
  'v.back': '← 图库',
  'v.backTitle': '返回（Esc）',
  'v.zoomTitle': '1:1（Z 或双击）',
  'v.rateTitle': '星级（1～5，0 清除）',
  'v.star': '☆ 星标',
  'v.starred': '★ 已加星标',
  'v.fullTitle': '全屏（F）',
  'v.error': '无法显示这张照片',

  // 标题 / 状态
  'title.starOnly': '仅星标',
  'title.starred': '已加星标的照片',
  'title.starredSub': '所有相册',
  'boot.scanning': '正在扫描…',
  'boot.fail': '读取工作目录失败：{e}',
  'count.photos': '{n} 张',
  'status.count': '{n} 张照片',
  'status.selected': '已选 {n} 张（{size}）',
  'status.thumbs': '正在生成缩略图 {done} / {total}',
  'scan.progress': '正在扫描 {name} …',

  // 空状态
  'empty.noWd.h': '先选择一个工作目录',
  'empty.noWd.p': '它下面含照片的子文件夹会作为相册列在左侧。也可以把文件夹拖进窗口。',
  'empty.noPhotos.h': '这个目录下没有照片',
  'empty.noPhotos.btn': '换一个工作目录…',
  'empty.pick': '从左侧选择一个相册',
  'empty.noStar.h': '还没有星标照片',
  'empty.noStar.p': '按 <kbd>空格</kbd> 加星标',
  'empty.albumNoStar': '这个相册里没有星标照片',
  'empty.albumNoStar.p': '按 <kbd>Shift</kbd>+<kbd>S</kbd> 关闭星标筛选',
  'empty.noMatch': '没有文件名包含“{q}”的照片',
  'empty.folder': '这个文件夹里没有照片',

  // 提示条
  'err.read': '读取失败：{e}',
  'star.fallback': '文件夹不可写，星标已存到本机',
  'star.fail': '星标保存失败：{e}',
  'rate.fallback': '文件夹不可写，星级已存到本机',
  'rate.fail': '星级保存失败：{e}',
  'export.closeFirst': '请先关闭导出对话框',
  'wd.missing': '找不到 {path}',
  'wd.openFail': '无法打开：{e}',
  'wd.found': '{albums} 个相册，{photos} 张照片',
  'rescan.toast': '正在重新扫描…',

  // 菜单
  'menu.recent': '最近',
  'menu.offline': '{name}（未连接）',
  'menu.forget': '移除未连接的目录',
  'menu.open': '查看大图',
  'menu.star': '加星标',
  'menu.unstar': '取消星标',
  'reveal.mac': '在访达中显示',
  'reveal.win': '在资源管理器中显示',

  // 侧栏
  'sb.starHintOn': '关闭星标筛选（Shift+S）',
  'sb.starHintOff': '只看星标照片（Shift+S）',
  'sb.head': '工作目录',
  'sb.headNote': '· 仅有星标的相册',
  'sb.counts': '{albums} 个相册 · {photos} 张',
  'sb.groupCount': '{n} 个',
  'sb.filterPh': '筛选相册',
  'sb.fold': '全部折叠',
  'sb.unfold': '全部展开',
  'sb.none': '没有找到照片',
  'sb.noMatch': '没有包含“{q}”的相册',
  'sb.noStarAlbums': '还没有带星标的相册',

  // 网格
  'grid.companions': '同名文件：{list}',
  'list.sep': '、',

  // 导出
  'ex.title': '导出照片',
  'ex.which': '导出哪些',
  'ex.viewStarred': '当前相册的星标',
  'ex.selected': '选中的',
  'ex.allStarred': '全部星标',
  'ex.to': '导出到',
  'ex.destPh': '选择文件夹',
  'ex.pick': '选择…',
  'ex.pickTitle': '选择导出文件夹',
  'ex.sub': '子文件夹',
  'ex.subPh': '可留空',
  'ex.subDefault': '{name} 精选',
  'ex.starredName': '星标',
  'ex.size': '尺寸',
  'ex.original': '原图',
  'ex.resizeEdge': '长边',
  'ex.resizeQuality': 'px · 质量',
  'ex.raw': '同时导出同名 RAW',
  'ex.cancel': '取消',
  'ex.go': '导出',
  'ex.stop': '停止',
  'ex.done': '完成',
  'ex.close': '关闭',
  'ex.wdChanged': '工作目录已切换，请重新打开',
  'ex.none': '没有可导出的照片',
  'ex.readFail': '读取星标照片失败：{e}',
  'ex.preparing': '准备导出 {n} 张…',
  'ex.resDone': '已导出 <b>{n}</b> 张',
  'ex.resStopped': '已停止，导出了 <b>{n}</b> 张',
  'ex.resFiles': '（{n} 个文件）',
  'ex.resFailed': '，{n} 个失败：{list}',
  'ex.fail': '导出失败：{e}',

  // 快捷键面板
  'help.title': '快捷键',
  'help.ok': '知道了',
  'help.lang': '语言',
  'lang.auto': '跟随系统',
  'help.library': '图库',
  'help.viewer': '看大图',
  'hk.arrows': '方向键 / Shift+方向键',
  'hd.arrows': '移动 / 连选',
  'hk.click': '{mod} 点击、Shift 点击',
  'hd.click': '多选 / 范围选择',
  'hd.selectAll': '全选当前相册',
  'hk.open': '回车、双击',
  'hd.open': '看大图',
  'hk.scroll': '一直往下滚',
  'hd.scroll': '接着看下一个相册',
  'hk.star': '空格（或 S、{key}）',
  'hd.star': '星标（相当于 Lightroom 的“选取”）',
  'hk.rate': '1 ～ 5、0',
  'hd.rate': '星级 / 清除',
  'hd.starFilter': '星标筛选',
  'hd.export': '导出',
  'hd.search': '搜索',
  'hd.workdir': '切换工作目录',
  'hk.pinch': '捏合 / {mod}+滚轮',
  'hd.thumbSize': '缩略图大小',
  'hk.page': '滚轮、← →',
  'hd.page': '上一张 / 下一张',
  'hk.actual': 'Z、双击',
  'hd.actual': '1:1 ↔ 适合窗口',
  'hd.zoom': '缩放（翻页时保持）',
  'hk.pan': '拖动 / {alt}+滚动',
  'hd.pan': '平移',
  'hd.full': '全屏',
  'hd.back': '返回图库',
};

export type Key = keyof typeof zh;

const en: Record<Key, string> = {
  'wd.choose': 'Choose folder…',
  'wd.btnTitle': 'Working folder: {path} ({key})',
  'wd.btnTitleNone': 'Choose a working folder ({key})',
  'wd.dialogTitle': 'Choose a working folder',
  'rescan.title': 'Rescan',
  'search.ph': 'Search file names',
  'help.btnTitle': 'Shortcuts (?)',
  'resizer.title': 'Drag to resize, double-click to reset',
  'star.title': 'Star (Space)',
  'star.add': '☆ Star',
  'star.remove': '★ Unstar',
  'zoom.title': 'Thumbnail size',
  'export.btn': 'Export…',
  'export.btnTitle': 'Export ({key})',
  'drop.hint': 'Drop to open this folder',

  'v.back': '← Library',
  'v.backTitle': 'Back (Esc)',
  'v.zoomTitle': '1:1 (Z or double-click)',
  'v.rateTitle': 'Rating (1–5, 0 clears)',
  'v.star': '☆ Star',
  'v.starred': '★ Starred',
  'v.fullTitle': 'Full screen (F)',
  'v.error': 'Can’t display this photo',

  'title.starOnly': 'Starred only',
  'title.starred': 'Starred photos',
  'title.starredSub': 'All albums',
  'boot.scanning': 'Scanning…',
  'boot.fail': 'Couldn’t load the working folder: {e}',
  'count.photos': '{n} photo{s:n}',
  'status.count': '{n} photo{s:n}',
  'status.selected': '{n} selected ({size})',
  'status.thumbs': 'Generating thumbnails {done} / {total}',
  'scan.progress': 'Scanning {name}…',

  'empty.noWd.h': 'Choose a working folder',
  'empty.noWd.p': 'Its subfolders with photos show up as albums on the left. You can also drop a folder here.',
  'empty.noPhotos.h': 'No photos in this folder',
  'empty.noPhotos.btn': 'Choose another folder…',
  'empty.pick': 'Pick an album on the left',
  'empty.noStar.h': 'No starred photos yet',
  'empty.noStar.p': 'Press <kbd>Space</kbd> to star a photo',
  'empty.albumNoStar': 'No starred photos in this album',
  'empty.albumNoStar.p': 'Press <kbd>Shift</kbd>+<kbd>S</kbd> to turn the star filter off',
  'empty.noMatch': 'No photos match “{q}”',
  'empty.folder': 'No photos in this folder',

  'err.read': 'Couldn’t load: {e}',
  'star.fallback': 'Folder is read-only; stars saved on this computer',
  'star.fail': 'Couldn’t save the star: {e}',
  'rate.fallback': 'Folder is read-only; ratings saved on this computer',
  'rate.fail': 'Couldn’t save the rating: {e}',
  'export.closeFirst': 'Close the export dialog first',
  'wd.missing': 'Can’t find {path}',
  'wd.openFail': 'Couldn’t open: {e}',
  'wd.found': '{albums} album{s:albums}, {photos} photo{s:photos}',
  'rescan.toast': 'Rescanning…',

  'menu.recent': 'Recent',
  'menu.offline': '{name} (offline)',
  'menu.forget': 'Remove offline folders',
  'menu.open': 'Open',
  'menu.star': 'Star',
  'menu.unstar': 'Unstar',
  'reveal.mac': 'Show in Finder',
  'reveal.win': 'Show in Explorer',

  'sb.starHintOn': 'Turn the star filter off (Shift+S)',
  'sb.starHintOff': 'Show starred only (Shift+S)',
  'sb.head': 'Working folder',
  'sb.headNote': '· starred albums only',
  'sb.counts': '{albums} album{s:albums} · {photos} photo{s:photos}',
  'sb.groupCount': '{n}',
  'sb.filterPh': 'Filter albums',
  'sb.fold': 'Collapse all',
  'sb.unfold': 'Expand all',
  'sb.none': 'No photos found',
  'sb.noMatch': 'No albums match “{q}”',
  'sb.noStarAlbums': 'No starred albums yet',

  'grid.companions': 'Also: {list}',
  'list.sep': ', ',

  'ex.title': 'Export photos',
  'ex.which': 'Photos',
  'ex.viewStarred': 'Starred in this album',
  'ex.selected': 'Selected',
  'ex.allStarred': 'All starred',
  'ex.to': 'Destination',
  'ex.destPh': 'Choose a folder',
  'ex.pick': 'Choose…',
  'ex.pickTitle': 'Choose export folder',
  'ex.sub': 'Subfolder',
  'ex.subPh': 'Optional',
  'ex.subDefault': '{name} picks',
  'ex.starredName': 'Starred',
  'ex.size': 'Size',
  'ex.original': 'Original',
  'ex.resizeEdge': 'Long edge',
  'ex.resizeQuality': 'px · quality',
  'ex.raw': 'Include matching RAW files',
  'ex.cancel': 'Cancel',
  'ex.go': 'Export',
  'ex.stop': 'Stop',
  'ex.done': 'Done',
  'ex.close': 'Close',
  'ex.wdChanged': 'Working folder changed. Reopen export.',
  'ex.none': 'Nothing to export',
  'ex.readFail': 'Couldn’t load starred photos: {e}',
  'ex.preparing': 'Preparing {n} photo{s:n}…',
  'ex.resDone': 'Exported <b>{n}</b> photo{s:n}',
  'ex.resStopped': 'Stopped. Exported <b>{n}</b> photo{s:n}',
  'ex.resFiles': ' ({n} files)',
  'ex.resFailed': ', {n} failed: {list}',
  'ex.fail': 'Export failed: {e}',

  'help.title': 'Shortcuts',
  'help.ok': 'OK',
  'help.lang': 'Language',
  'lang.auto': 'System',
  'help.library': 'Library',
  'help.viewer': 'Viewer',
  'hk.arrows': 'Arrows / Shift+Arrows',
  'hd.arrows': 'Move / extend selection',
  'hk.click': '{mod}-click, Shift-click',
  'hd.click': 'Toggle / range select',
  'hd.selectAll': 'Select the whole album',
  'hk.open': 'Enter, double-click',
  'hd.open': 'Open photo',
  'hk.scroll': 'Keep scrolling',
  'hd.scroll': 'Next album',
  'hk.star': 'Space (or S, {key})',
  'hd.star': 'Star (like a Lightroom pick)',
  'hk.rate': '1–5, 0',
  'hd.rate': 'Rating / clear',
  'hd.starFilter': 'Star filter',
  'hd.export': 'Export',
  'hd.search': 'Search',
  'hd.workdir': 'Change working folder',
  'hk.pinch': 'Pinch / {mod}+scroll',
  'hd.thumbSize': 'Thumbnail size',
  'hk.page': 'Scroll, ← →',
  'hd.page': 'Previous / next',
  'hk.actual': 'Z, double-click',
  'hd.actual': '1:1 ↔ fit',
  'hd.zoom': 'Zoom (kept while paging)',
  'hk.pan': 'Drag / {alt}+scroll',
  'hd.pan': 'Pan',
  'hd.full': 'Full screen',
  'hd.back': 'Back to library',
};

const TABLES: Record<Lang, Record<Key, string>> = { zh, en };

/** 系统语言 → 我们支持的语言：中文系统用中文，其它一律英文 */
export function detectLang(system: string | undefined): Lang {
  return (system ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function langPref(): LangPref {
  const v = prefs.get<LangPref>('lang', 'auto');
  return v === 'zh' || v === 'en' ? v : 'auto';
}

const pref = langPref();
let current: Lang = pref === 'auto' ? detectLang(typeof navigator === 'undefined' ? undefined : navigator.language) : pref;

export const lang = (): Lang => current;

/** 换语言（记住选择），然后整页重新载入 */
export function setLangPref(p: LangPref): void {
  prefs.set('lang', p);
  location.reload();
}

/** 把模板里的 {name} 换成变量；{s:name} 是英文复数的 s（变量为 1 时不加） */
export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(s:)?(\w+)\}/g, (whole, plural: string | undefined, name: string) => {
    if (!(name in vars)) return whole;
    if (plural) return Number(vars[name]) === 1 ? '' : 's';
    return String(vars[name]);
  });
}

/** 取当前语言的文案。有些文案带 HTML（<kbd>、<b>），往里填用户输入之前要自己转义。 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  return format(TABLES[current][key] ?? zh[key] ?? key, vars);
}

/** 测试用：直接指定语言 */
export function useLang(l: Lang): void {
  current = l;
}

/**
 * 把 index.html 里写死的文字换成当前语言：
 * data-i18n = 文字，data-i18n-title = 悬停提示，data-i18n-ph = 输入框占位文字。
 */
export function applyStatic(root: ParentNode = document): void {
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle as Key)));
  root
    .querySelectorAll<HTMLInputElement>('[data-i18n-ph]')
    .forEach((el) => (el.placeholder = t(el.dataset.i18nPh as Key)));
}

// 界面文字的中 / 英切换。
//
// 做法很简单：代码里直接写中文原文，外面包一层 t()。中文界面原样返回；英文界面拿中文原文去
// 英文表里查。好处是代码读起来还是中文，不用另起一套 key 名；漏翻的字会退回中文，不会显示空白。
// 带变量的句子用 {名字} 占位：t('找到 {n} 个相册', { n: 3 })。
// 换语言时整页重新载入（视图、宽度等都记在偏好里，载入后回到原样），省得每块界面各自重绘。

import { prefs } from './store';

export type Lang = 'zh' | 'en';

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
];

const systemLang = (): Lang => (/^zh\b/i.test(navigator.language || '') ? 'zh' : 'en');

/** 用户在设置里选的语言；null = 跟随系统 */
export const langPref: Lang | null = prefs.get<Lang | null>('lang', null);
export const lang: Lang = langPref ?? systemLang();

export function setLang(l: Lang | null): void {
  if (l === langPref) return;
  prefs.set('lang', l);
  location.reload();
}

type Vars = Record<string, string | number>;

export function t(zh: string, vars?: Vars): string {
  const s = lang === 'en' ? (EN[zh] ?? zh) : zh;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 把 index.html 里写死的中文（文字、title、placeholder）换成当前语言 */
export function translateDom(root: ParentNode): void {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (lang === 'zh') return;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue ?? '';
    const key = raw.trim();
    if (key && EN[key]) n.nodeValue = raw.replace(key, EN[key]);
  }
  root.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]').forEach((el) => {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && EN[v]) el.setAttribute(a, EN[v]);
    }
  });
}

/** 中文原文 → 英文。tests/unit/i18n.test.ts 会检查代码里每个 t('…') 都在这里 */
export const EN: Record<string, string> = {
  // ---- 顶栏 / 状态栏 / 看图器按钮（index.html） ----
  选片: 'Photo Picker',
  '📁 选择工作目录': '📁 Choose folder',
  重新扫描: 'Rescan',
  搜索文件名: 'Search file names',
  '快捷键（?）': 'Shortcuts (?)',
  '拖动调整宽度，双击还原': 'Drag to resize, double-click to reset',
  '☆ 星标': '☆ Star',
  '★ 已加星标': '★ Starred',
  '星标（空格）': 'Star (Space)',
  缩略图大小: 'Thumbnail size',
  '导出': 'Export',
  '← 图库': '← Library',
  '返回（Esc）': 'Back (Esc)',
  '星级（1～5，0 清除）': 'Rating (1–5, 0 clears)',
  '全屏（F）': 'Full screen (F)',

  // ---- 侧栏 ----
  已加星标的照片: 'Starred',
  '星标筛选（Shift+S）': 'Star filter (Shift+S)',
  '关闭星标筛选（Shift+S）': 'Turn off star filter (Shift+S)',
  工作目录: 'Folder',
  '· 只列有星标的': '· starred only',
  '{path}\n点击切换': '{path}\nClick to switch',
  '{n} 个相册 · {m} 张': '{n} albums · {m} photos',
  '{n} 个': '{n}',
  筛选相册: 'Filter albums',
  全部折叠: 'Collapse all',
  全部展开: 'Expand all',
  没有照片: 'No photos',
  '没有匹配“{q}”的相册': 'No albums match “{q}”',
  没有带星标的相册: 'No starred albums',

  // ---- 视图标题 / 空状态 ----
  仅星标: 'starred only',
  所有相册: 'all albums',
  选择一个照片文件夹: 'Choose a photo folder',
  "子文件夹会列成相册，也能直接拖进来。": "Subfolders become albums. Or drop a folder here.",
  '选择文件夹': 'Choose folder',
  这里没有找到照片: 'No photos found here',
  '换一个文件夹': 'Choose another folder',
  从左侧选择一个相册: 'Pick an album on the left',
  还没有星标: 'Nothing starred yet',
  '按 {key} 加星标': 'Press {key} to star',
  这个相册没有星标照片: 'No starred photos in this album',
  '按 {key} 取消筛选': 'Press {key} to turn off the filter',
  '没有匹配“{q}”的照片': 'No photos match “{q}”',
  空格: 'Space',

  // ---- 状态栏 ----
  '{n} 张照片': '{n} photos',
  '已选 {n} 张（{size}）': '{n} selected ({size})',
  '★ 取消星标': '★ Unstar',
  '☆ 加星标': '☆ Star',
  '正在生成缩略图 {done} / {total}': 'Making thumbnails {done} / {total}',
  '正在扫描…': 'Scanning…',

  // ---- 网格 ----
  '{n} 张': '{n}',
  '{name}\n同名文件：{files}': '{name}\nAlso: {files}',

  // ---- 提示 ----
  '读取失败：{e}': 'Could not read: {e}',
  '文件夹不可写，星标已存到本机': 'Folder is read-only; star saved on this computer',
  '文件夹不可写，星级已存到本机': 'Folder is read-only; rating saved on this computer',
  '星标保存失败：{e}': 'Could not save star: {e}',
  '星级保存失败：{e}': 'Could not save rating: {e}',
  选择照片文件夹: 'Choose a photo folder',
  请先关闭导出对话框: 'Close the export dialog first',
  '正在扫描 {name}…': 'Scanning {name}…',
  '找不到 {path}，移动硬盘没接上？': 'Can’t find {path}. Is the drive connected?',
  '打不开：{e}': 'Can’t open: {e}',
  '{n} 个相册，{m} 张照片': '{n} albums, {m} photos',
  '读取工作目录失败：{e}': 'Could not read folder: {e}',
  无法显示这张照片: 'Can’t display this photo',

  // ---- 菜单 ----
  最近: 'Recent',
  '{name}（未连接）': '{name} (not connected)',
  移除未连接的: 'Remove disconnected',
  查看大图: 'View',
  取消星标: 'Unstar',
  加星标: 'Star',
  在访达中显示: 'Show in Finder',
  在资源管理器中显示: 'Show in Explorer',
  语言: 'Language',
  设置: 'Settings',
  跟随系统: 'System',

  // ---- 快捷键帮助 ----
  快捷键: 'Shortcuts',
  图库: 'Library',
  方向键: 'Arrows',
  '移动；按住 Shift 连选': 'Move; hold Shift to extend',
  '{mod} / Shift 点击': '{mod} / Shift click',
  '多选 / 连选': 'Add / range select',
  全选: 'Select all',
  '回车、双击': 'Enter, double-click',
  看大图: 'View',
  '星标（选取）': 'Star (pick)',
  '1～5、0': '1–5, 0',
  '星级；0 清除': 'Rating; 0 clears',
  星标筛选: 'Star filter',
  '选择 / 切换文件夹': 'Choose / switch folder',
  '捏合、{mod}+滚轮': 'Pinch, {mod}+scroll',
  看大图时: 'Viewer',
  '滚轮、← →': 'Scroll, ← →',
  '上一张 / 下一张': 'Previous / next',
  'Z、双击': 'Z, double-click',
  '1:1 / 适合窗口': '1:1 / fit',
  缩放: 'Zoom',
  '{alt}+滚动、拖动': '{alt}+scroll, drag',
  '平移（翻页时保持）': 'Pan (kept when flipping)',
  全屏: 'Full screen',
  返回: 'Back',
  知道了: 'OK',

  // ---- 导出 ----
  导出照片: 'Export photos',
  '导入清单…': 'Import picks…',
  '把在线选片导出的清单对回本机原图，加上星标': 'Match a pick list from online picking to your originals and star them',
  导入选片清单: 'Import pick list',
  '在线选片下载的 .txt，或粘贴文件名（空格、逗号、换行隔开都行）。对上的原图会加星标。':
    'The .txt from online picking, or pasted file names (separated by spaces, commas or lines). Matching originals get starred.',
  '选择文件…': 'Choose file…',
  请先选择工作目录: 'Choose a folder first',
  '一张都没对上：请先打开这次拍摄的文件夹': 'No matches. Open the shoot folder first.',
  '已给 {n} 张加星标': 'Starred {n}',
  '，{n} 个没找到：{names}': ', {n} not found: {names}',
  '（{n} 个文件名在多个文件夹里都有，都标上了）': ' ({n} names exist in several folders; all starred)',
  选片清单: 'Pick list',
  范围: 'Photos',
  当前相册的星标: 'Starred in this album',
  星标照片: 'Starred photos',
  选中的: 'Selected',
  导出到: 'To',
  '选择': 'Choose',
  子文件夹: 'Subfolder',
  可留空: 'optional',
  '{name} 精选': '{name} picks',
  带上同名的: 'Include matching',
  取消: 'Cancel',
  选择导出文件夹: 'Choose export folder',
  '工作目录已切换，请重新打开': 'Folder changed. Reopen this dialog.',
  没有可导出的照片: 'Nothing to export',
  停止: 'Stop',
  '准备导出 {n} 张…': 'Preparing {n}…',
  '已导出 {n} 张': 'Exported {n}',
  '已停止，导出了 {n} 张': 'Stopped after {n}',
  '（{n} 个文件，含 RAW）': ' ({n} files incl. RAW)',
  '，{n} 个失败：{list}': ', {n} failed: {list}',
  完成: 'Done',
  '导出失败：{e}': 'Export failed: {e}',
  关闭: 'Close',
  // ---- 远程相册 ----
  "JPEG 编码失败": "JPEG encoding failed",
  "PhotoPicker 网页版": "PhotoPicker on the web",
  "RAW 里没有可用的预览图，请同时选上同名 JPG": "No usable preview inside this RAW. Add the matching JPG too.",
  "这个浏览器打不开 HEIC，请用 Safari 或先转成 JPG": "This browser can't open HEIC. Use Safari or convert to JPG.",
  "图片解不开，文件可能损坏": "Can't decode this image. The file may be damaged.",
  "上传到「{name}」{done} / {total}": "Uploading to “{name}” {done} / {total}",
  "从列表中移除": "Remove from list",
  "传完了，{n} 张失败：{names}": "Upload done, {n} failed: {names}",
  "传完了：{n} 张": "Uploaded {n}",
  "停止上传": "Stop upload",
  "共享为远程相册": "Share as remote album",
  "创建密码": "Create password",
  "创建并上传": "Create & upload",
  "创建远程相册": "Create remote album",
  "删除": "Delete",
  "删除远程相册": "Delete remote album",
  "删除远程相册「{name}」？": "Delete remote album “{name}”?",
  "匿名": "Anonymous",
  "在看：{names}": "Viewing: {names}",
  "复制链接": "Copy link",
  "好": "OK",
  "已停止，传了 {n} 张，可接着传": "Stopped at {n}. You can resume.",
  "已选 {n} 个文件": "{n} files selected",
  "打开链接一起挑，或传照片发给别人。": "Open a shared link, or upload photos to share.",
  "找到 {n} 个相册": "Found {n} albums",
  "把相册共享出去，拿到链接的人都能一起挑": "Share an album. Anyone with the link can pick.",
  "拿到链接的人都能打开、一起加星标。只上传压缩预览（约 0.4MB/张），原图留在你电脑上。": "Anyone with the link can open it and star photos. Only compressed previews (~0.4 MB each) are uploaded; originals stay on your computer.",
  "改名": "Rename",
  "服务器": "Server",
  "线上图片和星标都会删掉，原图不受影响": "Online photos and stars are deleted. Originals stay.",
  "本机没找到原图": "Original not found on this computer",
  "正在上传，稍等": "Uploading, please wait",
  "没找到能用的照片": "No usable photos found",
  "没有连接这个远程相册": "Not connected to this remote album",
  "照片": "Photos",
  "相册": "Albums",
  "相册名": "Album name",
  "继续上传": "Continue upload",
  "网页版没有这个功能，请用桌面版": "Not available on the web. Use the desktop app.",
  "认不出这个链接或相册码": "Unrecognized link or album code",
  "请填写服务器地址，如 https://photo.example.com": "Enter the server address, e.g. https://photo.example.com",
  "请选择照片": "Choose photos",
  "请选择要共享的文件夹": "Choose a folder to share",
  "这些照片都已经传过了": "These photos are already uploaded",
  "需要创建密码，问问管理员": "A password is needed. Ask the admin.",
  "远程相册": "Remote albums",
  "远程相册「{name}」已被创建者删除": "Remote album “{name}” was deleted by its creator",
  "远程相册不支持星级": "No ratings in remote albums",
  "连不上服务器 {server}": "Can't reach server {server}",
  "连接": "Connect",
  "连接远程相册": "Connect remote album",
  "连接远程相册（粘贴链接）": "Connect remote album (paste link)",
  "选择照片": "Choose photos",
  "选择要共享的相册文件夹": "Choose the album folder to share",
  "链接已复制，发给别人就能一起挑": "Link copied. Send it to pick together.",
  "链接或相册码": "Link or album code",
  "，{n} 张失败": ", {n} failed",
  "☁ 打开远程相册": "☁ Open remote album",
  "先选一个本地工作目录": "Choose a local folder first",
  "分享": "Share",
  "分享「{name}」": "Share “{name}”",
  "刷新": "Refresh",
  "已复制 ✓": "Copied ✓",
  "打开链接就能一起挑，星标实时同步。": "Open the link to pick together. Stars sync live.",
  "发送": "Send",
  "删除该相册": "Delete this album",
  "从相册里删除": "Delete from album",
  "点一下改名字": "Click to change your name",
  "有人留言": "New comment",
  "有 {n} 条新留言": "{n} new comments",
  "点一下从最早的一条开始看": "Tap to start from the earliest",
  "不填就随机起一个": "Leave empty for a random one",
  "下载失败，检查一下网络": "Download failed. Check your connection.",
  "下载（长边 1600 像素）": "Download (1600 px)",
  "下载": "Download",
  "从相册里删除 {n} 张照片？": "Delete {n} photos from the album?",
  "先选中要删的照片": "Select photos to delete first",
  "移除": "Remove",
  "从列表中移除「{name}」？": "Remove “{name}” from the list?",
  "只是不在这台设备上显示，线上相册还在": "It only disappears from this device. The online album stays.",
  "只是不在这台设备上显示，以后打开链接还能再连上": "It only disappears from this device. Open the link again to reconnect.",
  "线上图片、星标和留言都会删掉，原图不受影响": "Online photos, stars and comments are deleted. Originals stay.",
  "留言": "Comments",
  "写留言，大家都能看到": "Write a comment, everyone can see it",
  "还没有留言": "No comments yet",
  "刚刚": "just now",
  "{n} 分钟前": "{n} min ago",
  "{n} 小时前": "{n} h ago",
  "{m}月{d}日 {hm}": "{m}/{d} {hm}",
  "方式": "Method",
  "移动": "Move",
  "复制": "Copy",
  "原位置不再保留": "removed from the original place",
  "已移动 {n} 张": "Moved {n}",
  "已停止，移动了 {n} 张": "Stopped, moved {n}",
  "打开远程相册": "Open remote album",
  "星标": "Star",
  "信息": "Info",
  "把链接发给别人一起挑": "Send the link to pick together",
  "只传小图，原图和 RAW 留在本机": "Only small copies upload. Originals and RAW stay here.",
  "点击切换": "Click to switch",
  "远程相册 · 点击切换": "Remote album · click to switch",
  "选择工作目录": "Choose folder",
  "打开文件夹": "Open folder",
  "更改": "Change",
  "正在创建": "Creating",
  "正在准备": "Preparing",
  "上传到「{name}」": "Uploading to “{name}”",
  "{done} / {total} 张": "{done} / {total}",
  "选择要共享的文件夹": "Choose a folder to share",
};

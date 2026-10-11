// 平台差异：快捷键怎么写、“在文件管理器中显示”叫什么。
// 键盘处理本身不用分平台——各处都认 metaKey || ctrlKey，Mac 上按 ⌘、Windows 上按 Ctrl 都行。

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 修饰键的写法：Mac 上 `⌘E`，Windows 上 `Ctrl+E` */
export const mod = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`);

/** 修饰键本身的名字，用在“⌘ 点击”“Ctrl+滚轮”这类说明里 */
export const MOD_NAME = isMac ? '⌘' : 'Ctrl';

export const REVEAL_LABEL = isMac ? '在访达中显示' : '在资源管理器中显示';

/**
 * Windows 的 WebView2 自带一套浏览器快捷键：F5 / Ctrl+R 刷新整个页面（App 状态全丢）、
 * Ctrl+P 打印、Ctrl+G 查找下一个、Ctrl+H 历史、Ctrl+J 下载、Ctrl+U 查看源码、F7 光标浏览……
 * 对桌面 App 来说都是误触。在 keydown 里 preventDefault 就能拦下。
 */
export function isBrowserShortcut(e: KeyboardEvent): boolean {
  if (isMac) return false;
  const k = e.key.toLowerCase();
  if (k === 'f5' || k === 'f7' || k === 'browserback' || k === 'browserforward' || k === 'browserrefresh') return true;
  if (e.altKey && (k === 'arrowleft' || k === 'arrowright')) return true; // 后退 / 前进
  if (e.ctrlKey) return ['r', 'p', 'g', 'h', 'j', 'u', 's', 'd', 'n', 't', 'w'].includes(k) && !e.altKey;
  return false;
}

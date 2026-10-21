// 摄影师在这台设备上建过/打开过的相册，存在浏览器里，首页列出来方便回到管理页。

export interface SavedAlbum {
  token: string;
  name: string;
  at: number;
}

const KEY = 'pp-albums';

export function savedAlbums(): SavedAlbum[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function rememberAlbum(token: string, name: string) {
  const list = savedAlbums().filter((a) => a.token !== token);
  list.unshift({ token, name, at: Date.now() });
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* 存不了就算了 */
  }
}

export function forgetAlbum(token: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(savedAlbums().filter((a) => a.token !== token)));
  } catch {
    /* 同上 */
  }
}

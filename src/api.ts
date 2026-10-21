// 后端调用的薄封装。图片字节不走 IPC，而是拼成自定义协议 URL 直接给 <img>。
//
// 远程相册（路径以 `remote:` 开头）转给 remote.ts 走网络；网页版没有本地后端，只有远程相册。

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { isTauri } from './platform';
import { isRemotePath, parseRemotePath, remote } from './remote';
import type { CacheInfo, ExportRequest, ExportResult, Library, Photo, PhotoInfo, PickListMatch, SetStarResult } from './types';

const EMPTY_LIBRARY: Library = { workdir: null, recent: [], missing: [], folders: [] };

/** 网页版里调到本地功能：不该发生（界面上已经藏起来了），给个明白的错误 */
function local<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new Error(t('网页版没有这个功能，请用桌面版')));
  return invoke<T>(cmd, args);
}

const split = (paths: string[]) => ({ locals: paths.filter((p) => !isRemotePath(p)), remotes: paths.filter(isRemotePath) });

export const api = {
  /** 当前工作目录：打开的是远程相册就是它，否则是本地的 */
  getLibrary: () => (remote.active ? remote.library(remote.active) : api.localLibrary()),
  /** 本地工作目录（打开远程相册时，后端记的本地工作目录不变） */
  localLibrary: () => (isTauri ? invoke<Library>('get_library') : Promise.resolve({ ...EMPTY_LIBRARY })),
  rescan: () => local<Library>('rescan'),
  setWorkdir: (path: string) => local<Library>('set_workdir', { path }),
  forgetWorkdir: (path: string) => local<Library>('forget_workdir', { path }),
  listFolder: (path: string) => (isRemotePath(path) ? remote.list(path) : local<Photo[]>('list_folder', { path })),
  /** “已加星标的照片”：当前工作目录（本地或远程相册）里所有的星标照片 */
  listStarred: () => (remote.active ? remote.listStarred(remote.active) : local<Photo[]>('list_starred')),
  setStar: async (paths: string[], starred: boolean): Promise<SetStarResult> => {
    const { locals, remotes } = split(paths);
    const res: SetStarResult = locals.length ? await local<SetStarResult>('set_star', { paths: locals, starred }) : { fallback: false, folders: {} };
    if (remotes.length) Object.assign(res.folders, await remote.setStars(remotes, starred));
    return res;
  },
  /** 星级：0 = 清除，1～5。不动星标。返回 true = 文件夹不可写，存到了 App 数据目录 */
  setRating: (paths: string[], rating: number) => local<boolean>('set_rating', { paths: paths.filter((p) => !isRemotePath(p)), rating }),
  /** 选片清单（文本或文件路径）→ 本机对应照片 */
  matchPickList: (text: string | null, file: string | null) => local<PickListMatch>('match_pick_list', { text, file }),
  photoInfo: (path: string): Promise<PhotoInfo> => {
    if (!isRemotePath(path)) return local<PhotoInfo>('photo_info', { path });
    const p = remote.photoInfo(path);
    return Promise.resolve({ width: p?.width ?? 0, height: p?.height ?? 0, size: p?.size ?? 0, mtime: 0 });
  },
  prefetchThumbs: (paths: string[]) => {
    const locals = paths.filter((p) => !isRemotePath(p));
    return locals.length && isTauri ? invoke<void>('prefetch_thumbs', { paths: locals }) : Promise.resolve();
  },
  /** 桌面版把本地照片压成预览（JPEG 字节），上传到远程相册用 */
  renderPreview: (path: string, maxPx: number) => local<ArrayBuffer>('render_preview', { path, maxPx }),
  exportPhotos: async (request: ExportRequest): Promise<ExportResult> => {
    // 远程相册里只有预览，导出要对回摄影师电脑上的原图
    const { paths, missing } = await resolveOriginals(request.paths);
    const res: ExportResult = paths.length
      ? await local<ExportResult>('export_photos', { request: { ...request, paths } })
      : { exported: 0, files: 0, failed: [], dest: request.dest, cancelled: false };
    for (const name of missing) res.failed.push({ path: name, error: t('本机没找到原图') });
    return res;
  },
  cancelExport: () => local<void>('cancel_export'),
  cacheInfo: () => local<CacheInfo>('cache_info'),
  clearCache: () => local<void>('clear_cache'),
};

const sep = (dir: string) => (dir.includes('\\') && !dir.includes('/') ? '\\' : '/');

/**
 * 远程照片 → 本机原图路径。
 * 自己在这台电脑上创建的相册记得原图文件夹，直接拼路径；别人建的（或网页上传的）就按文件名在当前工作目录里找。
 */
async function resolveOriginals(paths: string[]): Promise<{ paths: string[]; missing: string[] }> {
  const { locals, remotes } = split(paths);
  const out = [...locals];
  const missing: string[] = [];
  const lookup: string[] = [];
  for (const p of remotes) {
    const info = remote.photoInfo(p);
    if (!info) continue;
    const a = remote.get(parseRemotePath(p).code);
    if (a?.sourceDir) {
      const s = sep(a.sourceDir);
      const parts = [a.sourceDir.replace(/[\\/]+$/, ''), ...info.folder.split('/').filter(Boolean), info.name];
      out.push(parts.join(s));
    } else {
      lookup.push(info.folder ? `${info.folder}/${info.name}` : info.name);
    }
  }
  if (lookup.length) {
    try {
      const m = await api.matchPickList(lookup.join('\n'), null);
      out.push(...m.paths);
      missing.push(...m.missing);
    } catch {
      missing.push(...lookup);
    }
  }
  return { paths: [...new Set(out)], missing };
}

/** 缩略图。本地：400px，mtime 进 URL（文件改了 URL 就变，webview 的图片缓存自然失效）；远程：400px 的预压缩缩略图 */
export function thumbUrl(p: Photo): string {
  if (p.remote) return `${p.remote.img}_t.jpg`;
  return `${convertFileSrc(p.path, 'thumb')}?v=${p.mtime}`;
}

/**
 * 看图用的图片。
 * @param max 长边上限（像素），0 = 原图
 * @param urgent 当前正在看的那张（后端插队）；预加载的相邻照片为 false
 * @param force 强制后端转码成 JPEG（webview 解不了原格式时的退路）
 * 远程照片只有一种：长边 1600 像素的预览图。
 */
export function photoUrl(p: Photo, max: number, urgent: boolean, force = false): string {
  if (p.remote) return `${p.remote.img}_p.jpg`;
  return `${convertFileSrc(p.path, 'photo')}?v=${p.mtime}&max=${max}&p=${urgent ? 0 : 1}${force ? '&force=1' : ''}`;
}

// 与 src-tauri/src/formats.rs 的 RAW 列表保持一致
export const RAW_EXT = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'rwl', 'pef',
  'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf', 'kdc', 'mrw', 'mos',
]);

export const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** webview 肯定解不了、需要后端转码的格式（远程照片都是 JPEG 预览） */
export function needsTranscode(p: Photo): boolean {
  return !p.remote && RAW_EXT.has(extOf(p.name));
}

/** 伴侣文件里的 RAW 扩展名（大写），用于角标，如 "CR3"；没有 RAW 伴侣返回 '' */
export function rawTag(p: Photo): string {
  const raw = p.companions.find((c) => RAW_EXT.has(extOf(c)));
  return raw ? extOf(raw).toUpperCase() : '';
}

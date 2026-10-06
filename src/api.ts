// 后端调用的薄封装。图片字节不走 IPC，而是拼成自定义协议 URL 直接给 <img>。

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { CacheInfo, ExportRequest, ExportResult, Library, Photo, PhotoInfo, SetStarResult } from './types';

export const api = {
  getLibrary: () => invoke<Library>('get_library'),
  rescan: () => invoke<Library>('rescan'),
  setWorkdir: (path: string) => invoke<Library>('set_workdir', { path }),
  forgetWorkdir: (path: string) => invoke<Library>('forget_workdir', { path }),
  listFolder: (path: string) => invoke<Photo[]>('list_folder', { path }),
  listStarred: () => invoke<Photo[]>('list_starred'),
  setStar: (paths: string[], starred: boolean) => invoke<SetStarResult>('set_star', { paths, starred }),
  photoInfo: (path: string) => invoke<PhotoInfo>('photo_info', { path }),
  prefetchThumbs: (paths: string[]) => invoke<void>('prefetch_thumbs', { paths }),
  exportPhotos: (request: ExportRequest) => invoke<ExportResult>('export_photos', { request }),
  cancelExport: () => invoke<void>('cancel_export'),
  cacheInfo: () => invoke<CacheInfo>('cache_info'),
  clearCache: () => invoke<void>('clear_cache'),
};

/** 400px 缩略图。mtime 进 URL：文件改了 URL 就变，webview 的图片缓存自然失效。 */
export function thumbUrl(p: Photo): string {
  return `${convertFileSrc(p.path, 'thumb')}?v=${p.mtime}`;
}

/**
 * 看图用的图片。
 * @param max 长边上限（像素），0 = 原图
 * @param urgent 当前正在看的那张（后端插队）；预加载的相邻照片为 false
 * @param force 强制后端转码成 JPEG（webview 解不了原格式时的退路）
 */
export function photoUrl(p: Photo, max: number, urgent: boolean, force = false): string {
  return `${convertFileSrc(p.path, 'photo')}?v=${p.mtime}&max=${max}&p=${urgent ? 0 : 1}${force ? '&force=1' : ''}`;
}

// 与 src-tauri/src/formats.rs 的 RAW 列表保持一致
const RAW_EXT = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'rwl', 'pef',
  'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf', 'kdc', 'mrw', 'mos',
]);

export const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** webview 肯定解不了、需要后端转码的格式 */
export function needsTranscode(p: Photo): boolean {
  return RAW_EXT.has(extOf(p.name));
}

/** 伴侣文件里的 RAW 扩展名（大写），用于角标，如 "CR3"；没有 RAW 伴侣返回 '' */
export function rawTag(p: Photo): string {
  const raw = p.companions.find((c) => RAW_EXT.has(extOf(c)));
  return raw ? extOf(raw).toUpperCase() : '';
}

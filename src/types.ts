// 与 Rust 后端（src-tauri/src）序列化结构一一对应

export interface Photo {
  path: string;
  name: string;
  dir: string;
  size: number;
  /** 修改时间（毫秒），拼进图片 URL 做缓存失效 */
  mtime: number;
  starred: boolean;
  /** 同名的 RAW / .xmp 文件名（RAW+JPG 合并显示时，跟着这张 JPG 走） */
  companions: string[];
}

export interface Folder {
  path: string;
  name: string;
  /** 相对所属根目录的路径 */
  rel: string;
  root: string;
  count: number;
  starred: number;
}

export interface Library {
  /** 当前工作目录 */
  workdir: string | null;
  /** 最近用过的工作目录，最新在前 */
  recent: string[];
  /** 工作目录下所有含照片的文件夹（相册） */
  folders: Folder[];
}

export interface PhotoInfo {
  width: number;
  height: number;
  size: number;
  mtime: number;
  taken?: string | null;
  camera?: string | null;
  lens?: string | null;
  exposure?: string | null;
}

export interface SetStarResult {
  fallback: boolean;
  folders: Record<string, number>;
}

export type ExportMode = 'original' | 'resize';

export interface ExportRequest {
  paths: string[];
  dest: string;
  subfolder?: string;
  mode: ExportMode;
  maxPx: number;
  quality: number;
  /** 同时导出同名的 RAW / xmp */
  includeCompanions: boolean;
}

export interface ExportResult {
  /** 导出的照片数（RAW+JPG 算一张） */
  exported: number;
  /** 实际写出的文件数 */
  files: number;
  failed: { path: string; error: string }[];
  dest: string;
  cancelled: boolean;
}

export interface Progress {
  done: number;
  total: number;
  current?: string;
}

export interface CacheInfo {
  bytes: number;
  files: number;
  path: string;
}

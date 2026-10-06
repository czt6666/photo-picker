// 与 Rust 后端（src-tauri/src）序列化结构一一对应

export interface Photo {
  path: string;
  name: string;
  dir: string;
  size: number;
  /** 修改时间（毫秒），拼进图片 URL 做缓存失效 */
  mtime: number;
  starred: boolean;
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
  roots: string[];
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
}

export interface ExportResult {
  exported: number;
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

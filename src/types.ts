// 与 Rust 后端（src-tauri/src）序列化结构一一对应

export interface Photo {
  path: string;
  name: string;
  dir: string;
  size: number;
  /** 修改时间（毫秒），拼进图片 URL 做缓存失效 */
  mtime: number;
  starred: boolean;
  /** 星级 0～5（0 = 没标）。和星标互不影响：星标相当于 Lightroom 的“选取”，星级就是它的星级 */
  rating: number;
  /** 同名的 RAW / .xmp 文件名（RAW+JPG 合并显示时，跟着这张 JPG 走） */
  companions: string[];
  /** 远程相册里的照片：最后是谁加的星（大家共用一份星标） */
  starredBy?: string | null;
  /** 远程相册里的照片才有 */
  remote?: RemoteRef;
}

/** 远程相册照片的来历。path 形如 `remote:<相册码>#<id>`，dir 形如 `remote:<相册码>/<文件夹>` */
export interface RemoteRef {
  code: string;
  id: number;
  width: number;
  height: number;
  /** 在摄影师电脑上的相对文件夹 */
  folder: string;
  /** 图片地址前缀，后面接 `_t.jpg`（缩略图）/ `_p.jpg`（预览图） */
  img: string;
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
  /** recent 里当前不存在的目录（移动硬盘没插、被删或改名） */
  missing: string[];
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

/** 导入选片清单的匹配结果 */
export interface PickListMatch {
  paths: string[];
  missing: string[];
  ambiguous: number;
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
  /** 移动而不是复制 */
  moveFiles?: boolean;
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

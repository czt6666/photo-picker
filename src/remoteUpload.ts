// 往远程相册上传：把原图压成“预览图 + 缩略图”，只上传这两个小文件。
//
// 为什么不传原图？算笔账：一次外拍 1000 张，JPG+RAW 每张约 35MB，原图一共 35GB。
// 家用宽带上行一般 30~50Mbps，传完要两三个小时，服务器还得有 35GB 硬盘。
// 而长边 1600 像素的预览图约 0.2MB，1000 张才 200MB，几分钟传完；手机屏幕横过来也就 1200 来个像素，再大也看不出来。
// RAW 一律不传：同名有 JPG 就用 JPG 压；只有 RAW 时抠出相机内置的 JPEG 再压小。
// 原图一直留在摄影师电脑上，导出时按文件名对回去（见 api.ts 的 resolveOriginals）。
//
// 谁来压：桌面版用自带的解码器（macOS 上 RAW、HEIC 都认）；网页版在浏览器里压，RAW 抠出相机内置的 JPEG 预览。

import { api, RAW_EXT } from './api';
import { t } from './i18n';
import { largestEmbeddedJpeg, jpegOrientation, rawOrientation } from './rawPreview';
import { photoKey, remote, type UploadMeta } from './remote';
import type { Photo } from './types';

export const PREVIEW_PX = 1600;
export const THUMB_PX = 400;
/** 同名多个文件时，用哪个做预览（越小越优先）。RAW 最后：抠出来的内置 JPEG 有时偏小。 */
const PREFER: Record<string, number> = { jpg: 0, jpeg: 0, jpe: 0, heic: 1, heif: 1, avif: 2, webp: 2, png: 3, tif: 4, tiff: 4 };

export interface SourceFile {
  file: File;
  /** 相对路径，如 "外景/DSC_0001.JPG"；单选文件时就是文件名 */
  path: string;
}

export interface PhotoGroup {
  key: string;
  folder: string;
  /** 做预览用的文件 */
  source: SourceFile;
  /** 这一组所有原图文件名（同名 JPG + RAW） */
  originals: string[];
  /** 除了做预览的那个以外的同名文件 */
  companions: string[];
  /** 这一组原图加起来多大 */
  size: number;
}

function splitPath(path: string) {
  const parts = path.split('/');
  const name = parts.pop()!;
  const dot = name.lastIndexOf('.');
  return {
    folder: parts.join('/'),
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

export function isUsable(ext: string) {
  return ext in PREFER || RAW_EXT.has(ext);
}

/** 按“文件夹 + 去掉扩展名的文件名”分组：DSC_0001.JPG 和 DSC_0001.NEF 是同一张照片 */
export function groupFiles(files: SourceFile[]): PhotoGroup[] {
  const groups = new Map<string, { folder: string; files: (SourceFile & { ext: string; name: string })[] }>();
  for (const f of files) {
    const { folder, name, stem, ext } = splitPath(f.path);
    // 跳过隐藏文件，比如 Mac 在 U 盘/存储卡上留下的 ._DSC_0001.JPG
    if (name.startsWith('.') || !isUsable(ext)) continue;
    const key = ((folder ? folder + '/' : '') + stem).toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { folder, files: [] }));
    g.files.push({ ...f, ext, name });
  }
  const out: PhotoGroup[] = [];
  for (const [key, g] of groups) {
    const rank = (ext: string) => PREFER[ext] ?? 9;
    const sorted = [...g.files].sort((a, b) => rank(a.ext) - rank(b.ext));
    out.push({
      key,
      folder: g.folder,
      source: { file: sorted[0].file, path: sorted[0].path },
      originals: g.files.map((f) => f.name).sort(),
      companions: g.files.filter((f) => f !== sorted[0]).map((f) => f.name).sort(),
      size: g.files.reduce((n, f) => n + (f.file.size || 0), 0),
    });
  }
  return out;
}

export interface Compressed {
  preview: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

type Drawable = ImageBitmap | HTMLImageElement;

async function decode(blob: Blob): Promise<Drawable> {
  try {
    // 会按 EXIF 方向自动转正
    return await createImageBitmap(blob);
  } catch {
    // Safari 的 createImageBitmap 有时不认 HEIC/TIFF，但 <img> 认
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}

function size(d: Drawable) {
  return d instanceof HTMLImageElement ? { w: d.naturalWidth, h: d.naturalHeight } : { w: d.width, h: d.height };
}

/** 按 EXIF 方向值（1~8）把图画正 */
function drawOriented(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, o: number) {
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('JPEG 编码失败')))), 'image/jpeg', quality),
  );
}

/**
 * 缩到长边 maxPx。一次从 6000 缩到 1600 会有点糊/锯齿，
 * 所以先每次减半逼近目标，最后一步再精确缩放（和 Photoshop“两次立方”思路一样）。
 */
function shrink(src: CanvasImageSource, sw: number, sh: number, maxPx: number, orientation: number): HTMLCanvasElement {
  const swap = orientation >= 5;
  let cur: CanvasImageSource = src;
  let cw = sw;
  let ch = sh;
  const r = Math.min(1, maxPx / Math.max(sw, sh));
  const tw = Math.round(sw * r);
  const th = Math.round(sh * r);
  while (cw / 2 >= tw * 1.5) {
    const c = document.createElement('canvas');
    c.width = Math.round(cw / 2);
    c.height = Math.round(ch / 2);
    drawOriented(c.getContext('2d')!, cur, c.width, c.height, 1);
    cur = c;
    cw = c.width;
    ch = c.height;
  }
  const out = document.createElement('canvas');
  out.width = swap ? th : tw;
  out.height = swap ? tw : th;
  drawOriented(out.getContext('2d')!, cur, tw, th, orientation);
  return out;
}

export async function compress(src: SourceFile): Promise<Compressed> {
  const { ext } = splitPath(src.path);
  let blob: Blob = src.file;
  let orientation = 1;
  if (RAW_EXT.has(ext)) {
    const bytes = new Uint8Array(await src.file.arrayBuffer());
    const jpg = largestEmbeddedJpeg(bytes);
    if (!jpg || Math.max(jpg.width, jpg.height) < 600) {
      throw new Error(t('RAW 里没有可用的预览图，请同时选上同名 JPG'));
    }
    // 内置 JPEG 自己带方向就交给浏览器转；不带就用 RAW 文件头里的方向
    if (!jpegOrientation(bytes, jpg.start, jpg.end)) orientation = rawOrientation(bytes) || 1;
    blob = new Blob([bytes.slice(jpg.start, jpg.end)], { type: 'image/jpeg' });
  }
  let img: Drawable;
  try {
    img = await decode(blob);
  } catch {
    throw new Error(ext === 'heic' || ext === 'heif' ? t('这个浏览器打不开 HEIC，请用 Safari 或先转成 JPG') : t('图片解不开，文件可能损坏'));
  }
  const { w, h } = size(img);
  const preview = shrink(img, w, h, PREVIEW_PX, orientation);
  if (img instanceof ImageBitmap) img.close();
  const thumb = shrink(preview, preview.width, preview.height, THUMB_PX, 1);
  const [pBlob, tBlob] = await Promise.all([toJpeg(preview, 0.8), toJpeg(thumb, 0.76)]);
  const result = { preview: pBlob, thumb: tBlob, width: preview.width, height: preview.height };
  preview.width = preview.height = thumb.width = thumb.height = 0; // 尽早释放显存（Safari 对 canvas 总内存有上限）
  return result;
}

/** 桌面版：用自带解码器压出预览，再在页面里缩出缩略图 */
export async function compressLocal(p: Photo): Promise<Compressed> {
  const bytes = await api.renderPreview(p.path, PREVIEW_PX);
  const preview = new Blob([bytes], { type: 'image/jpeg' });
  const img = await decode(preview);
  const { w, h } = size(img);
  const thumbCanvas = shrink(img, w, h, THUMB_PX, 1);
  if (img instanceof ImageBitmap) img.close();
  const thumb = await toJpeg(thumbCanvas, 0.76);
  thumbCanvas.width = thumbCanvas.height = 0;
  return { preview, thumb, width: w, height: h };
}

export interface UploadJob {
  meta: Omit<UploadMeta, 'width' | 'height'>;
  /** 显示在失败列表里的名字 */
  label: string;
  make(): Promise<Compressed>;
}

/** 桌面版的一张本地照片，folder = 相对共享文件夹的路径（“2024/旅行”，根目录是 ""） */
export interface LocalItem {
  photo: Photo;
  folder: string;
}

export function jobsFromLocal(items: LocalItem[]): UploadJob[] {
  return items.map(({ photo: p, folder }) => ({
    meta: { key: photoKey(folder, p.name), name: p.name, folder, companions: p.companions, size: p.size },
    label: folder ? `${folder}/${p.name}` : p.name,
    make: () => compressLocal(p),
  }));
}

export function jobsFromFiles(files: SourceFile[]): UploadJob[] {
  return groupFiles(files).map((g) => ({
    meta: { key: g.key, name: g.source.file.name, folder: g.folder, companions: g.companions, size: g.size },
    label: g.source.path,
    make: () => compress(g.source),
  }));
}

export interface UploadProgress {
  done: number;
  failed: { label: string; error: string }[];
  skipped: number;
  total: number;
}

/**
 * 压缩 + 上传，2~4 张同时进行：压缩吃 CPU、上传吃网络，并行起来两边都不闲着；
 * 再多内存会吃紧（一张 2400 万像素图解开约 100MB）。已经传过的（同 key）直接跳过，所以重传就是续传。
 */
export async function uploadJobs(code: string, jobs: UploadJob[], onProgress: (p: UploadProgress) => void, cancelled: () => boolean): Promise<UploadProgress> {
  const have = remote.uploadedKeys(code);
  const todo = jobs.filter((j) => !have.has(j.meta.key));
  const prog: UploadProgress = { done: 0, failed: [], skipped: jobs.length - todo.length, total: todo.length };
  onProgress(prog);
  let next = 0;
  const workers = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const work = async () => {
    while (!cancelled() && next < todo.length) {
      const job = todo[next++];
      try {
        const c = await job.make();
        await remote.upload(code, { ...job.meta, width: c.width, height: c.height }, c.thumb, c.preview);
        prog.done++;
      } catch (e) {
        prog.failed.push({ label: job.label, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress(prog);
    }
  };
  await Promise.all(Array.from({ length: workers }, work));
  return prog;
}

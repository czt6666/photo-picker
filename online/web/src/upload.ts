// 摄影师上传：在浏览器里把原图压成“预览图 + 缩略图”，只上传这两个小文件。
//
// 为什么在浏览器里压，而不是把原图传上去让服务器压？算笔账：
// 一次外拍 1000 张，JPG+RAW 每张约 35MB，原图一共 35GB。家用宽带上行一般 30~50Mbps，
// 传完要两三个小时，服务器还得有 35GB 硬盘。而 2048 像素的预览图约 0.4MB，1000 张才 400MB，
// 几分钟传完；模特在手机上看，2048 像素也已经比屏幕清楚了。
// 原图一直留在摄影师电脑上，选完按“文件名清单”回去找就行（见 export.ts）。

import { largestEmbeddedJpeg, jpegOrientation, rawOrientation } from './rawPreview';

export const PREVIEW_PX = 2048;
export const THUMB_PX = 512;

const RAW_EXT = new Set('cr2 cr3 crw nef nrw arw srf sr2 dng raf orf rw2 rwl pef srw x3f 3fr fff iiq erf kdc mrw mos'.split(' '));
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
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))), 'image/jpeg', quality),
  );
}

/**
 * 缩到长边 maxPx。一次从 6000 缩到 2048 会有点糊/锯齿，
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
      throw new Error('RAW 里没有可用的预览图，请同时选上同名 JPG');
    }
    // 内置 JPEG 自己带方向就交给浏览器转；不带就用 RAW 文件头里的方向
    if (!jpegOrientation(bytes, jpg.start, jpg.end)) orientation = rawOrientation(bytes) || 1;
    blob = new Blob([bytes.slice(jpg.start, jpg.end)], { type: 'image/jpeg' });
  }
  let img: Drawable;
  try {
    img = await decode(blob);
  } catch {
    throw new Error(ext === 'heic' || ext === 'heif' ? '这个浏览器打不开 HEIC，请用 Safari 或先转成 JPG' : '图片解不开，文件可能损坏');
  }
  const { w, h } = size(img);
  const preview = shrink(img, w, h, PREVIEW_PX, orientation);
  if (img instanceof ImageBitmap) img.close();
  const thumb = shrink(preview, preview.width, preview.height, THUMB_PX, 1);
  const [pBlob, tBlob] = await Promise.all([toJpeg(preview, 0.82), toJpeg(thumb, 0.76)]);
  const result = { preview: pBlob, thumb: tBlob, width: preview.width, height: preview.height };
  preview.width = preview.height = thumb.width = thumb.height = 0; // 尽早释放显存（Safari 对 canvas 总内存有上限）
  return result;
}

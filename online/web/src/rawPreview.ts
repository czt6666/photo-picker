// 从 RAW 文件里抠出相机自带的 JPEG 预览，以及读照片的“方向”标记。纯函数，方便单测。
//
// 原理：浏览器不认识 .NEF/.CR2/.ARW 这些 RAW 格式，但相机在拍 RAW 时，为了在相机屏幕上回看，
// 几乎都会在文件里顺手塞一张（甚至几张大小不同的）现成 JPEG。我们只要在字节里找到 JPEG 的开头
// 标记 FF D8 FF，再顺着 JPEG 的段结构走到结尾 FF D9，就能把它整块切出来，挑最大的那张用。
//
// 要小心的是：有些 RAW（CR2、DNG）的传感器数据本身也用“无损 JPEG”编码（SOF3），那不是照片，
// 是没去马赛克的原始数据，浏览器解不了，必须跳过——只认普通 JPEG（SOF0/1/2）。

export interface EmbeddedJpeg {
  start: number;
  end: number;
  width: number;
  height: number;
}

/** 从 start（指向 FF D8）开始顺着段结构走，返回 JPEG 的结束位置和尺寸；不是能显示的 JPEG 就返回 null */
export function walkJpeg(b: Uint8Array, start: number): EmbeddedJpeg | null {
  let i = start + 2;
  let width = 0;
  let height = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // 填充字节
      continue;
    }
    if (m === 0xd9) return width && height ? { start, end: i + 2, width, height } : null;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (i + 9 > b.length) return null;
      height = (b[i + 5] << 8) | b[i + 6];
      width = (b[i + 7] << 8) | b[i + 8];
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return null; // 无损/算术编码等：RAW 传感器数据，不是照片
    }
    i += 2 + len;
    if (m === 0xda) {
      // 扫描数据里 FF 后面只会跟 00（转义）或 D0~D7（复位标记），遇到别的就是下一个段
      for (;;) {
        const j = b.indexOf(0xff, i);
        if (j < 0 || j + 1 >= b.length) return null;
        const n = b[j + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
          i = j + 2;
          continue;
        }
        if (n === 0xff) {
          i = j + 1;
          continue;
        }
        i = j;
        break;
      }
    }
  }
  return null;
}

/** 文件里最大的那张可显示 JPEG */
export function largestEmbeddedJpeg(b: Uint8Array): EmbeddedJpeg | null {
  let best: EmbeddedJpeg | null = null;
  let i = 0;
  while (i < b.length - 3) {
    const j = b.indexOf(0xff, i);
    if (j < 0 || j > b.length - 3) break;
    if (b[j + 1] === 0xd8 && b[j + 2] === 0xff) {
      const found = walkJpeg(b, j);
      if (found) {
        if (!best || found.width * found.height > best.width * best.height) best = found;
        i = found.end; // 跳过它内部嵌套的小缩略图
        continue;
      }
    }
    i = j + 1;
  }
  return best;
}

/** 读 TIFF 结构里 IFD0 的方向标记（0x0112）。RAW 大多是 TIFF 结构，JPEG 的 EXIF 也是。 */
export function tiffOrientation(b: Uint8Array, base: number): number {
  if (base + 8 > b.length) return 0;
  const le = b[base] === 0x49 && b[base + 1] === 0x49; // "II"
  const be = b[base] === 0x4d && b[base + 1] === 0x4d; // "MM"
  if (!le && !be) return 0;
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const ifd = base + u32(base + 4);
  if (ifd + 2 > b.length) return 0;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) return 0;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

/** RAW 文件的方向：找文件开头附近第一个 TIFF 头（CR3 的 TIFF 头藏在 CMT1 盒子里，不在 0 位置） */
export function rawOrientation(b: Uint8Array): number {
  const limit = Math.min(b.length - 8, 256 * 1024);
  for (let i = 0; i < limit; i++) {
    const c = b[i];
    if ((c === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0x00) || (c === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0x00 && b[i + 3] === 0x2a)) {
      const o = tiffOrientation(b, i);
      if (o) return o;
    }
  }
  return 0;
}

/** JPEG 自己 EXIF 里的方向（APP1 "Exif\0\0" 后面就是一个 TIFF 头） */
export function jpegOrientation(b: Uint8Array, start = 0, end = b.length): number {
  let i = start + 2;
  while (i + 4 <= end) {
    if (b[i] !== 0xff) return 0;
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) return 0;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      return tiffOrientation(b, i + 10);
    }
    i += 2 + len;
  }
  return 0;
}

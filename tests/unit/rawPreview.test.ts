import { describe, expect, it } from 'vitest';
import { jpegOrientation, largestEmbeddedJpeg, rawOrientation, walkJpeg } from '../../src/rawPreview';

/** 拼一个只有段结构、没有真实图像数据的“JPEG”，够测切割逻辑了 */
function fakeJpeg(w: number, h: number, opts: { sof?: number; exifOrientation?: number; scan?: number[] } = {}): number[] {
  const out = [0xff, 0xd8];
  if (opts.exifOrientation) {
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, opts.exifOrientation, 0, 0, 0, 0, 0, 0];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    out.push(0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload);
  }
  out.push(0xff, opts.sof ?? 0xc0, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0);
  out.push(0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0);
  // 扫描数据：含转义的 FF 00 和复位标记 FF D0，都不能当成结尾
  out.push(...(opts.scan ?? [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]));
  out.push(0xff, 0xd9);
  return out;
}

describe('walkJpeg', () => {
  it('走到真正的结尾，不被扫描数据里的 FF 骗', () => {
    const j = fakeJpeg(4000, 3000);
    const b = new Uint8Array([1, 2, ...j, 9, 9]);
    expect(walkJpeg(b, 2)).toEqual({ start: 2, end: 2 + j.length, width: 4000, height: 3000 });
  });

  it('无损 JPEG（RAW 传感器数据）不算', () => {
    expect(walkJpeg(new Uint8Array(fakeJpeg(6000, 4000, { sof: 0xc3 })), 0)).toBeNull();
  });

  it('截断的不算', () => {
    const j = fakeJpeg(100, 100);
    expect(walkJpeg(new Uint8Array(j.slice(0, -4)), 0)).toBeNull();
  });
});

describe('largestEmbeddedJpeg', () => {
  it('挑最大的那张，跳过无损数据和小缩略图', () => {
    const header = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const small = fakeJpeg(160, 120);
    const sensor = fakeJpeg(6000, 4000, { sof: 0xc3 });
    const big = fakeJpeg(6000, 4000);
    const junk = [0xff, 0xd8, 0xff, 0x00, 0x13]; // 随机数据里碰巧出现的 FF D8 FF
    const bytes = new Uint8Array([...header, ...small, ...junk, ...sensor, 0, ...big, 0, 0]);
    const found = largestEmbeddedJpeg(bytes)!;
    expect(found.width).toBe(6000);
    expect(found.end - found.start).toBe(big.length);
    expect(rawOrientation(bytes)).toBe(6);
  });

  it('没有可用的就返回 null', () => {
    expect(largestEmbeddedJpeg(new Uint8Array([0, 1, 2, 0xff, 0xd8]))).toBeNull();
  });
});

describe('jpegOrientation', () => {
  it('读 EXIF 里的方向', () => {
    expect(jpegOrientation(new Uint8Array(fakeJpeg(10, 10, { exifOrientation: 8 })))).toBe(8);
    expect(jpegOrientation(new Uint8Array(fakeJpeg(10, 10)))).toBe(0);
  });
});

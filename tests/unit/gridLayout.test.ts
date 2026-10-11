import { describe, expect, it } from 'vitest';
import { GridLayout, splitSections, type Section } from '../../src/gridLayout';

const M = { cols: 4, rowH: 100, gap: 4, pad: 10, headH: 36, headFirst: false };
/** 两个相册：A 有 6 张（2 行），B 有 3 张（1 行） */
const AB: Section[] = [
  { dir: '/a', start: 0, count: 6 },
  { dir: '/b', start: 6, count: 3 },
];

describe('splitSections', () => {
  it('按连续的同一个文件夹切段', () => {
    const photos = ['/a', '/a', '/b', '/c', '/c', '/c'].map((dir) => ({ dir }));
    expect(splitSections(photos)).toEqual([
      { dir: '/a', start: 0, count: 2 },
      { dir: '/b', start: 2, count: 1 },
      { dir: '/c', start: 3, count: 3 },
    ]);
  });
  it('空列表没有段', () => {
    expect(splitSections([])).toEqual([]);
  });
});

describe('GridLayout', () => {
  it('只有一个相册时和原来的均匀网格一样高，没有分界线', () => {
    const L = new GridLayout([{ dir: '/a', start: 0, count: 9 }], M);
    expect(L.bands[0]).toMatchObject({ top: 10, head: 0, rows: 3 });
    expect(L.height).toBe(10 * 2 + 3 * 100 - 4);
    expect(L.pos(5)).toMatchObject({ row: 1, col: 1, y: 110 });
  });

  it('空列表高度为 0', () => {
    const L = new GridLayout([], M);
    expect(L.height).toBe(0);
    expect(L.range(0, 500)).toEqual([0, 0]);
    expect(L.step(-1, 1, 0, 0)).toBe(-1);
  });

  it('第二个相册另起一行，上面留出分界线', () => {
    const L = new GridLayout(AB, M);
    expect(L.bands[1]).toMatchObject({ top: 210, head: 36, rows: 1 });
    // B 的第一张在新的一行第一列，而不是接在 A 最后一行的空位上
    expect(L.pos(6)).toMatchObject({ row: 0, col: 0, y: 246 });
    expect(L.height).toBe(246 + 100 - 4 + 10);
  });

  it('headFirst：第一个相册上面也有分界线', () => {
    const L = new GridLayout(AB, { ...M, headFirst: true });
    expect(L.bands[0]).toMatchObject({ top: 10, head: 36 });
    expect(L.pos(0)!.y).toBe(46);
  });

  it('bandOf / bandAt', () => {
    const L = new GridLayout(AB, M);
    expect(L.bandOf(5)!.dir).toBe('/a');
    expect(L.bandOf(6)!.dir).toBe('/b');
    expect(L.bandAt(0)!.dir).toBe('/a');
    expect(L.bandAt(209)!.dir).toBe('/a');
    expect(L.bandAt(210)!.dir).toBe('/b');
    expect(L.bandAt(9999)!.dir).toBe('/b');
  });

  it('range：一段高度里的照片是连续的下标', () => {
    const L = new GridLayout(AB, M);
    expect(L.range(0, 100)).toEqual([0, 4]);
    expect(L.range(120, 200)).toEqual([4, 6]);
    // 只露出了 B 的分界线，还没到它的第一行
    expect(L.range(120, 230)).toEqual([4, 6]);
    expect(L.range(120, 250)).toEqual([4, 9]);
    expect(L.range(-300, 9999)).toEqual([0, 9]);
  });

  it('firstIndexAt：落在分界线上算这个相册的第一张', () => {
    const L = new GridLayout(AB, M);
    expect(L.firstIndexAt(0)).toBe(0);
    expect(L.firstIndexAt(115)).toBe(4);
    expect(L.firstIndexAt(220)).toBe(6);
  });

  it('step：左右就是前后一张，可以跨相册', () => {
    const L = new GridLayout(AB, M);
    expect(L.step(5, 1, 0, 9)).toBe(6);
    expect(L.step(6, -1, 0, 9)).toBe(5);
    expect(L.step(8, 1, 0, 9)).toBe(8);
    expect(L.step(0, -1, 0, 9)).toBe(0);
  });

  it('step：上下跨相册时保持列，那一行不够长就落在最后一张', () => {
    const L = new GridLayout(AB, M);
    expect(L.step(1, 0, 1, 9)).toBe(5);
    // A 的最后一行第 2 列 → B 的第 2 列
    expect(L.step(5, 0, 1, 9)).toBe(7);
    // A 第一行第 4 列，下面一行只有 2 张 → 落在最后一张
    expect(L.step(3, 0, 1, 9)).toBe(5);
    // B 第 3 列往上：A 最后一行只有 2 张 → A 的最后一张
    expect(L.step(8, 0, -1, 9)).toBe(5);
    expect(L.step(6, 0, -1, 9)).toBe(4);
    // 到头了
    expect(L.step(7, 0, 1, 9)).toBe(8);
    expect(L.step(2, 0, -1, 9)).toBe(0);
  });

  it('step：还没有光标时，往后从第一张开始，往前从最后一张开始', () => {
    const L = new GridLayout(AB, M);
    expect(L.step(-1, 1, 0, 9)).toBe(0);
    expect(L.step(-1, 0, 1, 9)).toBe(0);
    expect(L.step(-1, -1, 0, 9)).toBe(8);
  });
});

import { describe, expect, it } from 'vitest';
import { planRate, planToggle, starLabel } from '../../src/rating';
import type { Photo } from '../../src/types';

const photo = (name: string, rating: number): Photo => ({
  path: `/a/${name}`,
  name,
  dir: '/a',
  size: 1,
  mtime: 1,
  starred: rating > 0,
  rating,
  companions: [],
});
const names = (list: Photo[]) => list.map((p) => p.name);

describe('planToggle（空格 / S）', () => {
  it('有没加星的：只给它们加 1 星，已有星级的不动', () => {
    const plan = planToggle([photo('a', 0), photo('b', 4), photo('c', 0)]);
    expect(plan.rating).toBe(1);
    expect(names(plan.changed)).toEqual(['a', 'c']);
  });
  it('全都有星：全部取消，不管几星', () => {
    const plan = planToggle([photo('a', 1), photo('b', 5)]);
    expect(plan.rating).toBe(0);
    expect(names(plan.changed)).toEqual(['a', 'b']);
  });
  it('没有照片就什么也不做', () => {
    expect(planToggle([]).changed).toEqual([]);
  });
});

describe('planRate（数字键）', () => {
  it('标成 n 星，已经是 n 星的不用再写', () => {
    const plan = planRate([photo('a', 0), photo('b', 3), photo('c', 5)], 3);
    expect(plan.rating).toBe(3);
    expect(names(plan.changed)).toEqual(['a', 'c']);
  });
  it('已经全是 n 星时再按一次 = 取消', () => {
    const plan = planRate([photo('a', 3), photo('b', 3)], 3);
    expect(plan.rating).toBe(0);
    expect(names(plan.changed)).toEqual(['a', 'b']);
  });
  it('没有照片就什么也不做', () => {
    expect(planRate([], 2)).toEqual({ rating: 2, changed: [] });
  });
});

describe('starLabel', () => {
  it('1 星只画一颗星，2 星以上带数字', () => {
    expect(starLabel(1)).toBe('★');
    expect(starLabel(4)).toBe('★4');
  });
});

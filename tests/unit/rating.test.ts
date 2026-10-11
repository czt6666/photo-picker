import { describe, expect, it } from 'vitest';
import { planRate, planToggle, ratingStars } from '../../src/rating';
import type { Photo } from '../../src/types';

const photo = (name: string, starred: boolean, rating = 0): Photo => ({
  path: `/a/${name}`,
  name,
  dir: '/a',
  size: 1,
  mtime: 1,
  starred,
  rating,
  companions: [],
});
const names = (list: Photo[]) => list.map((p) => p.name);

describe('planToggle（空格 / S = 星标）', () => {
  it('有没加星的：只给它们加星，和星级无关', () => {
    const plan = planToggle([photo('a', false, 5), photo('b', true), photo('c', false)]);
    expect(plan.starred).toBe(true);
    expect(names(plan.changed)).toEqual(['a', 'c']);
  });
  it('全都有星：全部取消', () => {
    const plan = planToggle([photo('a', true), photo('b', true, 3)]);
    expect(plan.starred).toBe(false);
    expect(names(plan.changed)).toEqual(['a', 'b']);
  });
  it('没有照片就什么也不做', () => {
    expect(planToggle([]).changed).toEqual([]);
  });
});

describe('planRate（数字键 = 星级）', () => {
  it('标成 n 星，已经是 n 星的不用再写；有没有星标都一样', () => {
    const plan = planRate([photo('a', false, 0), photo('b', true, 3), photo('c', false, 5)], 3);
    expect(plan.rating).toBe(3);
    expect(names(plan.changed)).toEqual(['a', 'c']);
  });
  it('已经全是 n 星时再按一次 = 清除', () => {
    const plan = planRate([photo('a', true, 3), photo('b', false, 3)], 3);
    expect(plan.rating).toBe(0);
    expect(names(plan.changed)).toEqual(['a', 'b']);
  });
  it('0 = 清除，本来就没星级的不用写', () => {
    const plan = planRate([photo('a', true, 0), photo('b', false, 2)], 0);
    expect(plan.rating).toBe(0);
    expect(names(plan.changed)).toEqual(['b']);
  });
  it('没有照片就什么也不做', () => {
    expect(planRate([], 2)).toEqual({ rating: 2, changed: [] });
  });
});

describe('ratingStars', () => {
  it('几星就是几颗星，0 星是空的', () => {
    expect(ratingStars(0)).toBe('');
    expect(ratingStars(3)).toBe('★★★');
    expect(ratingStars(9)).toBe('★★★★★');
  });
});

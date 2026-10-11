// 星级（1～5 星）的规则。纯函数，方便单测。
//
// 星标还是原来的星标：rating ≥ 1 就是“加了星”（Picasa 标的星是 1 星），筛选、导出都只看有没有星。
// 数字键 1～5 是在这之上分个等级。

import type { Photo } from './types';

export const MAX_RATING = 5;

export interface RatingPlan {
  /** 要写成的星级，0 = 取消星标 */
  rating: number;
  /** 需要改动的照片 */
  changed: Photo[];
}

/** 空格 / S：像 Picasa 一样，选中的照片里只要有没加星的，就把它们加星（1 星，已有星级的不动）；否则全部取消。 */
export function planToggle(photos: Photo[]): RatingPlan {
  const rating = photos.some((p) => !p.starred) ? 1 : 0;
  return { rating, changed: photos.filter((p) => p.starred !== rating > 0) };
}

/** 数字键 n：全部标成 n 星；已经全是 n 星时再按一次 = 取消。 */
export function planRate(photos: Photo[], n: number): RatingPlan {
  const rating = photos.length > 0 && photos.every((p) => p.rating === n) ? 0 : n;
  return { rating, changed: photos.filter((p) => p.rating !== rating) };
}

/** 角标文字：1 星只画一颗星，2 星以上带数字 */
export function starLabel(rating: number): string {
  return rating > 1 ? `★${rating}` : '★';
}

// 星标和星级的规则。纯函数，方便单测。
//
// 两回事，互不影响（和 Lightroom 一样）：
//   星标（空格 / S）= Lightroom 的“选取”：选中 / 没选中。星标筛选、导出、相册的星标数都只看它。
//   星级（数字键 1～5，0 清除）= Lightroom 的星级：给照片分个等级。

import type { Photo } from './types';

export const MAX_RATING = 5;

export interface StarPlan {
  starred: boolean;
  /** 需要改动的照片 */
  changed: Photo[];
}

/** 空格 / S：像 Picasa 一样，选中的照片里只要有没加星的，就全部加星；否则全部取消。星级不动。 */
export function planToggle(photos: Photo[]): StarPlan {
  const starred = photos.some((p) => !p.starred);
  return { starred, changed: photos.filter((p) => p.starred !== starred) };
}

export interface RatingPlan {
  /** 要写成的星级，0 = 清除 */
  rating: number;
  changed: Photo[];
}

/** 数字键 n：全部标成 n 星；已经全是 n 星时再按一次 = 清除。0 = 清除。星标不动。 */
export function planRate(photos: Photo[], n: number): RatingPlan {
  const rating = n > 0 && photos.length > 0 && photos.every((p) => p.rating === n) ? 0 : n;
  return { rating, changed: photos.filter((p) => p.rating !== rating) };
}

/** 星级显示成几颗星：★★★ */
export function ratingStars(rating: number): string {
  return '★'.repeat(Math.max(0, Math.min(MAX_RATING, rating)));
}

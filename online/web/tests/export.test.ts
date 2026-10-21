import { describe, expect, it } from 'vitest';
import type { Photo, Picker } from '../src/common';
import { pickedPhotos, toCsv, toStems, toTxt } from '../src/export';

const photo = (id: number, name: string, originals: string[], folder = '外景'): Photo => ({ id, key: '', name, folder, originals, width: 1, height: 1 });
const photos = [photo(1, 'DSC_0010.JPG', ['DSC_0010.JPG', 'DSC_0010.NEF']), photo(2, 'DSC_0002.JPG', ['DSC_0002.JPG']), photo(3, 'A.jpg', ['A.jpg'], '')];
const pickers: Picker[] = [
  { name: '小林', submitted: true, updated_at: 0, picks: [{ photo_id: 1, note: '修瘦, "一点"' }, { photo_id: 2, note: '' }] },
  { name: '小美', submitted: false, updated_at: 0, picks: [{ photo_id: 1, note: '' }, { photo_id: 3, note: '' }] },
];

describe('export', () => {
  it('按人筛、自然排序', () => {
    expect(pickedPhotos(photos, pickers, '小林').map((p) => p.photo.id)).toEqual([2, 1]);
    const all = pickedPhotos(photos, pickers, null);
    expect(all.map((p) => p.photo.id)).toEqual([3, 2, 1]);
    expect(all[2].by.map((b) => b.name)).toEqual(['小林', '小美']);
  });

  it('txt 清单列出所有原图', () => {
    const txt = toTxt(pickedPhotos(photos, pickers, '小林'), '相册');
    expect(txt.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['外景/DSC_0002.JPG', '外景/DSC_0010.JPG', '外景/DSC_0010.NEF']);
    expect(txt).toContain('# 小林: 修瘦, "一点"');
  });

  it('csv 转义、带 BOM', () => {
    const csv = toCsv(pickedPhotos(photos, pickers, '小林'));
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"修瘦, ""一点"""');
  });

  it('文件名主干去重', () => {
    expect(toStems(pickedPhotos(photos, pickers, null))).toBe('A DSC_0002 DSC_0010');
  });
});

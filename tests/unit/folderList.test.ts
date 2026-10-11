import { describe, expect, it } from 'vitest';
import { buildFolderList, commonDepth, type Row } from '../../src/folderList';
import type { Folder } from '../../src/types';

const ROOT = '/p';
const f = (rel: string, count = 10, starred = 0): Folder => ({
  path: rel ? `${ROOT}/${rel}` : ROOT,
  name: rel.split('/').pop() || 'p',
  rel,
  root: ROOT,
  count,
  starred,
});

/** 把行压成一眼能看懂的字符串：组 = "[2024]"，组里的相册前面缩进两格 */
const show = (rows: Row[]) =>
  rows.map((r) => (r.kind === 'group' ? `[${r.label}${r.collapsed ? '+' : ''}]` : `${r.inGroup ? '  ' : ''}${r.prefix}${r.folder.name}`));

const lib = [
  f('2023/冬/雪山', 30, 2),
  f('2023/春游'),
  f('2024'),
  f('2024/旅行', 300, 3),
  f('2024/毕业'),
  f('大图', 40),
];

describe('commonDepth', () => {
  it('所有相册都在同一个目录下时，去掉这层', () => {
    expect(commonDepth([f('照片/2023/a'), f('照片/2024/b')])).toBe(1);
    expect(commonDepth([f('照片/2023/a'), f('照片/2023/b')])).toBe(2);
  });
  it('不会把某个相册自己的名字也去掉', () => {
    expect(commonDepth([f('照片'), f('照片/2024')])).toBe(0);
    expect(commonDepth([f('照片/a')])).toBe(1);
    expect(commonDepth([f(''), f('a/b')])).toBe(0);
  });
});

describe('buildFolderList', () => {
  it('按第一层目录分组，单个的平铺', () => {
    expect(show(buildFolderList(lib).rows)).toEqual(['[2023]', '  冬/雪山', '  春游', '[2024]', '  2024', '  旅行', '  毕业', '大图']);
  });

  it('只有一个成员的组不成组，路径作为淡色前缀', () => {
    expect(show(buildFolderList([f('2023/冬/雪山'), f('大图')]).rows)).toEqual(['2023/冬/雪山', '大图']);
  });

  it('公共前缀去掉后再分组', () => {
    const rows = buildFolderList([f('照片/2023/a'), f('照片/2023/b'), f('照片/2024/c')]).rows;
    expect(show(rows)).toEqual(['[2023]', '  a', '  b', '2024/c']);
    expect(rows[0].kind === 'group' && rows[0].key).toBe('照片/2023');
  });

  it('折叠的组只露出当前打开的相册', () => {
    const r = buildFolderList(lib, { isCollapsed: (k) => k === '2024', activePath: '/p/2024/旅行' });
    expect(show(r.rows)).toEqual(['[2023]', '  冬/雪山', '  春游', '[2024+]', '  旅行', '大图']);
    expect(r.matched).toBe(6);
  });

  it('筛选框：多个词都要命中，分组自动展开，组里的数字是筛选后的', () => {
    const r = buildFolderList(lib, { query: '2024 旅', isCollapsed: () => true });
    expect(show(r.rows)).toEqual(['[2024]', '  旅行']);
    const g = r.rows[0];
    expect(g.kind === 'group' && [g.albums, g.photos, g.starred]).toEqual([1, 300, 3]);
  });

  it('筛选框只看名字，不会因为是当前相册就留下', () => {
    expect(show(buildFolderList(lib, { query: '大图', activePath: '/p/2024/旅行' }).rows)).toEqual(['大图']);
  });

  it('筛选框不分大小写，没有匹配时 matched 为 0', () => {
    expect(show(buildFolderList([f('Trip/IMG'), f('x')], { query: 'trip' }).rows)).toEqual(['Trip/IMG']);
    expect(buildFolderList(lib, { query: '不存在' }).matched).toBe(0);
  });

  it('星标筛选：只留有星标的相册，但当前相册不消失', () => {
    expect(show(buildFolderList(lib, { starredOnly: true, isCollapsed: () => true }).rows)).toEqual([
      '[2023]',
      '  冬/雪山',
      '[2024]',
      '  旅行',
    ]);
    expect(show(buildFolderList(lib, { starredOnly: true, activePath: '/p/大图' }).rows)).toContain('大图');
  });
});

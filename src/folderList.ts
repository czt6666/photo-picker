// 侧栏相册列表的“排版”：把扁平的相册列表变成“分组标题 + 相册行”。纯函数，不碰 DOM，方便单测。
//
// 思路：完整的目录树要一层层展开，太麻烦；完全扁平又会很长。折中成“只有一层”的分组：
//   1. 先去掉所有相册共有的路径前缀（比如全都在 照片/ 下面，那 照片/ 这一层没有区分度）；
//   2. 剩下路径的第一段当分组（通常就是年份，如 2023、2024），组标题可以折叠；
//   3. 组里只有一个相册时不单独成组，直接平铺。
// 再加一个筛选框：输入几个字（空格分开的多个词都要命中），立刻只剩匹配的相册，分组自动展开。

import type { Folder } from './types';

export interface GroupRow {
  kind: 'group';
  /** 分组的稳定标识（去掉公共前缀后的第一段，连同前缀），用来记住折叠状态 */
  key: string;
  label: string;
  /** 组里（经过筛选后）的相册数 / 照片数 / 星标数 */
  albums: number;
  photos: number;
  starred: number;
  collapsed: boolean;
}

export interface FolderRow {
  kind: 'folder';
  folder: Folder;
  /** 名字前面淡色显示的上级路径（不含分组名和公共前缀） */
  prefix: string;
  /** 是否在分组里（缩进显示） */
  inGroup: boolean;
}

export type Row = GroupRow | FolderRow;

export interface ListOptions {
  /** 筛选框里的文字 */
  query?: string;
  /** 星标筛选开着：只列出有星标的相册 */
  starredOnly?: boolean;
  /** 当前打开的相册：星标筛选时不让它消失，折叠的组里也照样显示它 */
  activePath?: string | null;
  /** 某个分组是否折叠 */
  isCollapsed?: (key: string) => boolean;
}

export interface FolderList {
  rows: Row[];
  /** 列出来的相册数（含折叠起来的） */
  matched: number;
  /** 有没有分组（没有就不用显示“全部折叠”按钮） */
  grouped: boolean;
}

const segments = (rel: string): string[] => rel.split(/[\\/]/).filter(Boolean);

/** 所有相册共有、且对每个相册都还不是“最后一段”的前缀段数 */
export function commonDepth(folders: Folder[]): number {
  if (!folders.length) return 0;
  const all = folders.map((f) => segments(f.rel));
  let k = 0;
  for (;;) {
    const seg = all[0][k];
    // 有相册的路径到这里就是它自己了（再去掉就没名字了），停
    if (seg === undefined || all.some((s) => s.length <= k + 1 || s[k] !== seg)) return k;
    k++;
  }
}

export function buildFolderList(folders: Folder[], opts: ListOptions = {}): FolderList {
  const terms = (opts.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const active = opts.activePath ?? null;
  const k = commonDepth(folders); // 用全部相册算，筛选时分组不会跳来跳去

  const keep = (f: Folder) => {
    // 星标筛选下，当前相册的最后一颗星被取消了也别让它从列表里消失；打字筛选则只看名字
    if (opts.starredOnly && !f.starred && f.path !== active) return false;
    if (!terms.length) return true;
    const hay = f.rel.toLowerCase() || f.name.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  // 筛选中（打字或只看星标）结果通常不多，分组全部展开，省得再去点
  const forceOpen = terms.length > 0 || !!opts.starredOnly;

  // 相册按 rel 自然排序过，同一组的成员是挨着的
  type Bucket = { key: string; label: string; members: Folder[] };
  const buckets: Bucket[] = [];
  for (const f of folders) {
    const s = segments(f.rel);
    const label = s.length > k ? s[k] : '';
    const key = label ? s.slice(0, k + 1).join('/') : '';
    const last = buckets[buckets.length - 1];
    if (label && last && last.key === key) last.members.push(f);
    else buckets.push({ key, label, members: [f] });
  }

  const rows: Row[] = [];
  let matched = 0;
  let grouped = false;
  const folderRow = (f: Folder, inGroup: boolean): FolderRow => {
    const s = segments(f.rel);
    // 组里：去掉公共前缀和组名；平铺：只去掉公共前缀
    const from = inGroup ? k + 1 : k;
    return { kind: 'folder', folder: f, prefix: s.slice(from, -1).map((x) => `${x}/`).join(''), inGroup };
  };

  for (const b of buckets) {
    const shown = b.members.filter(keep);
    if (!shown.length) continue;
    matched += shown.length;
    if (b.members.length < 2) {
      rows.push(folderRow(shown[0], false));
      continue;
    }
    grouped = true;
    const collapsed = !forceOpen && !!opts.isCollapsed?.(b.key);
    rows.push({
      kind: 'group',
      key: b.key,
      label: b.label,
      albums: shown.length,
      photos: shown.reduce((n, f) => n + f.count, 0),
      starred: shown.reduce((n, f) => n + f.starred, 0),
      collapsed,
    });
    for (const f of shown) {
      // 折叠的组里仍然露出当前相册，让人知道“我在哪”
      if (!collapsed || f.path === active) rows.push(folderRow(f, true));
    }
  }
  return { rows, matched, grouped };
}

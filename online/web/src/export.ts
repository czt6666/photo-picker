// 选片结果 → 摄影师拿去找原图用的清单。
//
// 线上只有预览图，原图在摄影师电脑上，两边靠“文件名”对上号：
// 预览图上传时记下了它在电脑上的文件夹和所有同名原图（DSC_0001.JPG、DSC_0001.NEF），
// 导出的清单就是这些原图的相对路径。拿着清单：
// - PhotoPicker 桌面版「导入选片清单」→ 自动给这些原图加星标 → 导出原图（可带 RAW）去修；
// - 或把“文件名”粘到 Lightroom 等软件的搜索框里筛出来。

import { collator, Photo, Picker } from './common';

export interface PickedPhoto {
  photo: Photo;
  /** 谁选的，及各自的备注 */
  by: { name: string; note: string }[];
}

/** 某人（或 null = 所有人合并）选中的照片，按文件夹、文件名排序 */
export function pickedPhotos(photos: Photo[], pickers: Picker[], only: string | null): PickedPhoto[] {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const out = new Map<number, PickedPhoto>();
  for (const pk of pickers) {
    if (only !== null && pk.name !== only) continue;
    for (const { photo_id, note } of pk.picks) {
      const photo = byId.get(photo_id);
      if (!photo) continue;
      let e = out.get(photo_id);
      if (!e) out.set(photo_id, (e = { photo, by: [] }));
      e.by.push({ name: pk.name, note });
    }
  }
  return [...out.values()].sort((a, b) => collator.compare(a.photo.folder, b.photo.folder) || collator.compare(a.photo.name, b.photo.name));
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** 文本清单：每行一个原图相对路径（JPG 和 RAW 都列上），# 开头的是说明 */
export function toTxt(list: PickedPhoto[], title: string): string {
  const lines = [`# ${title}`, `# ${list.length} 张 / photos`];
  for (const { photo, by } of list) {
    const notes = by.filter((b) => b.note).map((b) => `${b.name}: ${b.note.replace(/\s+/g, ' ')}`);
    if (notes.length) lines.push(`# ${notes.join(' | ')}`);
    for (const o of photo.originals) lines.push(join(photo.folder, o));
  }
  return lines.join('\n') + '\n';
}

function csvCell(s: string) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 表格（Excel 能直接打开，开头加 BOM 免得中文乱码） */
export function toCsv(list: PickedPhoto[]): string {
  const rows = [['文件夹 Folder', '文件名 File', '原图 Originals', '选片人 Picked by', '备注 Notes']];
  for (const { photo, by } of list) {
    rows.push([
      photo.folder,
      photo.name,
      photo.originals.join(' '),
      by.map((b) => b.name).join(', '),
      by.filter((b) => b.note).map((b) => (by.length > 1 ? `${b.name}: ${b.note}` : b.note)).join(' | '),
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 只要文件名主干（不带扩展名），空格隔开：粘进 Lightroom 过滤器 / 访达搜索用 */
export function toStems(list: PickedPhoto[]): string {
  const stems = list.map(({ photo }) => photo.name.replace(/\.[^.]+$/, ''));
  return [...new Set(stems)].join(' ');
}

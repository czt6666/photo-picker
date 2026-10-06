// 左侧栏：“已加星标的照片”虚拟相册 + 按根目录分组的文件夹列表（Picasa 风格的扁平列表）。

import { store } from './store';
import type { Folder } from './types';
import { esc } from './ui';

export interface SidebarCallbacks {
  openFolder(path: string): void;
  openStarred(): void;
  folderMenu(path: string, x: number, y: number): void;
  rootMenu(root: string, x: number, y: number): void;
}

export class Sidebar {
  constructor(
    private el: HTMLElement,
    private cb: SidebarCallbacks,
  ) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const item = t.closest<HTMLElement>('.sb-item');
      if (!item) return;
      if (item.dataset.kind === 'starred') this.cb.openStarred();
      else if (item.dataset.path) this.cb.openFolder(item.dataset.path);
    });
    el.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement;
      const item = t.closest<HTMLElement>('.sb-item[data-path]');
      const root = t.closest<HTMLElement>('.sb-root');
      if (item) {
        e.preventDefault();
        this.cb.folderMenu(item.dataset.path!, e.clientX, e.clientY);
      } else if (root) {
        e.preventDefault();
        this.cb.rootMenu(root.dataset.root!, e.clientX, e.clientY);
      }
    });
  }

  render(): void {
    const { library, view } = store;
    const active = (f: Folder) => view.kind === 'folder' && view.path === f.path;
    const starredTotal = store.totalStarred();
    let html = `
      <div class="sb-item sb-starred ${view.kind === 'starred' ? 'active' : ''}" data-kind="starred">
        <span class="sb-name"><span class="star">★</span> 已加星标的照片</span>
        <span class="count">${starredTotal || ''}</span>
      </div>`;
    if (library.roots.length) html += '<div class="sb-head">文件夹</div>';
    for (const root of library.roots) {
      const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
      html += `<div class="sb-root" data-root="${esc(root)}" title="${esc(root)}（右键可移除）">${esc(rootName)}</div>`;
      const folders = library.folders.filter((f) => f.root === root);
      if (!folders.length) html += '<div class="sb-empty">（没有找到照片）</div>';
      for (const f of folders) {
        const parts = f.rel ? f.rel.split(/[\\/]/) : [];
        const parent = parts.slice(0, -1).join('/');
        html += `
          <div class="sb-item ${active(f) ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
            <span class="sb-name">${parent ? `<span class="dim">${esc(parent)}/</span>` : ''}${esc(f.name)}</span>
            ${f.starred ? `<span class="sb-stars">★${f.starred}</span>` : ''}
            <span class="count">${f.count}</span>
          </div>`;
      }
    }
    this.el.innerHTML = html;
    this.el.querySelector('.sb-item.active')?.scrollIntoView({ block: 'nearest' });
  }
}

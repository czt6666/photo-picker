// 左侧栏：“已加星标的照片”虚拟相册 + 当前工作目录下的所有相册（Picasa 风格的扁平列表）。

import { store } from './store';
import type { Folder } from './types';
import { esc } from './ui';

export interface SidebarCallbacks {
  openFolder(path: string): void;
  openStarred(): void;
  folderMenu(path: string, x: number, y: number): void;
  workdirMenu(x: number, y: number): void;
}

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export class Sidebar {
  constructor(
    private el: HTMLElement,
    private cb: SidebarCallbacks,
  ) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sb-workdir')) {
        const r = t.closest('.sb-workdir')!.getBoundingClientRect();
        this.cb.workdirMenu(r.left + 8, r.bottom);
        return;
      }
      const item = t.closest<HTMLElement>('.sb-item');
      if (!item) return;
      if (item.dataset.kind === 'starred') this.cb.openStarred();
      else if (item.dataset.path) this.cb.openFolder(item.dataset.path);
    });
    el.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement;
      const item = t.closest<HTMLElement>('.sb-item[data-path]');
      if (item) {
        e.preventDefault();
        this.cb.folderMenu(item.dataset.path!, e.clientX, e.clientY);
      } else if (t.closest('.sb-workdir')) {
        e.preventDefault();
        this.cb.workdirMenu(e.clientX, e.clientY);
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
    const wd = library.workdir;
    if (wd) {
      const photos = library.folders.reduce((n, f) => n + f.count, 0);
      html += `
        <div class="sb-head">工作目录</div>
        <div class="sb-workdir" title="${esc(wd)}（点击切换工作目录）">
          <span class="sb-name">📁 ${esc(baseName(wd))}</span>
          <span class="count">${library.folders.length} 个相册 · ${photos} 张</span>
        </div>`;
      if (!library.folders.length) html += '<div class="sb-empty">（这个目录下没有找到照片）</div>';
      for (const f of library.folders) {
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

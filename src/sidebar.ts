// 左侧栏：“已加星标的照片”虚拟相册 + 当前工作目录下的所有相册（Picasa 风格的扁平列表）。

import { prefs, store } from './store';
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

// ---------------------------------------------------------------------------
// 侧栏宽度：拖动分隔条调整，记在本地偏好里。
// 宽度写成 #app 上的 CSS 变量 --sidebar-w，侧栏和顶栏左边的工作目录区都用它，所以两者永远一样宽。
// ---------------------------------------------------------------------------

const SIDEBAR_DEFAULT = 250;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;

/** 夹在上下限之间；窗口很窄时最多占一半，给照片留地方 */
function clampSidebar(w: number): number {
  const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth / 2));
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(max, w)));
}

export function makeSidebarResizable(handle: HTMLElement): void {
  const root = document.getElementById('app')!;
  let width = clampSidebar(prefs.get('sidebarWidth', SIDEBAR_DEFAULT));
  const apply = (w: number) => {
    width = clampSidebar(w);
    root.style.setProperty('--sidebar-w', `${width}px`);
  };
  apply(width);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 按下时记住“鼠标离侧栏右边缘多远”，拖动时保持这个偏移，分隔条不会一下跳到鼠标正下方
    const offset = e.clientX - width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => apply(ev.clientX - offset);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      prefs.set('sidebarWidth', width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    apply(SIDEBAR_DEFAULT);
    prefs.set('sidebarWidth', width);
  });
  // 窗口缩小时别让侧栏挤掉照片区（只是临时夹住，不改记住的宽度）
  window.addEventListener('resize', () => apply(prefs.get('sidebarWidth', SIDEBAR_DEFAULT)));
}

// 左侧栏：“已加星标的照片”（星标筛选开关）+ 当前工作目录下的所有相册。
// 相册多的时候按第一层目录分组、可折叠，上面还有个筛选框；排版逻辑在 folderList.ts。

import { buildFolderList, type FolderRow } from './folderList';
import { isStarMode, prefs, store } from './store';
import { esc } from './ui';

export interface SidebarCallbacks {
  openFolder(path: string): void;
  /** 星标筛选开 / 关 */
  toggleStarred(): void;
  folderMenu(path: string, x: number, y: number): void;
  workdirMenu(x: number, y: number): void;
}

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 相册数超过这个就显示筛选框 */
const FILTER_MIN = 8;
/** 相册数超过这个，分组默认折叠（否则默认展开） */
const COLLAPSE_MIN = 30;

export class Sidebar {
  private top: HTMLElement;
  private tools: HTMLElement;
  private filter: HTMLInputElement;
  private foldAll: HTMLButtonElement;
  private list: HTMLElement;
  /** 筛选框文字只在当前工作目录有效，换目录时清掉 */
  private filterWorkdir: string | null = null;
  /** 最近一次渲染出来的第一个相册：筛选框里按回车打开它 */
  private firstPath: string | null = null;

  constructor(
    el: HTMLElement,
    private cb: SidebarCallbacks,
  ) {
    el.innerHTML = `
      <div class="sb-top"></div>
      <div class="sb-tools" hidden>
        <input class="sb-filter" type="search" placeholder="筛选相册（如 2024 旅行）" autocomplete="off" spellcheck="false" />
        <button class="btn icon sb-foldall"></button>
      </div>
      <div class="sb-list"></div>`;
    this.top = el.querySelector('.sb-top')!;
    this.tools = el.querySelector('.sb-tools')!;
    this.filter = el.querySelector('.sb-filter')!;
    this.foldAll = el.querySelector('.sb-foldall')!;
    this.list = el.querySelector('.sb-list')!;

    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sb-workdir')) {
        const r = t.closest('.sb-workdir')!.getBoundingClientRect();
        this.cb.workdirMenu(r.left + 8, r.bottom);
        return;
      }
      const group = t.closest<HTMLElement>('.sb-group');
      if (group) {
        // ⌥/Alt+点击：全部折叠或全部展开（和 Finder 一样）
        if (e.altKey) this.setAllCollapsed(!this.isCollapsed(group.dataset.group!));
        else this.setCollapsed(group.dataset.group!, !this.isCollapsed(group.dataset.group!));
        return;
      }
      const item = t.closest<HTMLElement>('.sb-item');
      if (!item) return;
      if (item.dataset.kind === 'starred') this.cb.toggleStarred();
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

    this.filter.addEventListener('input', () => this.renderList());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.firstPath) this.cb.openFolder(this.firstPath);
      else if (e.key === 'Escape' && this.filter.value) {
        this.filter.value = '';
        this.renderList();
      }
    });
    this.foldAll.addEventListener('click', () => this.setAllCollapsed(this.foldAll.dataset.action === 'fold'));
  }

  render(): void {
    const { library, view } = store;
    const starOn = isStarMode(view);
    const starredTotal = store.totalStarred();
    const hint = starOn ? '再点一次取消星标筛选（Shift+S）' : '只看星标照片，相册列表也只留有星标的（Shift+S）';
    let html = `
      <div class="sb-item sb-starred ${starOn ? 'on' : ''} ${view.kind === 'starred' ? 'active' : ''}" data-kind="starred" title="${hint}">
        <span class="sb-name"><span class="star">★</span> 已加星标的照片</span>
        ${starOn ? '<span class="sb-off">✕</span>' : ''}
        <span class="count">${starredTotal || ''}</span>
      </div>`;
    const wd = library.workdir;
    if (wd) {
      const photos = library.folders.reduce((n, f) => n + f.count, 0);
      html += `
        <div class="sb-head">工作目录${starOn ? '<span class="sb-head-note">· 只列有星标的相册</span>' : ''}</div>
        <div class="sb-workdir" title="${esc(wd)}（点击切换工作目录）">
          <span class="sb-name">📁 ${esc(baseName(wd))}</span>
          <span class="count">${library.folders.length} 个相册 · ${photos} 张</span>
        </div>`;
    }
    this.top.innerHTML = html;
    if (this.filterWorkdir !== wd) {
      this.filterWorkdir = wd;
      this.filter.value = '';
    }
    this.tools.hidden = !wd || library.folders.length < FILTER_MIN;
    this.renderList();
  }

  private collapsedKey(): string {
    return `sbCollapsed:${store.library.workdir ?? ''}`;
  }

  private isCollapsed(key: string): boolean {
    const saved = prefs.get<Record<string, boolean>>(this.collapsedKey(), {});
    return saved[key] ?? store.library.folders.length > COLLAPSE_MIN;
  }

  private setCollapsed(key: string, collapsed: boolean): void {
    const saved = prefs.get<Record<string, boolean>>(this.collapsedKey(), {});
    saved[key] = collapsed;
    prefs.set(this.collapsedKey(), saved);
    this.renderList();
  }

  private setAllCollapsed(collapsed: boolean): void {
    const all = buildFolderList(store.library.folders).rows.filter((r) => r.kind === 'group');
    prefs.set(this.collapsedKey(), Object.fromEntries(all.map((g) => [g.key, collapsed])));
    this.renderList();
  }

  private renderList(): void {
    const { library, view } = store;
    if (!library.workdir) {
      this.list.innerHTML = '';
      this.firstPath = null;
      return;
    }
    const starOn = isStarMode(view);
    const activePath = view.kind === 'folder' ? view.path : null;
    const query = this.tools.hidden ? '' : this.filter.value;
    const { rows, matched, grouped } = buildFolderList(library.folders, {
      query,
      starredOnly: starOn,
      activePath,
      isCollapsed: (k) => this.isCollapsed(k),
    });
    const first = rows.find((r): r is FolderRow => r.kind === 'folder');
    this.firstPath = first ? first.folder.path : null;

    // 筛选中分组都是强制展开的，这时“全部折叠”没意义
    const anyOpen = rows.some((r) => r.kind === 'group' && !r.collapsed);
    this.foldAll.hidden = !grouped || !!query.trim() || starOn;
    this.foldAll.dataset.action = anyOpen ? 'fold' : 'unfold';
    this.foldAll.textContent = anyOpen ? '⊟' : '⊞';
    this.foldAll.title = anyOpen ? '全部折叠（⌥/Alt+点击分组也可以）' : '全部展开';

    let html = '';
    if (!library.folders.length) html = '<div class="sb-empty">（这个目录下没有找到照片）</div>';
    else if (!matched) html = `<div class="sb-empty">${query.trim() ? `没有名字包含“${esc(query.trim())}”的相册` : '还没有带星标的相册'}</div>`;
    for (const r of rows) {
      if (r.kind === 'group') {
        // 星标筛选下数字显示星标数，平时显示照片数
        const num = starOn ? '' : `<span class="count">${r.photos}</span>`;
        html += `
          <div class="sb-group ${r.collapsed ? 'collapsed' : ''}" data-group="${esc(r.key)}" title="${r.albums} 个相册 · ${r.photos} 张（点击${r.collapsed ? '展开' : '折叠'}）">
            <span class="caret">${r.collapsed ? '▸' : '▾'}</span>
            <span class="sb-name">${esc(r.label)}</span>
            ${r.starred ? `<span class="sb-stars">★${r.starred}</span>` : ''}
            ${r.collapsed ? `<span class="count">${r.albums} 个</span>` : num}
          </div>`;
        continue;
      }
      const f = r.folder;
      html += `
        <div class="sb-item ${r.inGroup ? 'in-group' : ''} ${f.path === activePath ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
          <span class="sb-name">${r.prefix ? `<span class="dim">${esc(r.prefix)}</span>` : ''}${esc(f.name)}</span>
          ${f.starred ? `<span class="sb-stars">★${f.starred}</span>` : ''}
          ${starOn ? '' : `<span class="count">${f.count}</span>`}
        </div>`;
    }
    this.list.innerHTML = html;
    this.list.querySelector('.sb-item.active')?.scrollIntoView({ block: 'nearest' });
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

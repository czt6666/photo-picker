// 缩略图网格（虚拟化）。
//
// 一个文件夹可能有上万张照片，如果每张都建一个 <img>，光 DOM 就能把页面拖垮。
// 虚拟化：只为“视口内 + 上下各几行”的照片创建格子（通常一两百个），滚动时把滚出去的格子
// 回收、挪到新位置、换上新图片。总高度用一个撑高的容器模拟，滚动条行为和真的一样。
//
// 另一个细节：拖动滚动条飞速划过几千张时，中途经过的格子如果都去请求缩略图，
// 后端会被一大堆马上就看不见的请求淹没。所以“高速滚动中”先不发请求，停下 100ms 再加载。

import { rawTag, thumbUrl } from './api';
import { store } from './store';
import type { Photo } from './types';

const PAD = 14;
const GAP = 10;
const OVERSCAN_ROWS = 3;

export interface GridCallbacks {
  open(index: number): void;
  toggleStar(photos: Photo[]): void;
  selectionChanged(): void;
}

export class Grid {
  private size = 160;
  private cols = 1;
  private colW = 0;
  private rowH = 0;
  private cells = new Map<number, HTMLElement>();
  private spare: HTMLElement[] = [];
  private raf = 0;
  private lastTop = 0;
  private fast = false;
  private fastTimer = 0;

  constructor(
    private el: HTMLElement,
    private inner: HTMLElement,
    private cb: GridCallbacks,
  ) {
    el.addEventListener('scroll', () => this.onScroll(), { passive: true });
    new ResizeObserver(() => this.relayout()).observe(el);
    inner.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    inner.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.badge')) return; // 连点星标按钮不应打开大图
      const i = this.indexFromEvent(e);
      if (i >= 0) this.cb.open(i);
    });
    el.addEventListener('pointerdown', (e) => {
      // 点空白处取消选择
      if (e.target === el || e.target === inner) {
        store.selection.clear();
        store.anchor = null;
        this.refreshCells();
        this.cb.selectionChanged();
      }
    });
  }

  get cellSize(): number {
    return this.size;
  }

  setCellSize(px: number): void {
    if (px === this.size) return;
    const anchor = this.firstVisibleIndex();
    this.size = px;
    this.el.style.setProperty('--thumb', `${px}px`);
    this.relayout(anchor);
  }

  /** 列表换了（换文件夹、过滤条件变了） */
  reset(keepScroll = false): void {
    for (const c of this.cells.values()) this.recycle(c);
    this.cells.clear();
    if (!keepScroll) this.el.scrollTop = 0;
    this.relayout(keepScroll ? this.firstVisibleIndex() : 0);
  }

  /** 选择/星标变化后刷新已渲染格子的样式 */
  refreshCells(): void {
    for (const [i, c] of this.cells) this.paintState(c, store.visible[i]);
  }

  scrollToIndex(i: number, center = false): void {
    if (i < 0 || this.rowH === 0) return;
    const row = Math.floor(i / this.cols);
    const top = PAD + row * this.rowH;
    const viewH = this.el.clientHeight;
    if (center) {
      this.el.scrollTop = top - (viewH - this.rowH) / 2;
    } else if (top < this.el.scrollTop) {
      this.el.scrollTop = top - PAD;
    } else if (top + this.rowH > this.el.scrollTop + viewH) {
      this.el.scrollTop = top + this.rowH - viewH + PAD;
    }
    this.schedule();
  }

  /** 键盘移动光标：dx=±1 左右，dy=±1 上下一行 */
  moveFocus(dx: number, dy: number, extend: boolean): void {
    const n = store.visible.length;
    if (n === 0) return;
    let i = store.indexOf(store.focus);
    if (i < 0) i = dx < 0 || dy < 0 ? n : -1;
    const next = Math.max(0, Math.min(n - 1, i + dx + dy * this.cols));
    this.selectIndex(next, extend ? 'range' : 'single');
    this.scrollToIndex(next);
  }

  jumpTo(where: 'start' | 'end', extend: boolean): void {
    const n = store.visible.length;
    if (n === 0) return;
    const i = where === 'start' ? 0 : n - 1;
    this.selectIndex(i, extend ? 'range' : 'single');
    this.scrollToIndex(i);
  }

  selectAll(): void {
    store.visible.forEach((p) => store.selection.add(p.path));
    this.refreshCells();
    this.cb.selectionChanged();
  }

  selectIndex(i: number, mode: 'single' | 'toggle' | 'range'): void {
    const p = store.visible[i];
    if (!p) return;
    if (mode === 'toggle') {
      if (store.selection.has(p.path)) store.selection.delete(p.path);
      else store.selection.add(p.path);
      store.anchor = p.path;
    } else if (mode === 'range') {
      const a = store.indexOf(store.anchor);
      const from = a < 0 ? i : a;
      store.selection.clear();
      for (let k = Math.min(from, i); k <= Math.max(from, i); k++) store.selection.add(store.visible[k].path);
      if (a < 0) store.anchor = p.path;
    } else {
      store.selection.clear();
      store.selection.add(p.path);
      store.anchor = p.path;
    }
    store.focus = p.path;
    this.refreshCells();
    this.cb.selectionChanged();
  }

  // ---------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const i = this.indexFromEvent(e);
    if (i < 0) return;
    if ((e.target as HTMLElement).closest('.badge')) {
      e.preventDefault();
      this.cb.toggleStar([store.visible[i]]);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    this.selectIndex(i, e.shiftKey ? 'range' : mod ? 'toggle' : 'single');
    this.el.focus({ preventScroll: true });
  }

  private indexFromEvent(e: Event): number {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell');
    return cell ? Number(cell.dataset.i) : -1;
  }

  private onScroll(): void {
    const top = this.el.scrollTop;
    // 一帧滚过 1.5 屏以上 → 高速滚动，暂停加载缩略图
    if (Math.abs(top - this.lastTop) > this.el.clientHeight * 1.5) {
      this.fast = true;
      clearTimeout(this.fastTimer);
      this.fastTimer = window.setTimeout(() => {
        this.fast = false;
        this.loadPending();
      }, 100);
    }
    this.lastTop = top;
    this.schedule();
  }

  private firstVisibleIndex(): number {
    if (this.rowH === 0) return 0;
    return Math.max(0, Math.floor((this.el.scrollTop - PAD) / this.rowH)) * this.cols;
  }

  private relayout(anchorIndex?: number): void {
    const width = this.el.clientWidth - PAD * 2;
    if (width <= 0) return;
    const anchor = anchorIndex ?? this.firstVisibleIndex();
    this.cols = Math.max(1, Math.floor((width + GAP) / (this.size + GAP)));
    this.colW = width / this.cols;
    this.rowH = this.size + GAP;
    const rows = Math.ceil(store.visible.length / this.cols);
    this.inner.style.height = `${rows ? PAD * 2 + rows * this.rowH - GAP : 0}px`;
    // 布局变了，所有格子位置都要重算
    for (const c of this.cells.values()) this.recycle(c);
    this.cells.clear();
    if (anchor > 0) this.el.scrollTop = PAD + Math.floor(anchor / this.cols) * this.rowH;
    this.update();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.update());
  }

  private update(): void {
    this.raf = 0;
    const list = store.visible;
    if (this.rowH === 0) return;
    const top = this.el.scrollTop;
    const firstRow = Math.max(0, Math.floor((top - PAD) / this.rowH) - OVERSCAN_ROWS);
    const lastRow = Math.floor((top + this.el.clientHeight - PAD) / this.rowH) + OVERSCAN_ROWS;
    const from = firstRow * this.cols;
    const to = Math.min(list.length, (lastRow + 1) * this.cols);

    for (const [i, c] of this.cells) {
      if (i < from || i >= to) {
        this.recycle(c);
        this.cells.delete(i);
      }
    }
    // 由远及近地设置 src：后端对可见缩略图是“后进先出”，最后请求的（视口正中那几行）最先出图
    const order: number[] = [];
    for (let i = from; i < to; i++) if (!this.cells.has(i)) order.push(i);
    const mid = (top + this.el.clientHeight / 2 - PAD) / this.rowH;
    order.sort((a, b) => Math.abs(Math.floor(b / this.cols) - mid) - Math.abs(Math.floor(a / this.cols) - mid));
    for (const i of order) {
      const c = this.spare.pop() ?? this.createCell();
      this.place(c, i, list[i]);
      if (!c.isConnected) this.inner.appendChild(c);
      this.cells.set(i, c);
    }
  }

  private createCell(): HTMLElement {
    const c = document.createElement('div');
    c.className = 'cell';
    c.innerHTML =
      '<span class="frame"><img class="thumb" decoding="async" draggable="false" alt=""><button class="badge" tabindex="-1" title="星标（空格）">★</button><span class="raw-tag"></span></span>';
    const img = c.querySelector('img')!;
    img.addEventListener('load', () => c.classList.add('loaded'));
    img.addEventListener('error', () => {
      if (img.getAttribute('src')) c.classList.add('broken');
    });
    return c;
  }

  private place(c: HTMLElement, i: number, p: Photo): void {
    const row = Math.floor(i / this.cols);
    const col = i % this.cols;
    c.style.transform = `translate(${PAD + col * this.colW}px, ${PAD + row * this.rowH}px)`;
    c.style.width = `${this.colW}px`;
    c.style.height = `${this.size}px`;
    c.style.visibility = '';
    c.dataset.i = String(i);
    const tag = rawTag(p);
    c.title = p.companions.length ? `${p.name}\n同名文件：${p.companions.join('、')}` : p.name;
    const tagEl = c.querySelector<HTMLElement>('.raw-tag')!;
    tagEl.textContent = tag;
    tagEl.hidden = !tag;
    const img = c.querySelector('img')!;
    const url = thumbUrl(p);
    if (img.dataset.url !== url) {
      c.classList.remove('loaded', 'broken');
      img.dataset.url = url;
      if (this.fast) {
        img.removeAttribute('src');
        c.dataset.pending = '1';
      } else {
        img.src = url;
        delete c.dataset.pending;
      }
    }
    this.paintState(c, p);
  }

  private loadPending(): void {
    for (const c of this.cells.values()) {
      if (c.dataset.pending) {
        const img = c.querySelector('img')!;
        img.src = img.dataset.url!;
        delete c.dataset.pending;
      }
    }
  }

  private paintState(c: HTMLElement, p: Photo | undefined): void {
    if (!p) return;
    c.classList.toggle('selected', store.selection.has(p.path));
    c.classList.toggle('focused', store.focus === p.path);
    c.classList.toggle('starred', p.starred);
  }

  private recycle(c: HTMLElement): void {
    c.style.visibility = 'hidden';
    this.spare.push(c);
  }
}

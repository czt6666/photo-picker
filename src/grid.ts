// 缩略图网格（虚拟化）。
//
// 一个文件夹可能有上万张照片，如果每张都建一个 <img>，光 DOM 就能把页面拖垮。
// 虚拟化：只为“视口内 + 上下各几行”的照片创建格子（通常一两百个），滚动时把滚出去的格子
// 回收、挪到新位置、换上新图片。总高度用一个撑高的容器模拟，滚动条行为和真的一样。
//
// 连续翻动：列表里可以首尾相接地放着好几个相册（store.sections），每个相册另起一行，
// 相册之间有一条带相册名的分界线；快滚到底时通知外面去接下一个相册。排版计算在 gridLayout.ts。
//
// 另一个细节：拖动滚动条飞速划过几千张时，中途经过的格子如果都去请求缩略图，
// 后端会被一大堆马上就看不见的请求淹没。所以“高速滚动中”先不发请求，停下 100ms 再加载。

import { rawTag, thumbUrl } from './api';
import { GridLayout } from './gridLayout';
import { ratingStars } from './rating';
import { store } from './store';
import { esc } from './ui';
import type { Photo } from './types';

const PAD = 10;
const GAP = 4;
/** 格子高 = 宽 × 0.8：大多数照片是横的（3:2、4:3），正方形格子上下会空出一大截；
 *  矮一点的格子让行距和左右间距差不多，竖图只是稍微小一点 */
const CELL_ASPECT = 0.8;
const OVERSCAN_ROWS = 3;
/** 相册之间分界线的高度 */
const HEAD_H = 36;

export interface GridCallbacks {
  open(index: number): void;
  toggleStar(photos: Photo[]): void;
  selectionChanged(): void;
  /** 分界线上显示的相册名 */
  sectionName(dir: string): string;
  /** 滚动后，视口最上面换成了另一个相册 */
  sectionChanged(dir: string): void;
  /** 快滚到底了：可以把下一个相册接上来 */
  nearEnd(): void;
}

export class Grid {
  private size = 160;
  private cols = 1;
  private colW = 0;
  private rowH = 0;
  private layout = new GridLayout([], { cols: 1, rowH: 0, gap: GAP, pad: PAD, headH: HEAD_H, headFirst: false });
  private cells = new Map<number, HTMLElement>();
  /** 已经放到页面上的分界线，按段的序号 */
  private heads = new Map<number, HTMLElement>();
  /** 视口最上面的相册 */
  private curDir: string | null = null;
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

  private get cellH(): number {
    return Math.round(this.size * CELL_ASPECT);
  }

  get cellSize(): number {
    return this.size;
  }

  setCellSize(px: number): void {
    if (px === this.size) return;
    const anchor = this.firstVisibleIndex();
    this.size = px;
    this.el.style.setProperty('--thumb', `${px}px`);
    this.el.style.setProperty('--thumb-h', `${this.cellH}px`);
    this.relayout(anchor);
  }

  /** 列表换了（换文件夹、过滤条件变了） */
  reset(keepScroll = false): void {
    for (const c of this.cells.values()) this.recycle(c);
    this.cells.clear();
    if (!keepScroll) {
      this.el.scrollTop = 0;
      this.curDir = null;
    }
    this.relayout(keepScroll ? this.firstVisibleIndex() : 0);
  }

  /** 列表末尾接上了新的相册：只重新排版，滚动位置不动 */
  extend(): void {
    this.relayout(undefined, true);
  }

  /** 重新检查一遍（比如“下一个相册”加载完了，看看还要不要接着接） */
  poke(): void {
    this.schedule();
  }

  /** 选择/星标变化后刷新已渲染格子的样式 */
  refreshCells(): void {
    for (const [i, c] of this.cells) this.paintState(c, store.visible[i]);
  }

  scrollToIndex(i: number, center = false): void {
    const p = this.layout.pos(i);
    if (!p || this.rowH === 0) return;
    const top = p.y;
    const viewH = this.el.clientHeight;
    if (center) {
      this.el.scrollTop = top - (viewH - this.rowH) / 2;
    } else if (top < this.el.scrollTop) {
      // 回到相册的第一行时把上面的分界线也露出来
      this.el.scrollTop = top - PAD - (p.row === 0 ? p.band.head : 0);
    } else if (top + this.rowH > this.el.scrollTop + viewH) {
      this.el.scrollTop = top + this.rowH - viewH + PAD;
    }
    this.schedule();
  }

  /** 键盘移动光标：dx=±1 左右，dy=±1 上下一行 */
  moveFocus(dx: number, dy: number, extend: boolean): void {
    const n = store.visible.length;
    if (n === 0) return;
    const next = this.layout.step(store.indexOf(store.focus), dx, dy, n);
    this.selectIndex(next, extend ? 'range' : 'single');
    this.scrollToIndex(next);
  }

  jumpTo(where: 'start' | 'end', extend: boolean): void {
    const n = store.visible.length;
    if (n === 0) return;
    // 连着显示好几个相册时，Home / End 只到光标所在（没有光标就是最上面）那个相册的头尾
    const f = store.indexOf(store.focus);
    const b = f >= 0 ? this.layout.bandOf(f) : this.layout.bands.find((x) => x.dir === this.curDir);
    const i = where === 'start' ? (b?.start ?? 0) : b ? b.start + b.count - 1 : n - 1;
    this.selectIndex(i, extend ? 'range' : 'single');
    this.scrollToIndex(i);
  }

  /** 全选：连着显示好几个相册时，只选光标所在（没有光标就是最上面）的那个相册 */
  selectAll(): void {
    const f = store.indexOf(store.focus);
    const b = f >= 0 ? this.layout.bandOf(f) : this.layout.bands.find((x) => x.dir === this.curDir);
    const list = b ? store.visible.slice(b.start, b.start + b.count) : store.visible;
    list.forEach((p) => store.selection.add(p.path));
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
    return this.layout.firstIndexAt(this.el.scrollTop);
  }

  private relayout(anchorIndex?: number, keepScroll = false): void {
    const width = this.el.clientWidth - PAD * 2;
    if (width <= 0) return;
    const anchor = anchorIndex ?? this.firstVisibleIndex();
    this.cols = Math.max(1, Math.floor((width + GAP) / (this.size + GAP)));
    this.colW = width / this.cols;
    this.rowH = this.cellH + GAP;
    this.layout = new GridLayout(store.sections, {
      cols: this.cols,
      rowH: this.rowH,
      gap: GAP,
      pad: PAD,
      headH: HEAD_H,
      // 看单个相册时顶栏已经写着相册名，第一段上面不用再放；星标汇总里每个相册都标出来
      headFirst: store.view.kind !== 'folder',
    });
    this.inner.style.height = `${this.layout.height}px`;
    // 布局变了，所有格子位置都要重算
    for (const c of this.cells.values()) this.recycle(c);
    this.cells.clear();
    for (const h of this.heads.values()) h.remove();
    this.heads.clear();
    if (!keepScroll && anchor > 0) this.el.scrollTop = this.layout.pos(anchor)?.y ?? 0;
    this.update();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.update());
  }

  private update(): void {
    this.raf = 0;
    const list = store.visible;
    if (this.rowH === 0) return;
    const L = this.layout;
    const top = this.el.scrollTop;
    const viewH = this.el.clientHeight;
    const over = OVERSCAN_ROWS * this.rowH;
    const y0 = top - over;
    const y1 = top + viewH + over;
    const [from, to] = L.range(y0, y1);

    for (const [i, c] of this.cells) {
      if (i < from || i >= to) {
        this.recycle(c);
        this.cells.delete(i);
      }
    }
    // 由远及近地设置 src：后端对可见缩略图是“后进先出”，最后请求的（视口正中那几行）最先出图
    const order: number[] = [];
    for (let i = from; i < to; i++) if (!this.cells.has(i)) order.push(i);
    const mid = top + viewH / 2 - this.rowH / 2;
    const far = (i: number) => Math.abs((L.pos(i)?.y ?? 0) - mid);
    order.sort((a, b) => far(b) - far(a));
    for (const i of order) {
      const c = this.spare.pop() ?? this.createCell();
      this.place(c, i, list[i]);
      if (!c.isConnected) this.inner.appendChild(c);
      this.cells.set(i, c);
    }

    // 相册之间的分界线
    L.bands.forEach((b, k) => {
      const show = b.head > 0 && b.top < y1 && b.top + b.head > y0;
      const h = this.heads.get(k);
      if (!show) {
        h?.remove();
        this.heads.delete(k);
      } else if (!h) {
        const el = document.createElement('div');
        el.className = 'sec-head';
        el.style.transform = `translateY(${b.top}px)`;
        el.style.height = `${b.head}px`;
        el.innerHTML = `<span class="sec-name">${esc(this.cb.sectionName(b.dir))}</span><span class="sec-count">${b.count} 张</span>`;
        this.inner.appendChild(el);
        this.heads.set(k, el);
      }
    });

    // 视口最上面是哪个相册；滚到最底时算最后一个（它可能不够高，永远到不了最上面）
    const atEnd = top > 0 && top + viewH >= L.height - 1;
    const cur = atEnd ? L.bands[L.bands.length - 1] : L.bandAt(top + PAD);
    if (cur && cur.dir !== this.curDir) {
      this.curDir = cur.dir;
      this.cb.sectionChanged(cur.dir);
    }
    if (top + viewH > L.height - viewH * 1.5) this.cb.nearEnd();
  }

  private createCell(): HTMLElement {
    const c = document.createElement('div');
    c.className = 'cell';
    c.innerHTML =
      '<span class="frame"><img class="thumb" decoding="async" draggable="false" alt=""><button class="badge" tabindex="-1" title="星标（空格）">★</button><span class="raw-tag"></span><span class="rate" hidden></span></span>';
    const img = c.querySelector('img')!;
    img.addEventListener('load', () => c.classList.add('loaded'));
    img.addEventListener('error', () => {
      if (img.getAttribute('src')) c.classList.add('broken');
    });
    return c;
  }

  private place(c: HTMLElement, i: number, p: Photo): void {
    const at = this.layout.pos(i);
    c.style.transform = `translate(${PAD + (at?.col ?? 0) * this.colW}px, ${at?.y ?? 0}px)`;
    c.style.width = `${this.colW}px`;
    c.style.height = `${this.cellH}px`;
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
    // 星级另外显示在右下角（和左下角的星标是两回事）
    const stars = ratingStars(p.rating);
    const rate = c.querySelector<HTMLElement>('.rate')!;
    if (rate.textContent !== stars) rate.textContent = stars;
    rate.hidden = !stars;
  }

  private recycle(c: HTMLElement): void {
    c.style.visibility = 'hidden';
    // 挪回顶上：藏起来的格子留在老位置（可能在很下面）的话，照样会把滚动区域撑高，
    // 换到照片少的视图（比如星标筛选）后就能滚到一大片空白里
    c.style.transform = 'translate(0, 0)';
    this.spare.push(c);
  }
}

// 全屏看图：手机左右滑、双击/双指放大；电脑上滚轮或方向键翻页，空格选中。
//
// 不卡的关键是“先糊后清”：缩略图在网格里已经下载过了（浏览器缓存里有），
// 翻到一张时先把缩略图拉大垫底（瞬间出图），同时去取 2048 像素的预览图，到了再盖上去。
// 再顺手把下一两张的预览图提前下好，所以连续往后翻时基本每张都是秒开。

import { h, t } from './common';

export interface ViewerItem {
  id: number;
  name: string;
  width: number;
  height: number;
  thumb: string;
  preview: string;
}

export interface ViewerOptions {
  isPicked(item: ViewerItem): boolean;
  /** 不给就是只读（摄影师预览用） */
  onTogglePick?(item: ViewerItem): void;
  noteOf(item: ViewerItem): string;
  onEditNote?(item: ViewerItem): void;
  /** 额外的一行说明，比如摄影师看到的“小林、小美 选了” */
  extraOf?(item: ViewerItem): string;
  onClose?(item: ViewerItem): void;
}

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 280;

export class Viewer {
  private root: HTMLElement;
  private stage: HTMLElement;
  private slide: HTMLElement;
  private low: HTMLImageElement;
  private high: HTMLImageElement;
  private posEl: HTMLElement;
  private nameEl: HTMLElement;
  private extraEl: HTMLElement;
  private noteEl: HTMLElement;
  private pickBtn: HTMLButtonElement;
  private noteBtn: HTMLButtonElement;

  private list: ViewerItem[] = [];
  private index = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private animating = false;
  private preloaded = new Map<string, HTMLImageElement>();
  private pushedHistory = false;

  constructor(private opts: ViewerOptions) {
    this.low = h('img', { class: 'v-img v-low', alt: '', draggable: 'false' });
    this.high = h('img', { class: 'v-img v-high', alt: '', draggable: 'false' });
    this.slide = h('div', { class: 'v-slide' }, this.low, this.high);
    this.stage = h('div', { class: 'v-stage' }, this.slide);
    const closeBtn = h('button', { class: 'v-btn', title: t('关闭 (Esc)', 'Close (Esc)') }, '✕');
    this.posEl = h('span', { class: 'v-pos' });
    this.nameEl = h('span', { class: 'v-name' });
    this.extraEl = h('div', { class: 'v-extra' });
    this.noteEl = h('div', { class: 'v-note' });
    this.pickBtn = h('button', { class: 'v-pick' });
    this.noteBtn = h('button', { class: 'v-btn v-note-btn' }, t('✎ 备注', '✎ Note'));
    const prev = h('button', { class: 'v-nav prev', title: '←' }, '‹');
    const next = h('button', { class: 'v-nav next', title: '→' }, '›');
    this.root = h(
      'div',
      { class: 'viewer', hidden: true },
      this.stage,
      h('div', { class: 'v-top' }, closeBtn, this.posEl, this.nameEl),
      prev,
      next,
      h(
        'div',
        { class: 'v-bottom' },
        this.extraEl,
        this.noteEl,
        h('div', { class: 'v-actions' }, opts.onEditNote ? this.noteBtn : null, opts.onTogglePick ? this.pickBtn : null),
      ),
    );
    document.body.append(this.root);

    closeBtn.addEventListener('click', () => this.close());
    prev.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));
    this.pickBtn.addEventListener('click', () => this.togglePick());
    this.noteBtn.addEventListener('click', () => this.cur && opts.onEditNote?.(this.cur));
    window.addEventListener('popstate', () => {
      if (this.isOpen) {
        this.pushedHistory = false;
        this.close();
      }
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener('dblclick', (e) => {
      if (performance.now() - this.lastTouchAt < 800) return; // 触屏的双击在 onTap 里自己判断
      this.toggleZoom(e.clientX, e.clientY);
    });
    this.bindPointers();
    window.addEventListener('resize', () => this.isOpen && this.applyTransform());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  private get cur(): ViewerItem | undefined {
    return this.list[this.index];
  }

  open(list: ViewerItem[], index: number) {
    this.list = list;
    this.index = Math.max(0, Math.min(index, list.length - 1));
    this.root.hidden = false;
    document.body.classList.add('viewer-open');
    if (!this.pushedHistory) {
      // 手机上习惯按返回键关大图，所以压一条历史记录
      history.pushState({ viewer: true }, '');
      this.pushedHistory = true;
    }
    this.show();
  }

  close() {
    if (!this.isOpen) return;
    const item = this.cur;
    this.root.hidden = true;
    document.body.classList.remove('viewer-open');
    this.high.removeAttribute('src');
    if (this.pushedHistory) {
      this.pushedHistory = false;
      history.back();
    }
    if (item) this.opts.onClose?.(item);
  }

  /** 选中状态、备注变了以后刷新底栏 */
  refresh() {
    const item = this.cur;
    if (!item || !this.isOpen) return;
    const picked = this.opts.isPicked(item);
    this.pickBtn.classList.toggle('on', picked);
    this.pickBtn.textContent = picked ? t('♥ 已选', '♥ Picked') : t('♡ 选这张', '♡ Pick');
    this.root.classList.toggle('picked', picked);
    const note = this.opts.noteOf(item);
    this.noteEl.textContent = note ? '✎ ' + note : '';
    this.noteEl.hidden = !note;
    const extra = this.opts.extraOf?.(item) ?? '';
    this.extraEl.textContent = extra;
    this.extraEl.hidden = !extra;
    this.posEl.textContent = `${this.index + 1} / ${this.list.length}`;
    this.nameEl.textContent = item.name;
  }

  private togglePick() {
    const item = this.cur;
    if (item && this.opts.onTogglePick) {
      this.opts.onTogglePick(item);
      this.refresh();
    }
  }

  private show() {
    const item = this.cur;
    if (!item) return this.close();
    this.resetZoom(false);
    this.refresh();
    // 先糊后清：缩略图垫底，预览图到了再淡入
    this.low.src = item.thumb;
    this.high.classList.remove('ready');
    const url = item.preview;
    this.high.src = url;
    const reveal = () => {
      if (this.cur === item) this.high.classList.add('ready');
    };
    if (this.high.complete && this.high.naturalWidth) reveal();
    else this.high.decode().then(reveal, reveal);
    this.preloadAround();
  }

  private preloadAround() {
    const want = new Set<string>();
    for (const d of [1, 2, -1]) {
      const it = this.list[this.index + d];
      if (it) want.add(it.preview);
    }
    for (const [url, img] of this.preloaded) {
      if (!want.has(url)) {
        img.src = '';
        this.preloaded.delete(url);
      }
    }
    for (const url of want) {
      if (this.preloaded.has(url)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      this.preloaded.set(url, img);
    }
  }

  go(dir: number) {
    const target = this.index + dir;
    if (this.animating || target < 0 || target >= this.list.length) {
      this.bounce(dir);
      return;
    }
    this.animating = true;
    const w = this.stage.clientWidth;
    this.slide.style.transition = 'transform 140ms ease-in';
    this.slide.style.transform = `translate3d(${-dir * w}px,0,0)`;
    window.setTimeout(() => {
      this.index = target;
      this.slide.style.transition = 'none';
      this.slide.style.transform = `translate3d(${dir * w * 0.25}px,0,0)`;
      this.show();
      requestAnimationFrame(() => {
        this.slide.style.transition = 'transform 160ms ease-out';
        this.slide.style.transform = 'translate3d(0,0,0)';
        window.setTimeout(() => {
          this.animating = false;
          this.applyTransform();
        }, 170);
      });
    }, 140);
  }

  private bounce(dir: number) {
    if (this.animating) return;
    this.slide.style.transition = 'transform 120ms ease-out';
    this.slide.style.transform = `translate3d(${-dir * 24}px,0,0)`;
    window.setTimeout(() => this.applyTransform(true), 120);
  }

  // ---------- 缩放 ----------

  /** 图片按 contain 放进舞台后的显示尺寸（未放大时） */
  private fitted() {
    const item = this.cur!;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const r = Math.min(sw / item.width, sh / item.height);
    return { w: item.width * r, h: item.height * r, sw, sh };
  }

  private clampPan() {
    const { w, h: hh, sw, sh } = this.fitted();
    const mx = Math.max(0, (w * this.scale - sw) / 2);
    const my = Math.max(0, (hh * this.scale - sh) / 2);
    this.tx = Math.max(-mx, Math.min(mx, this.tx));
    this.ty = Math.max(-my, Math.min(my, this.ty));
  }

  private applyTransform(animate = false) {
    this.slide.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    this.slide.style.transform = `translate3d(${this.tx}px,${this.ty}px,0) scale(${this.scale})`;
    this.root.classList.toggle('zoomed', this.scale > 1.01);
  }

  private resetZoom(animate = true) {
    this.scale = 1;
    this.tx = this.ty = 0;
    this.applyTransform(animate);
  }

  /** 以屏幕上某点为中心缩放到 s 倍：让手指/鼠标下面那个像素保持不动 */
  private zoomAt(s: number, clientX: number, clientY: number, animate = false) {
    const rect = this.stage.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    const ns = Math.max(1, Math.min(MAX_SCALE, s));
    this.tx = px - (px - this.tx) * (ns / this.scale);
    this.ty = py - (py - this.ty) * (ns / this.scale);
    this.scale = ns;
    this.clampPan();
    this.applyTransform(animate);
  }

  private toggleZoom(x: number, y: number) {
    if (this.scale > 1.01) this.resetZoom();
    else this.zoomAt(2.5, x, y, true);
  }

  // ---------- 手势 ----------

  private bindPointers() {
    const pts = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'swipe' | 'pan' | 'pinch' = 'none';
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let baseTx = 0;
    let baseTy = 0;
    let pinchDist = 0;
    let pinchScale = 1;
    let moved = false;
    let lastTap = { t: 0, x: 0, y: 0 };
    let tapTimer = 0;

    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const mid = () => {
      const [a, b] = [...pts.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    this.stage.addEventListener('pointerdown', (e) => {
      if (this.animating) return;
      this.stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        startX = e.clientX;
        startY = e.clientY;
        startT = performance.now();
        baseTx = this.tx;
        baseTy = this.ty;
        moved = false;
        mode = this.scale > 1.01 ? 'pan' : 'swipe';
      } else if (pts.size === 2) {
        mode = 'pinch';
        pinchDist = dist();
        pinchScale = this.scale;
        moved = true;
      }
    });

    this.stage.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (mode === 'pinch' && pts.size === 2) {
        const m = mid();
        this.zoomAt((pinchScale * dist()) / pinchDist, m.x, m.y);
      } else if (mode === 'pan') {
        this.tx = baseTx + dx;
        this.ty = baseTy + dy;
        this.clampPan();
        this.applyTransform();
      } else if (mode === 'swipe' && moved) {
        // 到头了再拉就有阻力
        const atEdge = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.list.length - 1);
        this.slide.style.transition = 'none';
        this.slide.style.transform = `translate3d(${atEdge ? dx / 4 : dx}px,0,0)`;
      }
    });

    const end = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size > 0) {
        // 双指松开一根：剩下那根接着拖
        const [rest] = [...pts.values()];
        startX = rest.x;
        startY = rest.y;
        baseTx = this.tx;
        baseTy = this.ty;
        mode = this.scale > 1.01 ? 'pan' : 'none';
        return;
      }
      const dx = e.clientX - startX;
      const dt = performance.now() - startT;
      if (e.pointerType !== 'mouse') this.lastTouchAt = performance.now();
      if (mode === 'swipe' && moved) {
        const fast = Math.abs(dx) / Math.max(dt, 1) > 0.45;
        const far = Math.abs(dx) > Math.min(90, this.stage.clientWidth * 0.18);
        if ((fast || far) && Math.abs(dx) > 20) this.go(dx < 0 ? 1 : -1);
        else this.applyTransform(true);
      } else if (mode === 'pinch' && this.scale < 1.05) {
        this.resetZoom();
      } else if (!moved && e.type === 'pointerup') {
        this.onTap(e);
      }
      mode = 'none';
    };

    this.onTap = (e: PointerEvent) => {
      const now = performance.now();
      if (e.pointerType !== 'mouse' && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        clearTimeout(tapTimer);
        lastTap.t = 0;
        this.toggleZoom(e.clientX, e.clientY);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      clearTimeout(tapTimer);
      // 单击：收起/显示上下栏（等一下，确认不是双击）
      tapTimer = window.setTimeout(() => this.root.classList.toggle('bare'), DOUBLE_TAP_MS);
    };

    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', end);
  }

  private onTap: (e: PointerEvent) => void = () => {};
  private lastTouchAt = 0;

  private wheelAcc = 0;
  private wheelLast = 0;
  private flipLast = 0;

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      // 触控板双指捏合在浏览器里表现为 ctrl+滚轮
      this.zoomAt(this.scale * Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
      return;
    }
    if (this.scale > 1.01) {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.clampPan();
      this.applyTransform();
      return;
    }
    // 滚轮翻页（和桌面版一样）。鼠标一格 ≈ 100，触控板是一串小数值，攒够了才翻一张。
    const now = performance.now();
    if (now - this.wheelLast > 200) this.wheelAcc = 0;
    this.wheelLast = now;
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    this.wheelAcc += e.deltaMode === 1 ? d * 40 : d;
    if (Math.abs(this.wheelAcc) >= 60 && now - this.flipLast > 90) {
      this.flipLast = now;
      const dir = this.wheelAcc > 0 ? 1 : -1;
      this.wheelAcc = 0;
      this.go(dir);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest?.('input, textarea')) return;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        this.go(-1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
        this.go(1);
        break;
      case ' ':
      case 'Enter':
        this.togglePick();
        break;
      case 'Escape':
        if (this.scale > 1.01) this.resetZoom();
        else this.close();
        break;
      case 'z':
      case 'Z': {
        const r = this.stage.getBoundingClientRect();
        this.toggleZoom(r.left + r.width / 2, r.top + r.height / 2);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }
}

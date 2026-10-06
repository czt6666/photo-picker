// 单张看图（Picasa 的“双击放大”视图）。
//
// 流畅翻图的三板斧：
// 1. **先糊后清**：翻到一张时，立刻把已缓存的 400px 缩略图拉伸铺满（几乎零成本），
//    同时去加载清晰版；清晰版在后台解码完成后再替换上去。眼睛看到的是“瞬间切换 + 随即变清晰”。
// 2. **预加载**：当前这张显示后，按翻页方向提前加载并解码后面 2 张、前面 1 张。
//    正常节奏翻图时，下一张早已解码好，直接插进页面，完全无等待。
// 3. **按屏幕尺寸取图**：清晰版不是原图，而是后端缩到“屏幕物理像素”大小的版本
//    （例如 4500 万像素的原图 → 3200px 宽），解码时间和内存都降到几分之一。
//    放大到 1:1 看对焦时才加载原图。
//
// 另外，按住方向键或猛滚滚轮“快速翻”时，中间路过的照片只显示缩略图、不加载清晰版
// （停下 90ms 才加载），避免后端被一堆马上就会离开的请求塞满。

import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, needsTranscode, photoUrl, rawTag, thumbUrl } from './api';
import { ImageLoader } from './loader';
import type { Photo, PhotoInfo } from './types';
import { WheelStepper } from './wheel';

const BUCKETS = [1024, 1600, 2048, 2560, 3200, 4096, 5120, 6144];
const RAPID_MS = 160;
/** 两次翻页间隔短于它 = 正在“飞”：不预加载（预加载的图转眼就会被跳过，反而占住后台线程） */
const FLYING_MS = 80;
const SETTLE_MS = 90;
const MAX_SCALE = 8;

export interface ViewerCallbacks {
  close(lastPath: string | null): void;
  toggleStar(photos: Photo[]): Promise<void>;
}

interface Dims {
  w: number;
  h: number;
  /** 'exact' = 原图解码所得；'info' = 后端读文件头；'guess' = 由预览/缩略图推测（只有比例可信） */
  src: 'exact' | 'info' | 'guess' | 'none';
}

/** 性能记录：每次翻页到“清晰图显示”的耗时。端到端测试读取它。 */
export interface NavPerf {
  index: number;
  ms: number;
  cached: boolean;
}
declare global {
  interface Window {
    __ppPerf?: NavPerf[];
  }
}

export class Viewer {
  private list: Photo[] = [];
  private index = -1;
  private isOpen = false;
  private token = 0;
  private lastNavT = 0;
  private navDir = 1;
  private loadTimer = 0;
  private preTimer = 0;
  private slowTimer = 0;
  private navStart = 0;
  private main: HTMLImageElement | null = null;
  private mainFull = false;
  private dims: Dims = { w: 0, h: 0, src: 'none' };
  /** null = 适合窗口；数字 = CSS 像素 / 图像像素 */
  private scale: number | null = null;
  private panX = 0;
  private panY = 0;
  private drag: { x: number; y: number; px: number; py: number } | null = null;
  private infoCache = new Map<string, PhotoInfo>();
  private wheel = new WheelStepper();
  private loader = new ImageLoader(6);
  private strip: Strip;

  private stage: HTMLElement;
  private low: HTMLImageElement;
  private nameEl: HTMLElement;
  private posEl: HTMLElement;
  private infoEl: HTMLElement;
  private starBtn: HTMLButtonElement;
  private zoomBtn: HTMLButtonElement;
  private starMark: HTMLElement;
  private errorEl: HTMLElement;

  constructor(
    private root: HTMLElement,
    private cb: ViewerCallbacks,
  ) {
    const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    this.stage = $('.v-stage');
    this.low = $<HTMLImageElement>('.v-low');
    this.nameEl = $('.v-name');
    this.posEl = $('.v-pos');
    this.infoEl = $('.v-info');
    this.starBtn = $<HTMLButtonElement>('.v-star');
    this.zoomBtn = $<HTMLButtonElement>('.v-zoom');
    this.starMark = $('.v-starmark');
    this.errorEl = $('.v-error');
    this.strip = new Strip($('.v-strip'), $('.v-strip-inner'), (i) => this.go(i));

    $('.v-back').addEventListener('click', () => this.close());
    this.starBtn.addEventListener('click', () => this.toggleStar());
    this.zoomBtn.addEventListener('click', () => this.toggleActualSize());
    $('.v-full').addEventListener('click', () => this.toggleFullscreen());

    // 上一张/下一张的悬浮箭头
    for (const [cls, d] of [['v-prev', -1], ['v-next', 1]] as const) {
      const b = document.createElement('button');
      b.className = `v-nav ${cls}`;
      b.textContent = d < 0 ? '‹' : '›';
      b.addEventListener('click', () => this.step(d));
      this.stage.appendChild(b);
    }

    this.stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.v-nav')) return;
      this.toggleActualSize(e);
    });
    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    new ResizeObserver(() => {
      if (!this.isOpen) return;
      this.layout();
      this.maybeUpgrade();
    }).observe(this.stage);
    this.low.addEventListener('load', () => {
      if (this.dims.src === 'none') this.guessDims(this.low);
      if (!this.main) this.fixAspect(this.low);
      this.layout();
    });
  }

  get opened(): boolean {
    return this.isOpen;
  }

  get current(): Photo | null {
    return this.list[this.index] ?? null;
  }

  open(list: Photo[], index: number): void {
    // 拿一份快照：看图过程中取消星标，照片不会从眼前消失（回到网格时再按过滤条件刷新）
    this.list = list.slice();
    this.isOpen = true;
    this.root.hidden = false;
    this.strip.setList(this.list);
    this.index = -1;
    this.wheel.reset();
    this.go(index, true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    clearTimeout(this.loadTimer);
    clearTimeout(this.preTimer);
    this.loader.cancelExcept(new Set());
    this.setMain(null);
    this.low.removeAttribute('src');
    void getCurrentWindow()
      .isFullscreen()
      .then((fs) => (fs ? getCurrentWindow().setFullscreen(false) : undefined))
      .catch(() => {});
    this.cb.close(this.current?.path ?? null);
  }

  /** 星标变化后（可能来自其它入口）刷新显示 */
  refreshStar(): void {
    const p = this.current;
    if (!p) return;
    this.starBtn.textContent = p.starred ? '★ 已加星标' : '☆ 星标';
    this.starBtn.classList.toggle('on', p.starred);
    this.starMark.hidden = !p.starred;
    this.strip.refresh();
  }

  onKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k === '8') {
      void this.toggleStar();
      return true;
    }
    if (mod) return false;
    switch (k) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
        this.step(1);
        return true;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        this.step(-1);
        return true;
      case ' ':
        // 空格 = 加/取消星标（选片时最顺手的键）
        void this.toggleStar();
        return true;
      case 'Home':
        this.go(0);
        return true;
      case 'End':
        this.go(this.list.length - 1);
        return true;
      case 's':
      case 'S':
        void this.toggleStar();
        return true;
      case 'Escape':
        if (this.scale !== null) this.fit();
        else this.close();
        return true;
      case 'Enter':
      case 'Backspace':
        this.close();
        return true;
      case '1':
      case 'z':
      case 'Z':
        this.toggleActualSize();
        return true;
      case '0':
        this.fit();
        return true;
      case '=':
      case '+':
        this.zoomBy(1.25);
        return true;
      case '-':
        this.zoomBy(0.8);
        return true;
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 翻页与加载
  // ---------------------------------------------------------------------------

  step(d: number): void {
    const n = this.list.length;
    const i = this.index + d;
    if (i < 0 || i >= n) {
      this.bump(d);
      return;
    }
    this.go(i);
  }

  go(i: number, first = false): void {
    if (i < 0 || i >= this.list.length || i === this.index) return;
    const now = performance.now();
    const interval = now - this.lastNavT;
    const rapid = !first && interval < RAPID_MS;
    const flying = !first && interval < FLYING_MS;
    this.navDir = i >= this.index ? 1 : -1;
    this.lastNavT = now;
    this.navStart = now;
    this.index = i;
    const tok = ++this.token;
    const p = this.list[i];

    this.scale = null;
    this.panX = this.panY = 0;
    this.errorEl.hidden = true;
    this.stage.classList.remove('loading');
    clearTimeout(this.loadTimer);
    clearTimeout(this.preTimer);
    clearTimeout(this.slowTimer);

    // RAW+JPG：标题里注明同名 RAW，例如 “IMG_0001.JPG + CR3”
    const tag = rawTag(p);
    this.nameEl.textContent = tag ? `${p.name} + ${tag}` : p.name;
    this.posEl.textContent = `${i + 1} / ${this.list.length}`;
    this.refreshStar();
    this.strip.setCurrent(i);

    const info = this.infoCache.get(p.path);
    this.dims = info ? { w: info.width, h: info.height, src: 'info' } : { w: 0, h: 0, src: 'none' };
    this.showInfo(p, info);
    if (!info) {
      api.photoInfo(p.path).then(
        (inf) => {
          this.infoCache.set(p.path, inf);
          if (tok !== this.token) return;
          if (this.dims.src !== 'exact' && inf.width > 0) {
            this.dims = { w: inf.width, h: inf.height, src: 'info' };
            if (this.main) this.fixAspect(this.main);
            this.layout();
            this.maybeUpgrade();
          }
          this.showInfo(p, inf);
        },
        () => {},
      );
    }

    // 缩略图先顶上（网格里刚看过，基本都在 webview 内存缓存里）
    const thumb = thumbUrl(p);
    if (this.low.getAttribute('src') !== thumb) this.low.src = thumb;

    const key = this.keyFor(p, this.previewMax());
    const ready = this.loader.cache.get(key);
    if (ready) {
      this.setMain(ready, false);
      this.record(i, true);
      if (flying) {
        // 飞速翻页中：停下来之后再预加载（见 loadCurrent / settle 定时器）
        this.loadTimer = window.setTimeout(() => this.schedulePreload(), SETTLE_MS);
      } else {
        this.schedulePreload();
      }
    } else {
      this.setMain(null);
      if (rapid) this.loadTimer = window.setTimeout(() => this.loadCurrent(tok), SETTLE_MS);
      else this.loadCurrent(tok);
    }
    this.layout();
  }

  private loadCurrent(tok: number): void {
    const p = this.list[this.index];
    if (!p || tok !== this.token) return;
    const max = this.previewMax();
    const key = this.keyFor(p, max);
    // 只保留当前和相邻几张的加载，其余取消
    this.loader.cancelExcept(this.neighborKeys(max));
    this.slowTimer = window.setTimeout(() => this.stage.classList.add('loading'), 300);
    this.loader.load(key, this.urlFor(p, max, true), photoUrl(p, max, true, true)).then(
      (img) => {
        if (tok !== this.token) return;
        clearTimeout(this.slowTimer);
        this.stage.classList.remove('loading');
        this.setMain(img, false);
        this.record(this.index, false);
        this.schedulePreload();
      },
      (err) => {
        if (tok !== this.token || String(err).includes('cancelled')) return;
        clearTimeout(this.slowTimer);
        this.stage.classList.remove('loading');
        this.errorEl.textContent = '无法显示这张照片（格式不支持或文件已损坏）';
        this.errorEl.hidden = false;
      },
    );
  }

  private schedulePreload(): void {
    clearTimeout(this.preTimer);
    const tok = this.token;
    this.preTimer = window.setTimeout(() => {
      if (tok !== this.token) return;
      const max = this.previewMax();
      const order = this.navDir > 0 ? [1, 2, -1, 3] : [-1, -2, 1, -3];
      for (const d of order) {
        const p = this.list[this.index + d];
        if (p) this.loader.load(this.keyFor(p, max), this.urlFor(p, max, false), photoUrl(p, max, false, true)).catch(() => {});
      }
    }, 16);
  }

  private neighborKeys(max: number): Set<string> {
    const keys = new Set<string>();
    for (let d = -1; d <= 3; d++) {
      const p = this.list[this.index + d * this.navDir];
      if (p) keys.add(this.keyFor(p, max));
    }
    const p = this.list[this.index];
    if (p) keys.add(this.keyFor(p, 0));
    return keys;
  }

  /** 屏幕需要多少像素：窗口长边 × 设备像素比，向上取到固定档位（档位固定，缓存才命中得了） */
  private previewMax(): number {
    const need = Math.max(this.stage.clientWidth, this.stage.clientHeight) * (window.devicePixelRatio || 1);
    return BUCKETS.find((b) => b >= need) ?? BUCKETS[BUCKETS.length - 1];
  }

  private keyFor(p: Photo, max: number): string {
    return `${p.path}|${p.mtime}|${max}`;
  }

  private urlFor(p: Photo, max: number, urgent: boolean): string {
    return photoUrl(p, max, urgent, needsTranscode(p));
  }

  private record(index: number, cached: boolean): void {
    const ms = Math.round(performance.now() - this.navStart);
    const perf = (window.__ppPerf ??= []);
    perf.push({ index, ms, cached });
    if (perf.length > 200) perf.shift();
    // 同时写到 DOM 上：WebDriver 的脚本跑在隔离的 JS 环境里，看不到页面的 window 变量
    document.body.dataset.perf = JSON.stringify(perf);
  }

  // ---------------------------------------------------------------------------
  // 显示与几何
  // ---------------------------------------------------------------------------

  private setMain(img: HTMLImageElement | null, full = false): void {
    if (this.main && this.main !== img) this.main.remove();
    this.main = img;
    this.mainFull = full;
    if (!img) {
      this.low.hidden = false;
      return;
    }
    img.className = 'v-main';
    img.draggable = false;
    if (!img.isConnected) this.stage.insertBefore(img, this.starMark);
    if (this.dims.src === 'none' || this.dims.src === 'guess') this.guessDims(img);
    this.fixAspect(img);
    this.layout();
    this.low.hidden = true;
  }

  /** 还不知道原图尺寸时，先用已加载图片的比例（只要比例对，“适合窗口”就能正确布局） */
  private guessDims(img: HTMLImageElement): void {
    if (!img.naturalWidth) return;
    this.dims = { w: img.naturalWidth, h: img.naturalHeight, src: 'guess' };
  }

  /**
   * 后端读到的宽高与实际图片方向不一致时（个别 HEIC 的旋转信息写在容器里），
   * 以真正解码出来的图为准交换宽高。
   */
  private fixAspect(ref: HTMLImageElement): void {
    if (!ref.naturalWidth || this.dims.src !== 'info') return;
    const landscapeDims = this.dims.w >= this.dims.h;
    const landscapeImg = ref.naturalWidth >= ref.naturalHeight;
    const square = Math.abs(ref.naturalWidth - ref.naturalHeight) / ref.naturalWidth < 0.02;
    if (!square && landscapeDims !== landscapeImg) this.dims = { w: this.dims.h, h: this.dims.w, src: 'info' };
  }

  private fitScale(): number {
    const { w, h } = this.dims;
    if (!w || !h) return 1;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    // 小图不放大超过 1 倍（按 CSS 像素），和 Picasa 一样
    return Math.min(sw / w, sh / h, this.dims.src === 'guess' ? Infinity : 1);
  }

  private currentScale(): number {
    return this.scale ?? this.fitScale();
  }

  private layout(): void {
    const { w, h } = this.dims;
    if (!w || !h) return;
    const s = this.currentScale();
    const dw = w * s;
    const dh = h * s;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    // 图比窗口小时居中，比窗口大时限制平移范围，别把图拖出视野
    this.panX = dw <= sw ? 0 : Math.max((sw - dw) / 2, Math.min((dw - sw) / 2, this.panX));
    this.panY = dh <= sh ? 0 : Math.max((sh - dh) / 2, Math.min((dh - sh) / 2, this.panY));
    const x = (sw - dw) / 2 + this.panX;
    const y = (sh - dh) / 2 + this.panY;
    for (const el of [this.low, this.main]) {
      if (!el) continue;
      el.style.width = `${dw}px`;
      el.style.height = `${dh}px`;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    const zoomed = this.scale !== null && this.scale > this.fitScale() * 1.001;
    this.stage.classList.toggle('zoomed', zoomed);
    const dpr = window.devicePixelRatio || 1;
    this.zoomBtn.textContent = this.scale === null ? '1:1' : `${Math.round(s * dpr * 100)}%`;
  }

  private fit(): void {
    this.scale = null;
    this.panX = this.panY = 0;
    this.layout();
  }

  /** 以 (cx, cy)（相对舞台）为中心缩放到 newScale */
  private zoomTo(newScale: number, cx?: number, cy?: number): void {
    const fit = this.fitScale();
    newScale = Math.max(fit, Math.min(MAX_SCALE, newScale));
    const old = this.currentScale();
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    cx ??= sw / 2;
    cy ??= sh / 2;
    // 保持鼠标下的那个像素不动
    const ox = cx - sw / 2 - this.panX;
    const oy = cy - sh / 2 - this.panY;
    const r = newScale / old;
    this.panX = cx - sw / 2 - ox * r;
    this.panY = cy - sh / 2 - oy * r;
    this.scale = newScale <= fit * 1.001 ? null : newScale;
    this.layout();
    this.maybeUpgrade();
  }

  private zoomBy(f: number, cx?: number, cy?: number): void {
    this.zoomTo(this.currentScale() * f, cx, cy);
  }

  /** 1:1 = 一个图像像素对应一个屏幕物理像素，看对焦/噪点用 */
  private toggleActualSize(e?: MouseEvent): void {
    if (this.scale !== null) return this.fit();
    const r = this.stage.getBoundingClientRect();
    this.zoomTo(1 / (window.devicePixelRatio || 1), e ? e.clientX - r.left : undefined, e ? e.clientY - r.top : undefined);
  }

  /** 放大后当前图的分辨率不够了 → 换原图 */
  private maybeUpgrade(): void {
    const p = this.current;
    if (!p || this.mainFull || !this.main || this.scale === null) return;
    const dpr = window.devicePixelRatio || 1;
    const needPx = this.dims.w * this.currentScale() * dpr;
    if (needPx <= this.main.naturalWidth * 1.05) return;
    const tok = this.token;
    const key = this.keyFor(p, 0);
    this.stage.classList.add('loading');
    this.loader.load(key, this.urlFor(p, 0, true), photoUrl(p, 0, true, true)).then(
      (img) => {
        this.stage.classList.remove('loading');
        if (tok !== this.token) return;
        // 原图解码所得就是精确尺寸（webview 已按 EXIF 转正）
        if (img.naturalWidth) this.dims = { w: img.naturalWidth, h: img.naturalHeight, src: 'exact' };
        const keepScale = this.scale;
        this.setMain(img, true);
        this.scale = keepScale;
        this.layout();
      },
      () => this.stage.classList.remove('loading'),
    );
  }

  private showInfo(p: Photo, info?: PhotoInfo): void {
    const parts: string[] = [];
    if (info?.width) parts.push(`${info.width} × ${info.height}`);
    parts.push(formatBytes(p.size));
    if (info?.taken) parts.push(info.taken);
    if (info?.camera) parts.push(info.camera);
    if (info?.exposure) parts.push(info.exposure);
    parts.push(p.dir);
    this.infoEl.textContent = parts.join('   ·   ');
  }

  // ---------------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------------

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // 触控板双指捏合在 webview 里表现为 ctrlKey 的滚轮事件
      const f = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
      this.zoomBy(f, e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (this.scale !== null) {
      // 放大状态下滚轮/双指滑动 = 平移
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.layout();
      return;
    }
    const step = this.wheel.feed(e as WheelEvent & { wheelDeltaY?: number });
    if (step) this.step(step);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.scale === null || (e.target as HTMLElement).closest('.v-nav')) return;
    this.drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    this.stage.classList.add('dragging');
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    this.panX = this.drag.px + (e.clientX - this.drag.x);
    this.panY = this.drag.py + (e.clientY - this.drag.y);
    this.layout();
  }

  private onPointerUp(): void {
    this.drag = null;
    this.stage.classList.remove('dragging');
  }

  private async toggleStar(): Promise<void> {
    const p = this.current;
    if (!p) return;
    await this.cb.toggleStar([p]);
    this.refreshStar();
    this.starMark.classList.remove('pop');
    void this.starMark.offsetWidth; // 重启动画
    this.starMark.classList.add('pop');
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
    } catch {
      /* 非 Tauri 环境 */
    }
  }

  /** 到头了：轻轻弹一下 */
  private bump(d: number): void {
    this.stage.classList.remove('bump-left', 'bump-right');
    void this.stage.offsetWidth;
    this.stage.classList.add(d < 0 ? 'bump-left' : 'bump-right');
  }
}

// -----------------------------------------------------------------------------
// 底部胶片条（同样虚拟化，只渲染看得见的那几十张）
// -----------------------------------------------------------------------------

const ITEM_W = 76;

class Strip {
  private list: Photo[] = [];
  private current = -1;
  private items = new Map<number, HTMLElement>();
  private spare: HTMLElement[] = [];
  private raf = 0;

  constructor(
    private el: HTMLElement,
    private inner: HTMLElement,
    private pick: (i: number) => void,
  ) {
    el.addEventListener('scroll', () => this.schedule(), { passive: true });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        el.scrollLeft += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      },
      { passive: false },
    );
    inner.addEventListener('click', (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('.s-item');
      if (it) this.pick(Number(it.dataset.i));
    });
    new ResizeObserver(() => this.setCurrent(this.current)).observe(el);
  }

  setList(list: Photo[]): void {
    this.list = list;
    for (const it of this.items.values()) this.recycle(it);
    this.items.clear();
    this.inner.style.width = `${list.length * ITEM_W}px`;
  }

  setCurrent(i: number): void {
    this.current = i;
    if (i < 0) return;
    this.el.scrollLeft = i * ITEM_W + ITEM_W / 2 - this.el.clientWidth / 2;
    this.update();
    this.refresh();
  }

  refresh(): void {
    for (const [i, it] of this.items) {
      it.classList.toggle('current', i === this.current);
      it.classList.toggle('starred', !!this.list[i]?.starred);
    }
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.update());
  }

  private update(): void {
    this.raf = 0;
    const from = Math.max(0, Math.floor(this.el.scrollLeft / ITEM_W) - 4);
    const to = Math.min(this.list.length, Math.ceil((this.el.scrollLeft + this.el.clientWidth) / ITEM_W) + 4);
    for (const [i, it] of this.items) {
      if (i < from || i >= to) {
        this.recycle(it);
        this.items.delete(i);
      }
    }
    for (let i = from; i < to; i++) {
      if (this.items.has(i)) continue;
      let it = this.spare.pop();
      if (!it) {
        it = document.createElement('div');
        it.className = 's-item';
        it.innerHTML = '<img decoding="async" draggable="false" alt=""><span class="s-star">★</span>';
        this.inner.appendChild(it);
      }
      it.style.visibility = '';
      it.style.transform = `translateX(${i * ITEM_W}px)`;
      it.dataset.i = String(i);
      it.title = this.list[i].name;
      const img = it.querySelector('img')!;
      const url = thumbUrl(this.list[i]);
      if (img.getAttribute('src') !== url) img.src = url;
      it.classList.toggle('current', i === this.current);
      it.classList.toggle('starred', this.list[i].starred);
      this.items.set(i, it);
    }
  }

  private recycle(it: HTMLElement): void {
    it.style.visibility = 'hidden';
    this.spare.push(it);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

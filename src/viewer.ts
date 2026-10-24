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

import { t } from './i18n';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, needsTranscode, photoUrl, rawTag, thumbUrl } from './api';
import { ImageLoader } from './loader';
import type { Photo, PhotoInfo } from './types';
import { WheelStepper } from './wheel';
import { isTauri } from './platform';
import { remote } from './remote';
import { ICONS } from './icons';
import { esc, toast } from './ui';

const BUCKETS = [1024, 1600, 2048, 2560, 3200, 4096, 5120, 6144];
const RAPID_MS = 160;
/** 两次翻页间隔短于它 = 正在“飞”：不预加载（预加载的图转眼就会被跳过，反而占住后台线程） */
const FLYING_MS = 80;
const SETTLE_MS = 90;
const MAX_SCALE = 8;

export interface ViewerCallbacks {
  close(lastPath: string | null): void;
  toggleStar(photos: Photo[]): Promise<void>;
  /** 数字键：1～5 标成几星，0 清除 */
  rate(photos: Photo[], rating: number): Promise<void>;
  /** 网格里这张缩略图在屏幕上的位置（打开 / 关闭时从它放大、缩回它；看不到就 null） */
  thumbRect?(path: string): DOMRect | null;
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
  /** 正在飞速翻页：路过的照片不换原图 */
  private flying = false;
  private main: HTMLImageElement | null = null;
  private mainFull = false;
  private dims: Dims = { w: 0, h: 0, src: 'none' };
  /** null = 适合窗口；数字 = CSS 像素 / 图像像素 */
  private scale: number | null = null;
  private panX = 0;
  private panY = 0;
  /**
   * 放大状态下翻到的新照片还不知道尺寸时，先记下要沿用的放大倍数和位置，尺寸一到就套上。
   * rx/ry = 平移量占显示尺寸的比例（看的是图上哪一处）；w/h = 上一张的尺寸。
   */
  private pendingZoom: { scale: number; rx: number; ry: number; w: number; h: number } | null = null;
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
  private starMark: HTMLElement;
  /** 手机底栏（学 iPhone 的“照片”）：星标 + 信息 */
  private barStar: HTMLButtonElement;
  private sheetBody: HTMLElement;
  /** 留言：看大图顶栏的按钮（电脑）、底栏的按钮（手机）、面板 */
  private cmtBtn: HTMLButtonElement;
  private barCmt: HTMLButtonElement;
  private dlBtns: HTMLButtonElement[];
  private cmtEl: HTMLElement;
  /** 左右滑时露出来的前一张 / 后一张 */
  private peek: HTMLImageElement[];
  /** 顶栏的五颗星：显示 / 点击设置星级 */
  private rateEl: HTMLElement;
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
    this.starMark = $('.v-starmark');
    this.errorEl = $('.v-error');
    this.strip = new Strip($('.v-strip'), $('.v-strip-inner'), (i) => this.go(i));
    this.barStar = $<HTMLButtonElement>('.v-bstar');
    this.barStar.addEventListener('click', () => void this.toggleStar());
    const info = $<HTMLButtonElement>('.v-binfo');
    info.innerHTML = ICON_INFO;
    info.addEventListener('click', () => this.toggleSheet(undefined, 'info'));
    this.sheetBody = $('.v-sheet-body');
    this.cmtBtn = $<HTMLButtonElement>('.v-cmtbtn');
    this.barCmt = $<HTMLButtonElement>('.v-bcmt');
    this.cmtEl = $('.v-comments');
    for (const b of [this.cmtBtn, this.barCmt]) b.addEventListener('click', () => this.toggleSheet(undefined, 'comments'));
    this.dlBtns = [$<HTMLButtonElement>('.v-dl'), $<HTMLButtonElement>('.v-bdl')];
    this.dlBtns[0].innerHTML = ICONS.download;
    this.dlBtns[1].innerHTML = ICON_DOWNLOAD;
    for (const b of this.dlBtns) b.addEventListener('click', () => void this.download());
    this.buildCommentForm();
    $('.v-sheet').addEventListener('click', (e) => (e.target as HTMLElement).closest('.v-grip') && this.toggleSheet(false));
    this.peek = [...root.querySelectorAll<HTMLImageElement>('.v-peek-img')];

    $('.v-back').addEventListener('click', () => this.close());
    this.starBtn.addEventListener('click', () => this.toggleStar());
    this.rateEl = $('.v-rate');
    this.rateEl.addEventListener('click', (e) => {
      const n = Number((e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.n);
      if (n) void this.rate(n);
    });
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
      // 手指连点两下自己处理了（onPointerUp），浏览器补发的 dblclick 不再管
      if ((e.target as HTMLElement).closest('.v-nav') || this.byTouch) return;
      this.toggleActualSize(e);
    });
    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
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
    this.root.classList.remove('bare', 'sheet-open');
    this.strip.setList(this.list);
    this.index = -1;
    this.wheel.reset();
    this.go(index, true);
    this.zoomFrom(this.cb.thumbRect?.(this.list[index].path) ?? null);
  }

  /** 学 iPhone：照片从网格里那个小格子放大出来 */
  private zoomFrom(r: DOMRect | null): void {
    const s = this.stage.getBoundingClientRect();
    if (!r || !r.width || !s.width) return;
    const k = Math.max(r.width / s.width, r.height / s.height);
    const dx = r.left + r.width / 2 - (s.left + s.width / 2);
    const dy = r.top + r.height / 2 - (s.top + s.height / 2);
    this.root.classList.add('zooming');
    this.stage.style.transition = 'none';
    this.stage.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
    void this.stage.offsetWidth;
    this.stage.style.transition = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.25, 1)';
    this.stage.style.transform = '';
    window.setTimeout(() => this.root.classList.remove('zooming'), 340);
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
    if (isTauri) {
      void getCurrentWindow()
        .isFullscreen()
        .then((fs) => (fs ? getCurrentWindow().setFullscreen(false) : undefined))
        .catch(() => {});
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    this.cb.close(this.current?.path ?? null);
  }

  /** 星标变化后（可能来自其它入口）刷新显示 */
  refreshStar(): void {
    const p = this.current;
    if (!p) return;
    this.starBtn.textContent = p.starred ? t('★ 已加星标') : t('☆ 星标');
    this.starBtn.classList.toggle('on', p.starred);
    this.starMark.hidden = !p.starred;
    this.barStar.innerHTML = p.starred ? ICON_STAR_ON : ICON_STAR;
    this.barStar.classList.toggle('on', p.starred);
    this.rateEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= p.rating));
    // 远程相册没有星级，这排星星就不显示
    this.rateEl.style.display = p.remote ? 'none' : '';
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
        if (this.scale !== null || this.pendingZoom) this.fit();
        else this.close();
        return true;
      case 'Enter':
      case 'Backspace':
        this.close();
        return true;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
        // 星级：1～5 标成几星，0 清除
        void this.rate(Number(k));
        return true;
      case 'z':
      case 'Z':
        this.toggleActualSize();
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
    this.flying = flying;
    this.lastNavT = now;
    this.navStart = now;
    this.index = i;
    const tok = ++this.token;
    const p = this.list[i];

    // 放大状态下翻页：沿用放大倍数和看的位置（同一台相机拍的照片尺寸一样，正好对比同一处的对焦）
    const keep = !first && this.scale !== null && this.dims.w ? this.viewState(this.scale) : null;
    this.scale = null;
    this.panX = this.panY = 0;
    this.pendingZoom = null;
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
    this.refreshComments();
    this.strip.setCurrent(i);

    const info = this.infoCache.get(p.path);
    this.dims = info ? { w: info.width, h: info.height, src: 'info' } : { w: 0, h: 0, src: 'none' };
    if (keep) {
      this.pendingZoom = keep;
      if (info) this.applyPendingZoom(false); // 换原图等下面清晰版就位后再说
    }
    this.showInfo(p, info);
    if (!info) {
      api.photoInfo(p.path).then(
        (inf) => {
          this.infoCache.set(p.path, inf);
          if (tok !== this.token) return;
          if (this.dims.src !== 'exact' && inf.width > 0) {
            const old = this.dims;
            this.dims = { w: inf.width, h: inf.height, src: 'info' };
            if (this.main) this.fixAspect(this.main);
            // 已经按“同尺寸”的猜测套用了放大，真实尺寸略有不同时按比例挪一下，看的还是同一处
            if (this.scale !== null && old.w && old.h) {
              this.panX *= this.dims.w / old.w;
              this.panY *= this.dims.h / old.h;
            }
            this.applyPendingZoom();
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
        // 飞速翻页中：停下来之后再预加载、换原图（见 loadCurrent / settle 定时器）
        this.loadTimer = window.setTimeout(() => {
          this.flying = false;
          this.maybeUpgrade();
          this.schedulePreload();
        }, SETTLE_MS);
      } else {
        this.maybeUpgrade();
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
    this.flying = false;
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
        this.maybeUpgrade();
        this.schedulePreload();
      },
      (err) => {
        if (tok !== this.token || String(err).includes('cancelled')) return;
        clearTimeout(this.slowTimer);
        this.stage.classList.remove('loading');
        this.errorEl.textContent = t('无法显示这张照片');
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
      // 放大看细节时，下一张翻过去也是放大的：顺手把它的原图也备好
      const next = this.scale !== null ? this.list[this.index + this.navDir] : undefined;
      if (next) this.loader.load(this.keyFor(next, 0), this.urlFor(next, 0, false), photoUrl(next, 0, false, true)).catch(() => {});
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
    const next = this.list[this.index + this.navDir];
    if (next && (this.scale !== null || this.pendingZoom)) keys.add(this.keyFor(next, 0));
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
    const z = this.pendingZoom;
    if (z && Math.abs(img.naturalWidth / img.naturalHeight - z.w / z.h) < 0.01) {
      // 放大翻页且比例和上一张一样：多半是同一台相机，先按上一张的尺寸套上放大，不用等后端报尺寸
      this.dims = { w: z.w, h: z.h, src: 'guess' };
      this.applyPendingZoom();
      return;
    }
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
  }

  /** 当前的放大倍数和看的位置（平移量换算成占显示尺寸的比例，换了尺寸不同的图也指向同一处） */
  private viewState(scale: number): { scale: number; rx: number; ry: number; w: number; h: number } {
    const { w, h } = this.dims;
    return { scale, rx: this.panX / (w * scale), ry: this.panY / (h * scale), w, h };
  }

  private applyPendingZoom(upgrade = true): void {
    const z = this.pendingZoom;
    const { w, h } = this.dims;
    if (!z || !w || !h) return;
    this.pendingZoom = null;
    this.scale = Math.min(MAX_SCALE, z.scale);
    this.panX = z.rx * w * this.scale;
    this.panY = z.ry * h * this.scale;
    if (this.scale <= this.fitScale() * 1.001) this.fit();
    else this.layout();
    if (upgrade) this.maybeUpgrade();
  }

  private fit(): void {
    this.pendingZoom = null;
    this.scale = null;
    this.panX = this.panY = 0;
    this.layout();
  }

  /** 以 (cx, cy)（相对舞台）为中心缩放到 newScale */
  private zoomTo(newScale: number, cx?: number, cy?: number): void {
    const fit = this.fitScale();
    newScale = Math.max(fit, Math.min(MAX_SCALE, newScale));
    this.pendingZoom = null;
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
    if (this.scale !== null || this.pendingZoom) return this.fit();
    const r = this.stage.getBoundingClientRect();
    this.zoomTo(1 / (window.devicePixelRatio || 1), e ? e.clientX - r.left : undefined, e ? e.clientY - r.top : undefined);
  }

  /** 放大后当前图的分辨率不够了 → 换原图 */
  private maybeUpgrade(): void {
    const p = this.current;
    if (!p || this.flying || this.mainFull || !this.main || this.scale === null) return;
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
    if (!p.remote) parts.push(p.dir);
    this.infoEl.textContent = parts.join('   ·   ');
    // 信息面板：第一行是拍摄时间（大字），下面文件名、尺寸、相机、曝光
    const rows: string[] = [];
    if (info?.taken) rows.push(info.taken);
    rows.push(rawTag(p) ? `${p.name} + ${rawTag(p)}` : p.name);
    rows.push([info?.width ? `${info.width} × ${info.height}` : '', formatBytes(p.size)].filter(Boolean).join('  ·  '));
    const cam = [info?.camera, info?.lens].filter(Boolean).join('  ·  ');
    if (cam) rows.push(cam);
    if (info?.exposure) rows.push(info.exposure);
    this.sheetBody.replaceChildren(
      ...rows.map((text, i) => {
        const d = document.createElement('div');
        d.className = i === 0 ? 'v-sheet-title' : 'v-sheet-row';
        d.textContent = text;
        return d;
      }),
    );
  }

  /** 底部面板（学 iPhone：点 ⓘ 或往上推照片看信息；点留言按钮看留言）。再点同一个按钮收起 */
  private toggleSheet(open?: boolean, mode: 'info' | 'comments' = this.sheetMode): void {
    const isOpen = this.root.classList.contains('sheet-open');
    if (open === undefined) open = !(isOpen && mode === this.sheetMode);
    this.sheetMode = mode;
    this.root.classList.toggle('sheet-comments', mode === 'comments');
    this.root.classList.toggle('sheet-open', open);
    if (open) this.root.classList.remove('bare');
    if (open && mode === 'comments') this.renderComments(true);
  }

  private sheetMode: 'info' | 'comments' = 'info';
  private cmtList!: HTMLElement;
  private cmtInput!: HTMLTextAreaElement;

  /** 留言区：上面是列表，下面是输入框 + 发送 */
  private buildCommentForm(): void {
    this.cmtEl.innerHTML = `<div class="v-cmt-head">${esc(t('留言'))}</div><div class="v-cmt-list"></div>
      <label class="v-cmt-namerow"><span class="dim">${esc(t('名字'))}</span><input class="v-cmt-name" maxlength="20" spellcheck="false" autocomplete="off" placeholder="${esc(t('不填就随机起一个'))}"></label>
      <form class="v-cmt-form"><textarea rows="1" maxlength="500" placeholder="${esc(t('写留言，大家都能看到'))}"></textarea>
      <button class="btn primary" type="submit">${esc(t('发送'))}</button></form>`;
    this.cmtList = this.cmtEl.querySelector('.v-cmt-list')!;
    this.cmtInput = this.cmtEl.querySelector('textarea')!;
    const form = this.cmtEl.querySelector('form')!;
    // 名字：默认随机起的那个；改了就记住，清空就再随机一个
    const nameEl = this.cmtEl.querySelector<HTMLInputElement>('.v-cmt-name')!;
    nameEl.value = remote.commentName;
    nameEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') nameEl.blur();
    });
    nameEl.addEventListener('change', () => {
      remote.commentName = nameEl.value;
      nameEl.value = remote.commentName;
    });
    const grow = () => {
      this.cmtInput.style.height = 'auto';
      this.cmtInput.style.height = `${Math.min(120, this.cmtInput.scrollHeight)}px`;
    };
    this.cmtInput.addEventListener('input', grow);
    // 回车发送，Shift+回车换行；输入法选字时的回车不算
    this.cmtInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 打字时空格、方向键不能翻页 / 加星
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'Escape') {
        this.cmtInput.blur();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = this.current;
      const text = this.cmtInput.value.trim();
      if (!p?.remote || !text) return;
      const btn = form.querySelector('button')!;
      btn.disabled = true;
      try {
        await remote.addComment(p.path, text);
        this.cmtInput.value = '';
        grow();
        p.comments = remote.commentCount(p.remote.code, p.remote.id);
        this.refreshComments();
        this.cmtList.scrollTop = this.cmtList.scrollHeight;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
    this.cmtList.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.v-cmt-del');
      const p = this.current;
      if (!b || !p?.remote) return;
      try {
        await remote.deleteComment(p.remote.code, Number(b.dataset.id));
        p.comments = remote.commentCount(p.remote.code, p.remote.id);
        this.refreshComments();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
  }

  /** 留言按钮上的条数、留言列表（换了照片、别人留言/删除时调用） */
  refreshComments(): void {
    const p = this.current;
    const on = !!p?.remote;
    const n = on ? remote.commentsOf(p!.path).length : 0;
    this.cmtBtn.hidden = this.barCmt.hidden = !on;
    // 桌面版有导出（远程相册导出的是本机原图），下载只给网页版
    for (const b of this.dlBtns) b.hidden = !on || isTauri;
    this.cmtBtn.innerHTML = `${ICONS.bubble}<span>${n || t('留言')}</span>`;
    this.barCmt.innerHTML = `${ICON_BUBBLE}${n ? `<span class="n">${n}</span>` : ''}`;
    if (p?.remote) p.unread = remote.unreadCount(p.remote.code, p.remote.id);
    this.refreshUnread();
    if (!on && this.sheetMode === 'comments') this.toggleSheet(false, 'info');
    if (this.sheetMode === 'comments') this.renderComments(false);
  }

  /** 打开留言栏（从通知横幅跳过来时用） */
  showComments(): void {
    this.toggleSheet(true, 'comments');
  }

  /** 有没看过的留言：留言按钮标红 */
  private refreshUnread(): void {
    const u = !!this.current?.unread;
    this.cmtBtn.classList.toggle('unread', u);
    this.barCmt.classList.toggle('unread', u);
  }

  /**
   * 下载线上那张预览图（长边 1600 像素，不是原图），文件名沿用原图的名字。
   * 手机上走系统分享面板，能直接「存储图像」到相册；电脑上就是普通下载。
   */
  private async download(): Promise<void> {
    const p = this.current;
    if (!p?.remote) return;
    const name = p.name.replace(/\.[^.]+$/, '') + '.jpg';
    try {
      const blob = await (await fetch(`${p.remote.img}_p.jpg`)).blob();
      const file = new File([blob], name, { type: 'image/jpeg' });
      if (navigator.maxTouchPoints > 0 && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (e) {
          if ((e as Error).name === 'AbortError') return; // 用户自己关了分享面板
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast(t('下载失败，检查一下网络'), 'error');
    }
  }

  private renderComments(focus: boolean): void {
    const p = this.current;
    if (!p?.remote) return;
    const list = remote.commentsOf(p.path);
    const atBottom = this.cmtList.scrollTop + this.cmtList.clientHeight >= this.cmtList.scrollHeight - 4;
    this.cmtList.replaceChildren(
      ...(list.length
        ? list.map((c) => {
            const d = document.createElement('div');
            d.className = 'v-cmt-item';
            const text = document.createElement('div');
            text.className = 'v-cmt-text';
            text.textContent = c.text;
            const meta = document.createElement('div');
            meta.className = 'v-cmt-meta';
            if (c.name) meta.append(Object.assign(document.createElement('span'), { className: 'v-cmt-who', textContent: c.name }));
            meta.append(timeAgo(c.at));
            if (remote.canDelete(p.remote!.code, c.id)) {
              const del = document.createElement('button');
              del.className = 'v-cmt-del';
              del.dataset.id = String(c.id);
              del.textContent = t('删除');
              meta.append(del);
            }
            d.append(text, meta);
            return d;
          })
        : [Object.assign(document.createElement('div'), { className: 'v-cmt-empty dim', textContent: t('还没有留言') })]),
    );
    if (atBottom || focus) this.cmtList.scrollTop = this.cmtList.scrollHeight;
    // 留言栏开着 = 看过了，这张的未读清零
    if (this.root.classList.contains('sheet-open') && this.sheetMode === 'comments' && p.unread) {
      remote.markCommentsSeen(p.remote.code, p.remote.id);
      p.unread = 0;
      this.refreshUnread();
    }
    // 电脑上点开就能直接打字；手机上不自动弹键盘（会把照片顶没了）
    // （等面板滑出来再聚焦：隐藏着的输入框聚焦不了）
    if (focus && !this.byTouch) window.setTimeout(() => this.cmtInput.focus({ preventScroll: true }), 60);
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
    if (e.altKey && this.scale !== null) {
      // 放大状态下按住 ⌥ 滚动 = 平移（也可以直接拖动）
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.layout();
      return;
    }
    // 放大与否都是翻页；放大时翻到下一张会保持放大倍数和位置
    const step = this.wheel.feed(e);
    if (step) this.step(step);
  }

  // 鼠标：放大后拖动平移。
  // 手指（学 iPhone 的“照片”）：没放大时照片跟着手指左右走，松手过半或甩一下就翻页；往下拖 = 缩小淡出、松手关闭；
  // 放大后单指拖 = 平移；双指捏 = 缩放；连点两下 = 放大 / 还原；轻点一下 = 藏起 / 露出工具栏。
  private touches = new Map<number, { x: number; y: number }>();
  /** 这次手指按下的起点；axis = 认定的方向（动了 10px 以后才定，定了就不改） */
  private swipe: { x: number; y: number; t: number; axis: 'x' | 'y' | 'up' | null; vx: number; lx: number; lt: number } | null = null;
  private pinch: { d: number; scale: number } | null = null;
  private lastTap = 0;
  private tapTimer = 0;
  private byTouch = false;
  private sliding = false;

  private onPointerDown(e: PointerEvent): void {
    this.byTouch = e.pointerType === 'touch';
    if ((e.target as HTMLElement).closest('.v-nav') || this.sliding) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.currentScale() };
        this.cancelSwipe();
        this.drag = null;
        return;
      }
      if (this.touches.size > 2) return;
      const now = performance.now();
      this.swipe = { x: e.clientX, y: e.clientY, t: now, axis: null, vx: 0, lx: e.clientX, lt: now };
    }
    if (e.button !== 0 || this.scale === null) return;
    this.drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    this.stage.classList.add('dragging');
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const r = this.stage.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomTo((this.pinch.scale * d) / Math.max(1, this.pinch.d), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        return;
      }
      const sw = this.swipe;
      if (sw && this.scale === null && !this.pinch) {
        const dx = e.clientX - sw.x;
        const dy = e.clientY - sw.y;
        // 手指速度（平滑一下），松手时判断是不是“甩”
        const now = performance.now();
        if (now > sw.lt) sw.vx = 0.7 * ((e.clientX - sw.lx) / (now - sw.lt)) + 0.3 * sw.vx;
        sw.lx = e.clientX;
        sw.lt = now;
        if (!sw.axis && Math.hypot(dx, dy) > 8) {
          sw.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : dy > 0 ? 'y' : 'up';
          // 信息面板开着时不左右翻（照片缩在上面），只认上下
          if (sw.axis === 'x' && this.root.classList.contains('sheet-open')) sw.axis = null;
          if (sw.axis === 'x') this.preparePeek();
        }
        if (sw.axis === 'x') {
          // 到头了还往外拉：只走三分之一，像拉橡皮筋
          const edge = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.list.length - 1);
          this.setTrack(edge ? dx / 3 : dx, false);
        } else if (sw.axis === 'y' && !this.root.classList.contains('sheet-open')) {
          const k = Math.max(0, dy);
          this.stage.style.transition = 'none';
          this.stage.style.transform = `translate(${dx}px, ${k}px) scale(${Math.max(0.6, 1 - k / 800)})`;
          this.root.style.setProperty('--v-bg', String(Math.max(0, 1 - k / 300)));
        }
        return;
      }
    }
    if (!this.drag) return;
    this.panX = this.drag.px + (e.clientX - this.drag.x);
    this.panY = this.drag.py + (e.clientY - this.drag.y);
    this.layout();
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.delete(e.pointerId)) {
      if (this.pinch) {
        // 松开一根手指后，剩下那根不接着当拖动/翻页用，免得画面跳
        if (this.touches.size === 0) this.pinch = null;
      } else if (this.swipe && this.isOpen) {
        const sw = this.swipe;
        const dx = e.clientX - sw.x;
        const dy = e.clientY - sw.y;
        const dt = performance.now() - sw.t;
        const w = this.stage.clientWidth;
        if (sw.axis === 'x' && this.scale === null) {
          const d = dx < 0 ? 1 : -1;
          // 甩一下（速度够、方向对）或拖过三分之一就翻页
          const fling = Math.abs(sw.vx) > 0.35 && Math.sign(-sw.vx) === d;
          const can = this.index + d >= 0 && this.index + d < this.list.length;
          if (can && (fling || Math.abs(dx) > w / 3)) this.slideTo(d, Math.abs(sw.vx));
          else this.springBack();
        } else if (sw.axis === 'y' && this.root.classList.contains('sheet-open')) {
          if (dy > 40) this.toggleSheet(false);
        } else if (sw.axis === 'y' && this.scale === null) {
          if (dy > 100 || (dt < 300 && dy > 50)) this.swipeClose();
          else this.springBack();
        } else if (sw.axis === 'up') {
          if (dy < -40) this.toggleSheet(true, 'info');
        } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
          this.onTap(e);
        }
      }
      this.swipe = null;
    }
    this.drag = null;
    this.stage.classList.remove('dragging');
  }

  /** 轻点：等一下看是不是连点两下。单击 = 藏起 / 露出工具栏，双击 = 放大 / 还原 */
  private onTap(e: PointerEvent): void {
    const now = performance.now();
    if (now - this.lastTap < 300) {
      this.lastTap = 0;
      clearTimeout(this.tapTimer);
      const r = this.stage.getBoundingClientRect();
      if (this.scale !== null || this.pendingZoom) this.fit();
      else this.zoomTo(this.fitScale() * 2.5, e.clientX - r.left, e.clientY - r.top);
      return;
    }
    this.lastTap = now;
    clearTimeout(this.tapTimer);
    this.tapTimer = window.setTimeout(() => {
      if (this.root.classList.contains('sheet-open')) this.toggleSheet(false);
      else this.root.classList.toggle('bare');
    }, 260);
  }

  private cancelSwipe(): void {
    if (this.swipe?.axis) this.springBack();
    this.swipe = null;
  }

  /** 开始左右拖：把前一张、后一张摆到两边（有预加载好的大图就用大图，没有先用缩略图） */
  private preparePeek(): void {
    const r = this.stage.getBoundingClientRect();
    const vr = this.root.getBoundingClientRect();
    const max = this.previewMax();
    [-1, 1].forEach((d, k) => {
      const img = this.peek[k];
      const p = this.list[this.index + d];
      img.style.cssText = `left:${r.left - vr.left}px;top:${r.top - vr.top}px;width:${r.width}px;height:${r.height}px;transition:none`;
      if (!p) {
        img.hidden = true;
        return;
      }
      const ready = this.loader.cache.get(this.keyFor(p, max));
      const src = ready?.src ?? thumbUrl(p);
      if (img.getAttribute('src') !== src) img.src = src;
      img.hidden = false;
    });
    this.setTrack(0, false);
  }

  /** 整条“胶片”平移 x：当前这张 + 两边各一张，中间留一道缝（和 iPhone 一样） */
  private setTrack(x: number, animate: string | false): void {
    const w = this.stage.clientWidth + PEEK_GAP;
    const tr = animate || 'none';
    this.stage.style.transition = animate ? `transform ${animate}` : 'none';
    this.stage.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
    this.peek[0].style.transition = this.peek[1].style.transition = animate ? `transform ${tr}` : 'none';
    this.peek[0].style.transform = `translate3d(${x - w}px, 0, 0)`;
    this.peek[1].style.transform = `translate3d(${x + w}px, 0, 0)`;
  }

  private hidePeek(): void {
    for (const img of this.peek) img.hidden = true;
  }

  /** 松手没过线：弹回原位 */
  private springBack(): void {
    if (this.swipe?.axis === 'x') {
      this.setTrack(0, '0.3s cubic-bezier(0.2, 0.9, 0.3, 1)');
      window.setTimeout(() => this.hidePeek(), 300);
    } else {
      this.stage.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
      this.stage.style.transform = '';
    }
    this.root.style.removeProperty('--v-bg');
  }

  /**
   * 翻页：整条胶片接着手指的速度滑到下一张，停稳后再把“当前”换成它。
   * 下一张早就预加载好了，换的那一下看不出来。
   */
  private slideTo(d: number, speed = 0): void {
    const w = this.stage.clientWidth + PEEK_GAP;
    const cur = new DOMMatrixReadOnly(getComputedStyle(this.stage).transform).m41 || 0;
    const left = Math.abs(-d * w - cur);
    // 甩得快就滑得快：剩下的距离 / 手速，限制在 160～340ms
    const ms = Math.round(Math.max(160, Math.min(340, speed > 0.1 ? left / speed : 300)));
    this.sliding = true;
    this.setTrack(-d * w, `${ms}ms cubic-bezier(0.25, 0.9, 0.3, 1)`);
    window.setTimeout(() => {
      this.step(d);
      this.setTrack(0, false);
      this.hidePeek();
      this.sliding = false;
    }, ms);
  }

  /** 往下拖关掉：缩回网格里那一格（看不到那一格就缩小淡出），然后回到网格 */
  private swipeClose(): void {
    const p = this.current;
    const r = p ? (this.cb.thumbRect?.(p.path) ?? null) : null;
    const s = this.stage.getBoundingClientRect();
    this.stage.style.transition = 'transform 0.26s cubic-bezier(0.3, 0.7, 0.3, 1), opacity 0.26s';
    if (r && r.width && s.width) {
      // 现在的 transform 已经带着手指拖动的位移和缩放：直接换成“落到那一格”的
      const base = this.stage.style.transform;
      this.stage.style.transform = '';
      const b = this.stage.getBoundingClientRect();
      this.stage.style.transform = base;
      const k = Math.max(r.width / b.width, r.height / b.height);
      const dx = r.left + r.width / 2 - (b.left + b.width / 2);
      const dy = r.top + r.height / 2 - (b.top + b.height / 2);
      void this.stage.offsetWidth;
      this.stage.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
    } else {
      this.stage.style.transform += ' scale(0.8)';
      this.stage.style.opacity = '0';
    }
    this.root.style.setProperty('--v-bg', '0');
    window.setTimeout(() => {
      this.close();
      this.stage.style.transition = 'none';
      this.stage.style.transform = '';
      this.stage.style.opacity = '';
      this.root.style.removeProperty('--v-bg');
    }, 260);
  }

  private async rate(n: number): Promise<void> {
    const p = this.current;
    if (!p) return;
    await this.cb.rate([p], n);
    this.refreshStar();
  }

  private async toggleStar(): Promise<void> {
    const p = this.current;
    if (!p) return;
    if (this.byTouch) navigator.vibrate?.(10); // 安卓上轻震一下（iPhone 的网页没有震动）
    await this.cb.toggleStar([p]);
    this.refreshStar();
    this.starMark.classList.remove('pop');
    void this.starMark.offsetWidth; // 重启动画
    this.starMark.classList.add('pop');
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (isTauri) {
        const w = getCurrentWindow();
        await w.setFullscreen(!(await w.isFullscreen()));
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.root.requestFullscreen();
      }
    } catch {
      /* 浏览器不让（比如 iPhone 的 Safari 不支持网页全屏） */
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
/** 左右滑时两张照片之间的缝 */
const PEEK_GAP = 20;

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

// 手机底栏的图标（线条风格，跟 iPhone 的“照片”一样）
const ICON_STAR =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
const ICON_STAR_ON =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9.2"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="0.6" fill="currentColor"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v12M7 10.8l5 4.9 5-4.9"/><path d="M4.5 19.5h15"/></svg>';
const ICON_BUBBLE =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/></svg>';

/** 留言时间：刚刚 / 5 分钟前 / 3 小时前 / 10月24日 14:05 */
function timeAgo(sec: number): string {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return t('刚刚');
  if (d < 3600) return t('{n} 分钟前', { n: Math.floor(d / 60) });
  if (d < 86400) return t('{n} 小时前', { n: Math.floor(d / 3600) });
  const dt = new Date(sec * 1000);
  const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  return t('{m}月{d}日 {hm}', { m: dt.getMonth() + 1, d: dt.getDate(), hm });
}

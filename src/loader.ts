// 图片预加载 + 已解码图片的 LRU 缓存。
//
// “切到下一张时卡一下”的根源通常不是读文件，而是**解码**：一张 2400 万像素 JPEG
// 解码成位图要几十到上百毫秒，在主线程上做就会掉帧。
// `img.decode()` 让 webview 在后台线程解码，解码完成才 resolve；我们把解好的 <img>
// 元素留在缓存里，翻到它时直接把这个元素插进页面——不需要再解码，瞬间显示。

export class DecodedCache {
  private map = new Map<string, HTMLImageElement>();

  constructor(private capacity: number) {}

  get(key: string): HTMLImageElement | undefined {
    const v = this.map.get(key);
    if (v) {
      // 刷新 LRU 顺序
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, img: HTMLImageElement): void {
    this.map.delete(key);
    this.map.set(key, img);
    while (this.map.size > this.capacity) {
      const [k, old] = this.map.entries().next().value as [string, HTMLImageElement];
      this.map.delete(k);
      // 不在页面上的才释放位图内存；正在显示的那张不能动
      if (!old.isConnected) old.removeAttribute('src');
    }
  }

  get size(): number {
    return this.map.size;
  }
}

interface Pending {
  img: HTMLImageElement;
  promise: Promise<HTMLImageElement>;
  cancelled: boolean;
}

export class ImageLoader {
  readonly cache: DecodedCache;
  private inflight = new Map<string, Pending>();

  constructor(capacity: number) {
    this.cache = new DecodedCache(capacity);
  }

  /** 加载并解码。`fallbackUrl`：首选 URL 解码失败（如老系统不支持 HEIC）时的退路。 */
  load(key: string, url: string, fallbackUrl?: string): Promise<HTMLImageElement> {
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const existing = this.inflight.get(key);
    if (existing) return existing.promise;

    const img = new Image();
    img.decoding = 'async';
    const pending: Pending = { img, cancelled: false, promise: Promise.resolve(img) };
    pending.promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const attempt = (u: string, fb: string | undefined) => {
        img.src = u;
        img.decode().then(
          () => {
            if (pending.cancelled) return reject(new Error('cancelled'));
            this.cache.set(key, img);
            resolve(img);
          },
          (err) => {
            if (!pending.cancelled && fb) attempt(fb, undefined);
            else reject(pending.cancelled ? new Error('cancelled') : err);
          },
        );
      };
      attempt(url, fallbackUrl);
    }).finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending.promise;
  }

  isLoading(key: string): boolean {
    return this.inflight.has(key);
  }

  /** 取消不再需要的加载，把后端算力让给眼前这张 */
  cancelExcept(keep: Set<string>): void {
    for (const [key, p] of this.inflight) {
      if (keep.has(key)) continue;
      p.cancelled = true;
      p.img.removeAttribute('src');
      this.inflight.delete(key);
    }
  }
}

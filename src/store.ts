// 全局状态 + 极简的事件订阅。不用框架：几千张缩略图的场景下，手写的增量 DOM 更新最快、最可控。

import { splitSections, type Section } from './gridLayout';
import type { Folder, Library, Photo } from './types';

/**
 * folder 视图的 path = 现在正在看的相册。连续翻动时列表里可能接着好几个相册，
 * 往下滚到哪个相册，path 就跟着变成哪个。
 * folder 视图带 starredOnly = 星标筛选开着时打开的相册，只显示其中的星标照片；
 * starred = 星标筛选开着、还没挑具体相册时的汇总（所有相册的星标照片）。
 */
export type View = { kind: 'folder'; path: string; starredOnly?: boolean } | { kind: 'starred' } | { kind: 'none' };

/** 网格最上面那一栏：有没看过的留言的照片先挪到这里，看完（关掉大图时）回到原来的位置；没有就不显示这一栏 */
export const UNREAD_SECTION = '\u0000unread';

/** 星标筛选是否开着（底栏“★ 星标”/ 手机侧栏“已加星标的照片”处于按下状态） */
export const isStarMode = (v: View): boolean => v.kind === 'starred' || (v.kind === 'folder' && !!v.starredOnly);

type Topic = 'library' | 'photos' | 'selection' | 'stars' | 'view';
type Listener = () => void;

class Store {
  library: Library = { workdir: null, recent: [], missing: [], folders: [] };
  view: View = { kind: 'none' };
  /** 当前视图的全部照片：打开的相册，加上连续翻动时接在后面的相册（星标汇总则是所有星标照片） */
  all: Photo[] = [];
  /** 经过搜索过滤（星标筛选下还要去掉没星标的，星级筛选下去掉星级不够的）后的照片，网格和看图器都基于它 */
  visible: Photo[] = [];
  /** visible 按相册切成的段 */
  sections: Section[] = [];
  /** 未读留言那一栏插在哪个相册前面（点开的那个相册） */
  unreadBefore: string | null = null;
  query = '';
  /** 星级筛选：只看这个星级及以上的照片，0 = 不筛 */
  minRating = 0;
  selection = new Set<string>();
  /** Shift 连选的起点 */
  anchor: string | null = null;
  /** 键盘光标 */
  focus: string | null = null;

  private listeners = new Map<Topic, Set<Listener>>();
  private starChain: Promise<unknown> = Promise.resolve();

  /** 星标写入排队：一个写完再发下一个，保证“先加星、马上取消”最后落盘的是“取消” */
  queueStarWrite<T>(write: () => Promise<T>): Promise<T> {
    const job = this.starChain.then(write);
    this.starChain = job.catch(() => {});
    return job;
  }

  /** 等排队中的星标写完：读列表（尤其是“已加星标”相册）之前调用，才能看到刚打的星 */
  starsSettled(): Promise<void> {
    return this.starChain.then(() => undefined);
  }

  on(topic: Topic, fn: Listener): void {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(fn);
  }

  emit(topic: Topic): void {
    this.listeners.get(topic)?.forEach((fn) => fn());
  }

  setLibrary(lib: Library): void {
    this.library = lib;
    this.emit('library');
  }

  setPhotos(view: View, photos: Photo[]): void {
    this.view = view;
    this.all = photos;
    this.selection.clear();
    this.anchor = this.focus = null;
    this.refilter(false);
    this.emit('view');
  }

  /** 连续翻动：把下一个相册的照片接在后面，选择和光标不变 */
  appendPhotos(photos: Photo[]): void {
    this.all = this.all.concat(photos);
    this.refilter();
  }

  prependPhotos(photos: Photo[]): void {
    this.all = photos.concat(this.all);
    this.refilter();
  }

  /** 重新计算可见列表。keepSelection=false 时清空选择。 */
  refilter(keepSelection = true): void {
    const q = this.query.trim().toLowerCase();
    // 星标筛选下，取消了星标的照片也要消失
    const onlyStar = isStarMode(this.view);
    const match = (p: Photo) => !q || p.name.toLowerCase().includes(q) || p.companions.some((c) => c.toLowerCase().includes(q));
    const min = this.minRating;
    const shown = this.all.filter((p) => (!onlyStar || p.starred) && p.rating >= min && match(p));
    const unread = shown.filter((p) => p.unread);
    if (unread.length) {
      // 未读那一栏放在点开的那个相册上面；往上接的相册排在它前面，往上滑照样能翻到
      const rest = shown.filter((p) => !p.unread);
      const at = Math.max(0, this.unreadBefore ? rest.findIndex((p) => p.dir === this.unreadBefore) : 0);
      this.visible = [...rest.slice(0, at), ...unread, ...rest.slice(at)];
      const end = at + unread.length;
      this.sections = splitSections(this.visible.map((p, i) => (i >= at && i < end ? { dir: UNREAD_SECTION } : p)));
    } else {
      this.visible = shown;
      this.sections = splitSections(shown);
    }
    if (keepSelection) {
      const vis = new Set(this.visible.map((p) => p.path));
      for (const s of [...this.selection]) if (!vis.has(s)) this.selection.delete(s);
      if (this.focus && !vis.has(this.focus)) this.focus = null;
    } else {
      this.selection.clear();
    }
    this.emit('photos');
  }

  folder(path: string): Folder | undefined {
    return this.library.folders.find((f) => f.path === path);
  }

  totalStarred(): number {
    return this.library.folders.reduce((n, f) => n + f.starred, 0);
  }

  indexOf(path: string | null): number {
    return path ? this.visible.findIndex((p) => p.path === path) : -1;
  }

  selectedPhotos(): Photo[] {
    return this.visible.filter((p) => this.selection.has(p.path));
  }
}

export const store = new Store();

// ---- 本地偏好（只存界面习惯；读写失败时静默用默认值） ----

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`pp.${key}`);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`pp.${key}`, JSON.stringify(value));
    } catch {
      /* 隐私模式等情况下不可用，忽略 */
    }
  },
};

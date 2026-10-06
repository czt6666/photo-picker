// 全局状态 + 极简的事件订阅。不用框架：几千张缩略图的场景下，手写的增量 DOM 更新最快、最可控。

import type { Folder, Library, Photo } from './types';

export type View = { kind: 'folder'; path: string } | { kind: 'starred' } | { kind: 'none' };

type Topic = 'library' | 'photos' | 'selection' | 'stars' | 'view';
type Listener = () => void;

class Store {
  library: Library = { workdir: null, recent: [], folders: [] };
  view: View = { kind: 'none' };
  /** 当前视图（文件夹 / 星标相册）的全部照片 */
  all: Photo[] = [];
  /** 经过“仅星标”、搜索过滤后的照片，网格和看图器都基于它 */
  visible: Photo[] = [];
  starredOnly = false;
  query = '';
  selection = new Set<string>();
  /** Shift 连选的起点 */
  anchor: string | null = null;
  /** 键盘光标 */
  focus: string | null = null;

  private listeners = new Map<Topic, Set<Listener>>();

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

  /** 重新计算可见列表。keepSelection=false 时清空选择。 */
  refilter(keepSelection = true): void {
    const q = this.query.trim().toLowerCase();
    // 星标相册里取消了星标的照片也要消失
    const onlyStar = this.starredOnly || this.view.kind === 'starred';
    const match = (p: Photo) => !q || p.name.toLowerCase().includes(q) || p.companions.some((c) => c.toLowerCase().includes(q));
    this.visible = this.all.filter((p) => (!onlyStar || p.starred) && match(p));
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

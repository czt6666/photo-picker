// 远程相册：放在服务器上、拿到链接的人都能一起挑的相册。
//
// 服务器上只有压缩预览（2048 像素的预览图 + 512 像素的缩略图），原图留在摄影师电脑上。
// 星标是大家共用的一份：谁加星、谁取消，通过 WebSocket 实时推给所有正在看的人。
//
// 远程相册就是一种工作目录：`remote:<相册码>` 相当于工作目录，里面的子文件夹（摄影师电脑上的文件夹结构）
// 是相册 `remote:<相册码>/<文件夹>`，照片是 `remote:<相册码>#<id>`。
// api.ts 看到这种路径就转到这里，其它界面代码基本不用知道区别。

import { t } from './i18n';
import { isWeb } from './platform';
import { prefs } from './store';
import type { Folder, Library, Photo } from './types';

/** 远程相册服务器（网页和接口都在这个路径下）。不让用户配：本地调试连本机，发布版连正式服务器，网页版就是打开它的那台 */
export const SERVER = isWeb
  ? (globalThis.location?.origin ?? '') + import.meta.env.BASE_URL.replace(/\/$/, '')
  : import.meta.env.DEV
    ? 'http://localhost:8081'
    : 'https://czt666.cn/photo-picker';

export const REMOTE = 'remote:';
export const isRemotePath = (p: string): boolean => p.startsWith(REMOTE);
/** 远程相册本身（相当于工作目录） */
export const albumPath = (code: string): string => `${REMOTE}${code}`;
/** 远程相册里的一个子文件夹；照片都在根目录时就是相册本身 */
export const folderPath = (code: string, folder: string): string => (folder ? `${REMOTE}${code}/${folder}` : `${REMOTE}${code}`);

/**
 * `remote:ABC#17` → 照片 { code: 'ABC', id: 17 }；
 * `remote:ABC/2024/旅行` → 文件夹 { code, folder: '2024/旅行' }；`remote:ABC` → 根 { code, folder: '' }
 */
export function parseRemotePath(p: string): { code: string; id: number | null; folder: string | null } {
  const rest = p.slice(REMOTE.length);
  const hash = rest.indexOf('#');
  if (hash >= 0) return { code: rest.slice(0, hash), id: Number(rest.slice(hash + 1)), folder: null };
  const slash = rest.indexOf('/');
  return slash < 0 ? { code: rest, id: null, folder: '' } : { code: rest.slice(0, slash), id: null, folder: rest.slice(slash + 1) };
}

/** 本机记住的一个远程相册（连接过或创建过的） */
export interface RemoteAlbum {
  server: string;
  code: string;
  name: string;
  /** 只有创建者有：上传、删除、改名要用 */
  ownerToken?: string;
  /** 桌面版创建者：共享出去的本地文件夹（照片的 folder 相对它），导出时直接对回原图 */
  sourceDir?: string;
  count: number;
  starred: number;
}

/** 服务器返回的照片 */
export interface ServerPhoto {
  id: number;
  name: string;
  folder: string;
  companions: string[];
  width: number;
  height: number;
  size: number;
  starred: boolean;
  starred_by: string | null;
}

interface ServerAlbum {
  id: string;
  code: string;
  name: string;
}

export type RemoteEvent =
  | { type: 'stars'; ids: number[]; starred: boolean; by: string }
  | { type: 'photos'; photos: ServerPhoto[] }
  | { type: 'deleted'; ids: number[] }
  | { type: 'presence'; names: string[] }
  | { type: 'album'; name: string }
  | { type: 'gone' }
  /** 断线重连后、或者服务器说我们落后太多：整个相册重新拉过 */
  | { type: 'reload' };

export class RemoteError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** 从用户粘贴的东西里认出服务器和相册码：完整链接 `https://x.com/r/ABC…`，或者只有码 */
export function parseShareInput(input: string, fallbackServer: string): { server: string; code: string } | null {
  const s = input.trim();
  // 服务器可以带路径：https://czt666.cn/photo-picker/r/ABC… → 服务器是 https://czt666.cn/photo-picker
  const m = s.match(/^(https?:\/\/[^\s]+?)\/r\/([0-9A-Za-z]{4,32})\b/);
  if (m) return { server: m[1], code: m[2].toUpperCase() };
  if (/^[0-9A-Za-z]{4,32}$/.test(s) && fallbackServer) return { server: trimSlash(fallbackServer), code: s.toUpperCase() };
  return null;
}

export function shareLink(a: { server: string; code: string }): string {
  return `${a.server}/r/${a.code}`;
}

class Remote {
  albums: RemoteAlbum[] = prefs.get<RemoteAlbum[]>('remote.albums', []);
  /** 当前作为工作目录打开的远程相册；null = 用的是本地工作目录 */
  active: string | null = prefs.get<string | null>('remote.active', null);
  /** 每个相册在服务器上的内部 id（拼图片地址用） */
  private ids = new Map<string, string>();
  /** 最近一次拉到的照片：给“已加星标”汇总、计数用 */
  private cache = new Map<string, ServerPhoto[]>();
  /** 谁正在看 */
  presence = new Map<string, string[]>();
  private sockets = new Map<string, WebSocket>();
  private listeners: ((code: string, ev: RemoteEvent) => void)[] = [];

  get name(): string {
    return prefs.get<string>('remote.name', '');
  }

  set name(v: string) {
    prefs.set('remote.name', v.trim());
    for (const ws of this.sockets.values()) this.hello(ws);
  }

  get(code: string): RemoteAlbum | undefined {
    return this.albums.find((a) => a.code === code);
  }

  /** 切换当前工作目录：只给当前这个相册挂实时通道 */
  activate(code: string | null): void {
    if (this.active && this.active !== code) {
      const ws = this.sockets.get(this.active);
      this.sockets.delete(this.active);
      ws?.close();
      this.cache.delete(this.active);
    }
    this.active = code;
    prefs.set('remote.active', code);
    if (code) this.subscribe(code);
  }

  /** 远程相册当工作目录用：按摄影师电脑上的文件夹分成一个个相册 */
  async library(code: string): Promise<Library> {
    if (!this.cache.has(code)) await this.fetch(code);
    return this.libraryFromCache(code);
  }

  libraryFromCache(code: string): Library {
    const a = this.get(code);
    const byFolder = new Map<string, ServerPhoto[]>();
    for (const p of this.cache.get(code) ?? []) {
      if (!byFolder.has(p.folder)) byFolder.set(p.folder, []);
      byFolder.get(p.folder)!.push(p);
    }
    const folders: Folder[] = [...byFolder.entries()]
      .sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true }))
      .map(([folder, photos]) => ({
        path: folderPath(code, folder),
        name: folder ? folder.split('/').pop()! : (a?.name ?? code),
        rel: folder,
        root: albumPath(code),
        count: photos.length,
        starred: photos.filter((p) => p.starred).length,
      }));
    return { workdir: albumPath(code), recent: [], missing: [], folders };
  }

  onEvent(fn: (code: string, ev: RemoteEvent) => void): void {
    this.listeners.push(fn);
  }

  private save(): void {
    prefs.set('remote.albums', this.albums);
  }

  private async call<T>(a: { server: string }, method: string, path: string, body?: unknown, owner?: RemoteAlbum): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    if (owner?.ownerToken) headers['x-owner-token'] = owner.ownerToken;
    let res: Response;
    try {
      res = await fetch(`${a.server}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
    } catch {
      throw new RemoteError(t('连不上服务器 {server}', { server: a.server }), 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RemoteError(data.error || `HTTP ${res.status}`, res.status);
    return data as T;
  }

  // ---------- 相册 ----------

  /** 拉一次相册，更新本机记录的名字和计数 */
  async fetch(code: string): Promise<ServerPhoto[]> {
    const a = this.get(code);
    if (!a) throw new RemoteError(t('没有连接这个远程相册'), 404);
    const r = await this.call<{ album: ServerAlbum; photos: ServerPhoto[] }>(a, 'GET', `/albums/${code}`);
    this.ids.set(code, r.album.id);
    this.cache.set(code, r.photos);
    a.name = r.album.name;
    this.recount(code);
    return r.photos;
  }

  /** 一个文件夹里的照片。实时通道开着时本地这份就是最新的，不用每次都去服务器拉 */
  async list(path: string): Promise<Photo[]> {
    const { code, folder } = parseRemotePath(path);
    const photos = this.cache.has(code) && this.sockets.get(code)?.readyState === WebSocket.OPEN ? this.cache.get(code)! : await this.fetch(code);
    return photos
      .filter((p) => p.folder === folder)
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))
      .map((p) => this.toPhoto(code, p));
  }

  /** 这个远程相册里所有带星标的照片（“已加星标的照片”） */
  async listStarred(code: string): Promise<Photo[]> {
    const photos = await this.fetch(code);
    return photos.filter((p) => p.starred).map((p) => this.toPhoto(code, p));
  }

  toPhoto(code: string, p: ServerPhoto): Photo {
    const a = this.get(code)!;
    return {
      path: `${albumPath(code)}#${p.id}`,
      name: p.name,
      dir: folderPath(code, p.folder),
      size: p.size,
      mtime: 0,
      starred: p.starred,
      rating: 0,
      companions: p.companions,
      starredBy: p.starred_by,
      remote: {
        code,
        id: p.id,
        width: p.width,
        height: p.height,
        folder: p.folder,
        img: `${a.server}/img/${this.ids.get(code) ?? ''}/${p.id}`,
      },
    };
  }

  private recount(code: string): void {
    const a = this.get(code);
    const photos = this.cache.get(code);
    if (!a || !photos) return;
    a.count = photos.length;
    a.starred = photos.filter((p) => p.starred).length;
    this.save();
  }

  /** 连接别人发来的相册（链接或相册码） */
  async connect(input: string): Promise<RemoteAlbum> {
    const parsed = parseShareInput(input, SERVER);
    if (!parsed) throw new RemoteError(t('认不出这个链接或相册码'), 400);
    const existing = this.get(parsed.code);
    if (existing) return existing;
    const r = await this.call<{ album: ServerAlbum; photos: ServerPhoto[] }>(parsed, 'GET', `/albums/${parsed.code}`);
    const a: RemoteAlbum = { server: parsed.server, code: r.album.code, name: r.album.name, count: 0, starred: 0 };
    this.albums.push(a);
    this.ids.set(a.code, r.album.id);
    this.cache.set(a.code, r.photos);
    this.recount(a.code);
    return a;
  }

  async create(name: string, password: string | null, sourceDir?: string): Promise<RemoteAlbum> {
    const server = trimSlash(SERVER);
    const r = await this.call<{ album: ServerAlbum; owner_token: string }>({ server }, 'POST', '/albums', { name, password });
    const a: RemoteAlbum = { server, code: r.album.code, name: r.album.name, ownerToken: r.owner_token, sourceDir, count: 0, starred: 0 };
    this.albums.push(a);
    this.ids.set(a.code, r.album.id);
    this.cache.set(a.code, []);
    this.save();
    return a;
  }

  /** 只是从本机列表里拿掉，服务器上的相册不动 */
  forget(code: string): void {
    if (this.active === code) this.activate(null);
    this.albums = this.albums.filter((a) => a.code !== code);
    this.save();
  }

  async rename(code: string, name: string): Promise<void> {
    const a = this.get(code)!;
    await this.call(a, 'PATCH', `/albums/${code}`, { name }, a);
    a.name = name;
    this.save();
  }

  async destroy(code: string): Promise<void> {
    const a = this.get(code)!;
    await this.call(a, 'DELETE', `/albums/${code}`, undefined, a);
    this.forget(code);
  }

  async deletePhotos(code: string, ids: number[]): Promise<void> {
    const a = this.get(code)!;
    await this.call(a, 'POST', `/albums/${code}/photos/delete`, { ids }, a);
  }

  /** 已经传上去的照片的 key（续传时跳过） */
  uploadedKeys(code: string): Set<string> {
    return new Set((this.cache.get(code) ?? []).map((p) => photoKey(p.folder, p.name)));
  }

  async upload(code: string, meta: UploadMeta, thumb: Blob, preview: Blob): Promise<ServerPhoto> {
    const a = this.get(code)!;
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append('meta', JSON.stringify(meta));
      form.append('thumb', thumb, 'thumb.jpg');
      form.append('preview', preview, 'preview.jpg');
      try {
        const r = await this.call<{ photo: ServerPhoto }>(a, 'POST', `/albums/${code}/photos`, form, a);
        const list = this.cache.get(code) ?? [];
        if (!list.some((p) => p.id === r.photo.id)) list.push(r.photo);
        this.cache.set(code, list);
        this.recount(code);
        return r.photo;
      } catch (e) {
        // 网络抖动或服务器临时出错：等一下重试；参数错误直接放弃
        const retry = e instanceof RemoteError && (e.status === 0 || e.status >= 500);
        if (!retry || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  // ---------- 星标 ----------

  /** 加星/取消。返回每个文件夹的最新星标数 */
  async setStars(paths: string[], starred: boolean): Promise<Record<string, number>> {
    const byCode = new Map<string, number[]>();
    for (const p of paths) {
      const { code, id } = parseRemotePath(p);
      if (id === null) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code)!.push(id);
    }
    const out: Record<string, number> = {};
    for (const [code, ids] of byCode) {
      const a = this.get(code);
      if (!a) continue;
      await this.call(a, 'PUT', `/albums/${code}/stars`, { ids, starred, by: this.name || t('匿名') });
      this.applyStars(code, ids, starred, this.name);
      for (const f of this.libraryFromCache(code).folders) out[f.path] = f.starred;
    }
    return out;
  }

  private applyStars(code: string, ids: number[], starred: boolean, by: string): void {
    const set = new Set(ids);
    for (const p of this.cache.get(code) ?? []) {
      if (set.has(p.id)) {
        p.starred = starred;
        p.starred_by = starred ? by : null;
      }
    }
    this.recount(code);
  }

  /** 导出时把远程照片对回原图要用的信息 */
  photoInfo(path: string): ServerPhoto | undefined {
    const { code, id } = parseRemotePath(path);
    return this.cache.get(code)?.find((p) => p.id === id);
  }

  // ---------- 实时推送 ----------

  private hello(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ name: this.name }));
  }

  private subscribe(code: string, retry = 0): void {
    const a = this.get(code);
    if (!a || this.sockets.has(code)) return;
    const ws = new WebSocket(`${a.server.replace(/^http/, 'ws')}/api/albums/${code}/ws`);
    this.sockets.set(code, ws);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.hello(ws);
      // 重连上了：断线期间可能错过了改动，整体刷新一次
      if (retry > 0) this.emit(code, { type: 'reload' });
    };
    ws.onmessage = (m) => {
      let ev: RemoteEvent;
      try {
        ev = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (ev.type === 'stars') this.applyStars(code, ev.ids, ev.starred, ev.by);
      else if (ev.type === 'photos') {
        const list = this.cache.get(code) ?? [];
        for (const p of ev.photos) if (!list.some((x) => x.id === p.id)) list.push(p);
        this.cache.set(code, list);
        this.recount(code);
      } else if (ev.type === 'deleted') {
        const gone = new Set(ev.ids);
        this.cache.set(code, (this.cache.get(code) ?? []).filter((p) => !gone.has(p.id)));
        this.recount(code);
      } else if (ev.type === 'presence') this.presence.set(code, ev.names);
      else if (ev.type === 'album') {
        a.name = ev.name;
        this.save();
      }
      this.emit(code, ev);
    };
    ws.onclose = () => {
      if (this.sockets.get(code) !== ws) return; // 换了工作目录、主动关的
      this.sockets.delete(code);
      if (!this.get(code) || this.active !== code) return;
      // 断了就重连：1s、2s、4s… 最长 30s
      const next = opened ? 1 : retry + 1;
      setTimeout(() => this.subscribe(code, next), Math.min(30_000, 1000 * 2 ** Math.min(next - 1, 5)));
    };
  }

  private emit(code: string, ev: RemoteEvent): void {
    for (const fn of this.listeners) fn(code, ev);
  }
}

export interface UploadMeta {
  key: string;
  name: string;
  folder: string;
  companions: string[];
  width: number;
  height: number;
  size: number;
}

/** 续传判断“这张传过没有”用的键：文件夹 + 去掉扩展名的文件名，小写（服务器那边同样规则） */
export function photoKey(folder: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return ((folder ? folder + '/' : '') + stem).toLowerCase();
}

export const remote = new Remote();

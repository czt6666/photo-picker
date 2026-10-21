// 远程相册：放在服务器上、拿到链接的人都能一起挑的相册。
//
// 服务器上只有压缩预览（2048 像素的预览图 + 512 像素的缩略图），原图留在摄影师电脑上。
// 星标是大家共用的一份：谁加星、谁取消，通过 WebSocket 实时推给所有正在看的人。
//
// 在前端里，远程相册和本地相册长得一样，只是路径换成了 `remote:<相册码>`，照片是 `remote:<相册码>/<id>`。
// api.ts 看到这种路径就转到这里，其它界面代码基本不用知道区别。

import { t } from './i18n';
import { isWeb } from './platform';
import { prefs } from './store';
import type { Folder, Photo } from './types';

export const REMOTE = 'remote:';
export const isRemotePath = (p: string): boolean => p.startsWith(REMOTE);
export const albumPath = (code: string): string => `${REMOTE}${code}`;

/** `remote:ABC234/17` → { code: 'ABC234', id: 17 }；`remote:ABC234` → { code, id: null } */
export function parseRemotePath(p: string): { code: string; id: number | null } {
  const [code, id] = p.slice(REMOTE.length).split('/');
  return { code, id: id ? Number(id) : null };
}

/** 本机记住的一个远程相册（连接过或创建过的） */
export interface RemoteAlbum {
  server: string;
  code: string;
  name: string;
  /** 只有创建者有：上传、删除、改名要用 */
  ownerToken?: string;
  /** 桌面版创建者：原图所在的本地文件夹，导出时直接对回去 */
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

/** 从用户粘贴的东西里认出服务器和相册码：完整链接 `https://x.com/r/ABC234`，或者只有码 `abc234` */
export function parseShareInput(input: string, fallbackServer: string): { server: string; code: string } | null {
  const s = input.trim();
  const m = s.match(/^(https?:\/\/[^/\s]+)(?:\/.*)?\/r\/([0-9A-Za-z]{4,12})\b/);
  if (m) return { server: m[1], code: m[2].toUpperCase() };
  if (/^[0-9A-Za-z]{4,12}$/.test(s) && fallbackServer) return { server: trimSlash(fallbackServer), code: s.toUpperCase() };
  return null;
}

export function shareLink(a: { server: string; code: string }): string {
  return `${a.server}/r/${a.code}`;
}

class Remote {
  albums: RemoteAlbum[] = prefs.get<RemoteAlbum[]>('remote.albums', []);
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

  /** 新建/连接时默认用的服务器：网页版就是当前网站；桌面版在设置里填 */
  get defaultServer(): string {
    return isWeb ? location.origin : prefs.get<string>('remote.server', '');
  }

  set defaultServer(v: string) {
    prefs.set('remote.server', trimSlash(v.trim()));
  }

  get(code: string): RemoteAlbum | undefined {
    return this.albums.find((a) => a.code === code);
  }

  folders(): Folder[] {
    return this.albums.map((a) => ({ path: albumPath(a.code), name: a.name, rel: a.name, root: REMOTE, count: a.count, starred: a.starred }));
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

  async list(code: string): Promise<Photo[]> {
    const photos = await this.fetch(code);
    return photos.map((p) => this.toPhoto(code, p));
  }

  /** 所有远程相册的星标照片（“已加星标的照片”汇总用） */
  async listStarred(): Promise<Photo[]> {
    const out: Photo[] = [];
    for (const a of this.albums) {
      try {
        const photos = await this.fetch(a.code);
        out.push(...photos.filter((p) => p.starred).map((p) => this.toPhoto(a.code, p)));
      } catch {
        /* 某个相册暂时连不上，不影响别的 */
      }
    }
    return out;
  }

  toPhoto(code: string, p: ServerPhoto): Photo {
    const a = this.get(code)!;
    return {
      path: `${albumPath(code)}/${p.id}`,
      name: p.name,
      dir: albumPath(code),
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
    const parsed = parseShareInput(input, this.defaultServer);
    if (!parsed) throw new RemoteError(t('认不出这个链接或相册码'), 400);
    const existing = this.get(parsed.code);
    if (existing) return existing;
    const r = await this.call<{ album: ServerAlbum; photos: ServerPhoto[] }>(parsed, 'GET', `/albums/${parsed.code}`);
    const a: RemoteAlbum = { server: parsed.server, code: r.album.code, name: r.album.name, count: 0, starred: 0 };
    this.albums.push(a);
    this.ids.set(a.code, r.album.id);
    this.cache.set(a.code, r.photos);
    this.recount(a.code);
    this.subscribe(a.code);
    return a;
  }

  async create(server: string, name: string, password: string | null, sourceDir?: string): Promise<RemoteAlbum> {
    server = trimSlash(server.trim());
    const r = await this.call<{ album: ServerAlbum; owner_token: string }>({ server }, 'POST', '/albums', { name, password });
    const a: RemoteAlbum = { server, code: r.album.code, name: r.album.name, ownerToken: r.owner_token, sourceDir, count: 0, starred: 0 };
    this.albums.push(a);
    this.ids.set(a.code, r.album.id);
    this.cache.set(a.code, []);
    this.save();
    this.subscribe(a.code);
    return a;
  }

  /** 只是从本机列表里拿掉，服务器上的相册不动 */
  forget(code: string): void {
    this.sockets.get(code)?.close();
    this.sockets.delete(code);
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

  /** 加星/取消。返回每个相册的最新星标数 */
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
      out[albumPath(code)] = a.starred;
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

  /** 给本机记住的所有远程相册都挂上实时通道 */
  subscribeAll(): void {
    for (const a of this.albums) this.subscribe(a.code);
  }

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
      if (this.sockets.get(code) !== ws) return; // 被 forget 主动关的
      this.sockets.delete(code);
      if (!this.get(code)) return;
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

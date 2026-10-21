// 三个页面共用的小工具：调接口、界面文字（中/英）、提示条、对话框。

export interface Album {
  id: string;
  name: string;
  share_code?: string;
  pick_limit: number | null;
  closed: boolean;
  created_at: number;
}

export interface Photo {
  id: number;
  key: string;
  name: string;
  folder: string;
  originals: string[];
  width: number;
  height: number;
}

export interface Pick {
  photo_id: number;
  note: string;
}

export interface Picker {
  name: string;
  submitted: boolean;
  updated_at: number;
  picks: Pick[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body === undefined || body instanceof FormData ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(t('网络断了，请稍后重试', 'Network error, please retry'), 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data as T;
}

export const thumbUrl = (albumId: string, p: Photo) => `/img/${albumId}/${p.id}_t.jpg`;
export const previewUrl = (albumId: string, p: Photo) => `/img/${albumId}/${p.id}_p.jpg`;

// ---------- 界面文字 ----------
// 跟随系统语言：中文系统显示中文，其它显示英文。文字直接写在调用处，省得来回对 key。

export const isZh = /^zh/i.test(navigator.language || 'zh');

export function t(zh: string, en: string): string {
  return isZh ? zh : en;
}

/** 把 `{n}` 之类的占位符换成值 */
export function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export function applyI18n(root: ParentNode = document) {
  if (isZh) return;
  root.querySelectorAll<HTMLElement>('[data-en]').forEach((el) => (el.textContent = el.dataset.en!));
  root.querySelectorAll<HTMLElement>('[data-en-ph]').forEach((el) => el.setAttribute('placeholder', el.dataset.enPh!));
  root.querySelectorAll<HTMLElement>('[data-en-title]').forEach((el) => (el.title = el.dataset.enTitle!));
  document.documentElement.lang = 'en';
}

// ---------- DOM 小工具 ----------

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error('missing ' + sel);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 4000 : 2200);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 简单的确认框 / 输入框（不用浏览器自带的 confirm，手机上那个很丑还会被微信拦） */
export function dialog(opts: {
  title: string;
  body?: string;
  input?: { value: string; placeholder?: string; multiline?: boolean; type?: string };
  ok?: string;
  cancel?: string;
  danger?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const field = opts.input
      ? opts.input.multiline
        ? h('textarea', { rows: '4', placeholder: opts.input.placeholder, maxlength: '500' })
        : h('input', { type: opts.input.type ?? 'text', placeholder: opts.input.placeholder })
      : null;
    if (field) (field as HTMLInputElement).value = opts.input!.value;
    const okBtn = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'submit' }, opts.ok ?? t('确定', 'OK'));
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, opts.cancel ?? t('取消', 'Cancel'));
    const form = h(
      'form',
      { class: 'dialog' },
      h('h3', {}, opts.title),
      opts.body ? h('p', { class: 'dim' }, opts.body) : null,
      field,
      h('div', { class: 'dialog-actions' }, cancelBtn, okBtn),
    );
    const mask = h('div', { class: 'mask' }, form);
    const done = (v: string | null) => {
      mask.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(field ? (field as HTMLInputElement).value : '');
    });
    cancelBtn.addEventListener('click', () => done(null));
    mask.addEventListener('click', (e) => e.target === mask && done(null));
    document.addEventListener('keydown', onKey, true);
    document.body.append(mask);
    (field ?? okBtn).focus();
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 下或老浏览器没有 clipboard API，退回老办法
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function download(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 自然排序：IMG_2 在 IMG_10 前面 */
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortPhotos(photos: Photo[]): Photo[] {
  return photos.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name));
}

export function timeAgo(sec: number): string {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return t('刚刚', 'just now');
  if (d < 3600) return fmt(t('{n} 分钟前', '{n} min ago'), { n: Math.floor(d / 60) });
  if (d < 86400) return fmt(t('{n} 小时前', '{n} h ago'), { n: Math.floor(d / 3600) });
  return new Date(sec * 1000).toLocaleDateString();
}

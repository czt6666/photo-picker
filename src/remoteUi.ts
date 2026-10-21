// 远程相册的对话框：创建、连接、填名字。和导出对话框共用同一个弹层（#export-dialog）。

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import { t } from './i18n';
import { isTauri, isWeb } from './platform';
import { remote, RemoteError, shareLink, type RemoteAlbum } from './remote';
import { jobsFromFiles, jobsFromLocal, uploadJobs, type SourceFile, type UploadJob, type UploadProgress } from './remoteUpload';
import { store } from './store';
import { esc, toast } from './ui';

const layer = () => document.getElementById('export-dialog')!;

export function isModalOpen(): boolean {
  return !layer().hidden;
}

/** 打开弹层；返回关闭函数。点遮罩或按 Esc（由 main.ts 统一处理）关闭 */
function modal(html: string): { el: HTMLElement; close: () => void } {
  const el = layer();
  el.innerHTML = `<div class="modal-card remote-dlg">${html}</div>`;
  el.hidden = false;
  const close = () => {
    el.hidden = true;
    el.innerHTML = '';
  };
  el.onclick = (e) => e.target === el && close();
  return { el, close };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 下或老浏览器没有 clipboard API，退回老办法
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

const nameField = () =>
  remote.name
    ? ''
    : `<div class="field"><div class="label">${t('你的名字')}</div>
       <input class="input wide r-name" maxlength="40" placeholder="${t('大家能看到星标是谁加的')}"></div>`;

function takeName(el: HTMLElement): boolean {
  const input = el.querySelector<HTMLInputElement>('.r-name');
  if (!input) return true;
  if (!input.value.trim()) {
    input.focus();
    toast(t('请填写你的名字'), 'warn');
    return false;
  }
  remote.name = input.value;
  return true;
}

/** 第一次在远程相册里加星前问一下名字（大家能看到谁加的星） */
export function ensureName(): Promise<boolean> {
  if (remote.name) return Promise.resolve(true);
  return new Promise((resolve) => {
    const { el, close } = modal(`<h2>${t('你的名字')}</h2>
      <p class="dim">${t('远程相册的星标大家共用，会显示是谁加的。')}</p>
      ${nameField()}
      <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary ok">${t('好')}</button></div>`);
    const done = (ok: boolean) => {
      close();
      resolve(ok);
    };
    el.querySelector('.cancel')!.addEventListener('click', () => done(false));
    const ok = () => takeName(el) && done(true);
    el.querySelector('.ok')!.addEventListener('click', ok);
    el.querySelector<HTMLInputElement>('.r-name')!.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    el.querySelector<HTMLInputElement>('.r-name')!.focus();
  });
}

/** 连接远程相册：粘贴链接或相册码 */
export function showConnect(onDone: (a: RemoteAlbum) => void): void {
  const { el, close } = modal(`<h2>${t('连接远程相册')}</h2>
    <div class="field"><div class="label">${t('链接或相册码')}</div>
      <input class="input wide r-link" placeholder="https://…/r/ABC234" autocomplete="off" spellcheck="false"></div>
    ${nameField()}
    <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary ok">${t('连接')}</button></div>`);
  const link = el.querySelector<HTMLInputElement>('.r-link')!;
  link.focus();
  const go = async () => {
    if (!link.value.trim()) return link.focus();
    if (!takeName(el)) return;
    try {
      const a = await remote.connect(link.value);
      close();
      onDone(a);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error', 4000);
    }
  };
  el.querySelector('.cancel')!.addEventListener('click', close);
  el.querySelector('.ok')!.addEventListener('click', () => void go());
  link.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
}

// ---------- 上传 ----------

let uploading: { code: string; cancel: boolean } | null = null;

export function uploadingCode(): string | null {
  return uploading?.code ?? null;
}

export function stopUpload(): void {
  if (uploading) uploading.cancel = true;
}

/** 后台上传；进度报给 onProgress（显示在状态栏），完成后提示 */
async function runUpload(a: RemoteAlbum, jobs: UploadJob[], onProgress: (text: string) => void): Promise<void> {
  if (uploading) {
    toast(t('正在上传，等这批传完'), 'warn');
    return;
  }
  const job = { code: a.code, cancel: false };
  uploading = job;
  const text = (p: UploadProgress) => {
    let s = t('上传到「{name}」{done} / {total}', { name: a.name, done: p.done + p.failed.length, total: p.total });
    if (p.failed.length) s += t('，{n} 张失败', { n: p.failed.length });
    return s;
  };
  try {
    const r = await uploadJobs(a.code, jobs, (p) => onProgress(text(p)), () => job.cancel);
    onProgress('');
    if (job.cancel) toast(t('已停止，传了 {n} 张。再传一次会接着传。', { n: r.done }), 'warn', 5000);
    else if (r.failed.length) {
      const names = r.failed.slice(0, 3).map((f) => `${f.label}（${f.error}）`).join('；');
      toast(t('传完了，{n} 张失败：{names}', { n: r.failed.length, names }), 'error', 8000);
    } else if (r.total) toast(t('传完了：{n} 张', { n: r.done }));
    else toast(t('这些照片都已经传过了'));
  } finally {
    uploading = null;
  }
}

/** 网页版：选文件夹/照片的隐藏 input（必须在用户点击里直接触发） */
function filePicker(dir: boolean, onPick: (files: SourceFile[]) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (dir) input.setAttribute('webkitdirectory', '');
  else input.accept = 'image/*,.heic,.heif,.cr2,.cr3,.nef,.nrw,.arw,.dng,.raf,.orf,.rw2,.pef,.srw';
  // 放进页面里再点：游离的 input 在 iOS Safari 上可能被回收，change 就不来了
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    onPick([...(input.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    input.remove();
  });
  input.click();
}

async function localPhotos(dir: string) {
  await store.starsSettled();
  return api.listFolder(dir);
}

/**
 * 创建远程相册。
 * 桌面版：把一个本地相册（默认当前打开的）共享出去，记住原图文件夹，导出时直接对回原图。
 * 网页版：从电脑里选文件夹/照片，在浏览器里压缩后上传。
 */
export function showCreate(sourceDir: string | null, onCreated: (a: RemoteAlbum) => void, onProgress: (text: string) => void): void {
  let dir = sourceDir;
  let files: SourceFile[] = [];
  const dirName = (d: string | null) => (d ? d.split(/[\\/]/).filter(Boolean).pop() ?? d : '');
  const { el, close } = modal(`<h2>${t('创建远程相册')}</h2>
    <p class="dim">${t('拿到链接的人都能打开、一起加星标。只上传压缩预览（约 0.4MB/张），原图留在你电脑上。')}</p>
    <div class="field"><div class="label">${t('照片')}</div>
      ${
        isTauri
          ? `<div class="row"><input class="input r-src" readonly><button class="btn r-pick">${t('选择文件夹…')}</button></div>`
          : `<div class="row"><button class="btn r-dir">${t('选择文件夹…')}</button><button class="btn r-files">${t('选择照片…')}</button><span class="dim r-count"></span></div>`
      }
    </div>
    <div class="field"><div class="label">${t('相册名')}</div><input class="input wide r-title" maxlength="40"></div>
    ${isWeb ? '' : `<div class="field"><div class="label">${t('服务器')}</div><input class="input wide r-server" placeholder="https://…" spellcheck="false"></div>`}
    ${nameField()}
    <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary ok">${t('创建并上传')}</button></div>`);
  const title = el.querySelector<HTMLInputElement>('.r-title')!;
  const server = el.querySelector<HTMLInputElement>('.r-server');
  if (server) server.value = remote.defaultServer;
  const showDir = () => {
    const src = el.querySelector<HTMLInputElement>('.r-src');
    if (src) src.value = dir ?? '';
    if (!title.value && dir) title.value = dirName(dir);
  };
  showDir();
  el.querySelector('.r-pick')?.addEventListener('click', async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: t('选择要共享的相册文件夹'), defaultPath: dir ?? undefined });
    if (typeof picked === 'string') {
      dir = picked;
      title.value = '';
      showDir();
    }
  });
  const picked = (f: SourceFile[]) => {
    files = f;
    el.querySelector('.r-count')!.textContent = t('已选 {n} 个文件', { n: f.length });
    if (!title.value) title.value = dirName(f[0]?.path.includes('/') ? f[0].path.split('/')[0] : '');
  };
  el.querySelector('.r-dir')?.addEventListener('click', () => filePicker(true, picked));
  el.querySelector('.r-files')?.addEventListener('click', () => filePicker(false, picked));
  el.querySelector('.cancel')!.addEventListener('click', close);

  const create = async (password: string | null) => {
    if (isTauri && !dir) return toast(t('请选择要共享的文件夹'), 'warn');
    if (isWeb && !files.length) return toast(t('请选择照片'), 'warn');
    if (!title.value.trim()) return title.focus();
    if (server && !/^https?:\/\/\S+/.test(server.value.trim())) {
      server.focus();
      return toast(t('请填写服务器地址，如 https://photo.example.com'), 'warn');
    }
    if (!takeName(el)) return;
    if (server) remote.defaultServer = server.value;
    let jobs: UploadJob[];
    try {
      jobs = isTauri ? jobsFromLocal(await localPhotos(dir!)) : jobsFromFiles(files);
    } catch (e) {
      return toast(String(e), 'error');
    }
    if (!jobs.length) return toast(t('没找到能用的照片'), 'warn');
    let a: RemoteAlbum;
    try {
      a = await remote.create(server?.value ?? remote.defaultServer, title.value.trim(), password, dir ?? undefined);
    } catch (e) {
      if (e instanceof RemoteError && e.status === 403) {
        const pw = await askPassword();
        if (pw !== null) return create(pw);
        return;
      }
      return toast(e instanceof Error ? e.message : String(e), 'error', 5000);
    }
    close();
    onCreated(a);
    if (await copyText(shareLink(a))) toast(t('链接已复制，发给别人就能一起挑'), 'info', 5000);
    void runUpload(a, jobs, onProgress);
  };
  el.querySelector('.ok')!.addEventListener('click', () => void create(null));
  (isTauri && !dir ? el.querySelector<HTMLElement>('.r-pick') : title)?.focus();
}

/** 往自己建的远程相册里再传（新增的照片，或上次中断的） */
export async function continueUpload(a: RemoteAlbum, onProgress: (text: string) => void): Promise<void> {
  if (isTauri) {
    let dir = a.sourceDir ?? null;
    if (!dir) {
      const picked = await openDialog({ directory: true, multiple: false, title: t('选择要共享的相册文件夹') });
      if (typeof picked !== 'string') return;
      dir = picked;
    }
    try {
      await remote.fetch(a.code); // 先拿到已经传过的，好跳过
      await runUpload(a, jobsFromLocal(await localPhotos(dir)), onProgress);
    } catch (e) {
      toast(String(e), 'error');
    }
    return;
  }
  filePicker(true, (files) => {
    void remote.fetch(a.code).then(() => runUpload(a, jobsFromFiles(files), onProgress)).catch((e) => toast(String(e), 'error'));
  });
}

function askPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    const { el, close } = modal(`<h2>${t('创建密码')}</h2>
      <p class="dim">${t('这台服务器设了创建密码，问一下服务器的管理员。')}</p>
      <input class="input wide r-pw" type="password">
      <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary ok">${t('好')}</button></div>`);
    const pw = el.querySelector<HTMLInputElement>('.r-pw')!;
    pw.focus();
    el.querySelector('.cancel')!.addEventListener('click', () => {
      close();
      resolve(null);
    });
    el.querySelector('.ok')!.addEventListener('click', () => {
      close();
      resolve(pw.value);
    });
  });
}

/** 简单的确认框 */
export function confirmBox(title: string, body: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { el, close } = modal(`<h2>${esc(title)}</h2><p class="dim">${esc(body)}</p>
      <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary danger ok">${esc(okLabel)}</button></div>`);
    el.querySelector('.cancel')!.addEventListener('click', () => {
      close();
      resolve(false);
    });
    el.querySelector('.ok')!.addEventListener('click', () => {
      close();
      resolve(true);
    });
  });
}

/** 输入框（改名用） */
export function promptBox(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { el, close } = modal(`<h2>${esc(title)}</h2><input class="input wide r-val" maxlength="40">
      <div class="actions"><button class="btn cancel">${t('取消')}</button><button class="btn primary ok">${t('好')}</button></div>`);
    const input = el.querySelector<HTMLInputElement>('.r-val')!;
    input.value = value;
    input.select();
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    el.querySelector('.cancel')!.addEventListener('click', () => done(null));
    el.querySelector('.ok')!.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value.trim() || null));
  });
}

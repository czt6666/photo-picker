// 小型界面工具：提示条、右键菜单、HTML 转义。

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 2600): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** 灰色小字（快捷键或路径） */
  detail?: string;
  /** 分组标题行（不可点） */
  separator?: boolean;
  /** 文字前面的图标（SVG） */
  icon?: string;
  /** 红字（删除之类） */
  danger?: boolean;
  /** 当前选中的那一项 */
  current?: boolean;
  /** 行尾的小按钮（比如垃圾桶） */
  trail?: { icon: string; title: string; action: () => void };
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  for (const it of items) {
    if (it.separator) {
      const h = document.createElement('div');
      h.className = 'menu-sep';
      h.textContent = it.label;
      m.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = it.label;
    if (it.icon) label.insertAdjacentHTML('afterbegin', it.icon);
    b.appendChild(label);
    if (it.danger) b.classList.add('danger');
    if (it.current) b.classList.add('current');
    if (it.detail) {
      const d = document.createElement('span');
      d.className = 'menu-detail';
      d.textContent = it.detail;
      b.appendChild(d);
      b.title = it.detail;
    }
    b.disabled = !!it.disabled;
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    if (it.trail) {
      const tr = it.trail;
      const x = document.createElement('span');
      x.className = 'menu-trail';
      x.title = tr.title;
      x.setAttribute('role', 'button');
      x.innerHTML = tr.icon;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        tr.action();
      });
      b.appendChild(x);
    }
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  openMenu = m;
}

window.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});
window.addEventListener('blur', closeMenu);

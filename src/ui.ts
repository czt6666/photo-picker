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
    const b = document.createElement('button');
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
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

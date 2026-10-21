// 首页：模特输共享码；摄影师建相册、回到自己的相册。

import { rememberAlbum, savedAlbums } from './albums';
import { $, Album, api, applyI18n, errMsg, h, toast } from './common';

applyI18n();

const codeIn = $<HTMLInputElement>('#code');
codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^0-9A-Z]/g, '')));
$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  location.href = '/s/' + encodeURIComponent(codeIn.value.trim());
});

api<{ create_password_required: boolean }>('GET', '/config')
  .then((c) => ($('#pw-row').hidden = !c.create_password_required))
  .catch(() => {});

$('#create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>('#create button[type=submit]');
  btn.disabled = true;
  try {
    const limit = Number($<HTMLInputElement>('#limit').value) || 0;
    const r = await api<{ album: Album; admin_token: string }>('POST', '/albums', {
      name: $<HTMLInputElement>('#name').value,
      pick_limit: limit > 0 ? limit : null,
      password: $<HTMLInputElement>('#pw').value || null,
    });
    rememberAlbum(r.admin_token, r.album.name);
    location.href = '/a/' + r.admin_token;
  } catch (err) {
    toast(errMsg(err), 'error');
    btn.disabled = false;
  }
});

const mine = savedAlbums();
if (mine.length) {
  $('#mine').hidden = false;
  $('#mine-list').append(...mine.map((a) => h('li', {}, h('a', { href: '/a/' + a.token }, a.name), h('span', { class: 'dim small' }, new Date(a.at).toLocaleDateString()))));
}

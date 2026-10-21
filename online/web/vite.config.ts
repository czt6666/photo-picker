import { resolve } from 'node:path';
import { defineConfig, Plugin } from 'vite';

// 开发时把 /a/<令牌>、/s/<共享码> 指到对应页面（线上由服务端做同样的事）
const pageRoutes: Plugin = {
  name: 'page-routes',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/a/')) req.url = '/admin.html';
      else if (req.url?.startsWith('/s/')) req.url = '/pick.html';
      next();
    });
  },
};

// 三个页面：首页（输共享码 / 建相册）、摄影师管理页、模特选片页。
// 开发时 `npm run dev`，接口转给本机 8080 上跑着的服务端（cargo run）。
export default defineConfig({
  plugins: [pageRoutes],
  server: {
    port: 5180,
    proxy: { '/api': 'http://127.0.0.1:8080', '/img': 'http://127.0.0.1:8080' },
  },
  appType: 'mpa',
  build: {
    // 微信内置浏览器和老 iPad 也要能打开
    target: ['es2020', 'safari14'],
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        pick: resolve(import.meta.dirname, 'pick.html'),
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});

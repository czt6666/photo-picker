import { defineConfig } from 'vite';

// Tauri 推荐配置：固定端口、不清屏，让 Rust 的编译输出可见
export default defineConfig({
  // 网页版部署在子路径下时（如 https://czt666.cn/photo-picker/），构建时设 PP_WEB_BASE=/photo-picker/
  base: process.env.PP_WEB_BASE || '/',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // macOS 11 自带的 Safari 14 起步
    target: ['es2021', 'safari14'],
    sourcemap: false,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});

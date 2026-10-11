#!/usr/bin/env bash
# 本地调试预览版：在自己的 Mac 上编译运行，改了前端代码窗口里立刻刷新。
#
# 预览版用单独的 App 名字和 identifier（见 src-tauri/tauri.preview.json），
# 设置、缩略图缓存都和正式版分开存，两个可以同时开，互不影响。星标照样写在照片文件夹的 .picasa.ini 里。
#
# 用法：
#   scripts/preview.sh                 当前代码，开发模式（改 src/ 下的文件，窗口自动刷新；改 Rust 会自动重新编译重启）
#   scripts/preview.sh --app           当前代码，打一个调试版 .app 并打开（不带热刷新，双击就能再开）
#   scripts/preview.sh pr 1 2          把 PR #1、#2 合到最新 main 上一起试（在 .preview/ 里，不动你当前的代码）
#   scripts/preview.sh branch 分支名…   同上，按分支名
#   scripts/preview.sh pr 2 --app      以上都可以加 --app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_MODE=0
KIND=""
REFS=()
for a in "$@"; do
  case "$a" in
    --app) APP_MODE=1 ;;
    pr | branch) KIND="$a" ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) REFS+=("$a") ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "✗ 没找到 $1。$2"; exit 1; }
}
need node "装 Node 20+：https://nodejs.org 或 brew install node"
need cargo "装 Rust：curl https://sh.rustup.rs -sSf | sh"
if [[ "$(uname)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
  echo "✗ 需要 Xcode 命令行工具：xcode-select --install"; exit 1
fi

DIR="$ROOT"
if [[ -n "$KIND" ]]; then
  [[ ${#REFS[@]} -gt 0 ]] || { echo "✗ 要给出 PR 号或分支名，例如：scripts/preview.sh pr 1 2"; exit 1; }
  # 在 .preview/ 这个单独的工作区里：从最新 main 开始，依次合入要试的 PR / 分支
  DIR="$ROOT/.preview"
  git fetch -q origin main
  if [[ ! -e "$DIR/.git" ]]; then
    rm -rf "$DIR"
    git worktree add -q --detach "$DIR" origin/main
  fi
  git -C "$DIR" merge --abort >/dev/null 2>&1 || true
  git -C "$DIR" reset -q --hard origin/main
  git -C "$DIR" clean -qfd -e node_modules
  i=0
  for r in "${REFS[@]}"; do
    if [[ "$KIND" == pr ]]; then src="pull/$r/head"; label="PR #$r"; else src="$r"; label="$r"; fi
    i=$((i + 1))
    git fetch -q origin "+$src:refs/preview/$i"
    echo "→ 合入 $label"
    git -C "$DIR" -c user.name=preview -c user.email=preview@localhost merge -q --no-edit "refs/preview/$i" ||
      { echo "✗ $label 和前面的改动冲突，没法一起预览。可以分开试：scripts/preview.sh $KIND $r"; exit 1; }
  done
  # Rust 编译结果和主目录共用，第二次起只编译改过的部分
  export CARGO_TARGET_DIR="$ROOT/src-tauri/target"
fi

cd "$DIR"
# package-lock.json 变了（或第一次）才重新装依赖
LOCK_SUM="$(cksum < package-lock.json)"
if [[ ! -d node_modules ]] || [[ "$(cat node_modules/.preview-lock 2>/dev/null)" != "$LOCK_SUM" ]]; then
  echo "→ 安装前端依赖"
  npm ci --no-audit --no-fund
  echo "$LOCK_SUM" > node_modules/.preview-lock
fi

# 用主目录里的这份配置：要试的分支（比如还没合进来的 PR）里不一定有这个文件
CONF="$ROOT/src-tauri/tauri.preview.json"
if [[ $APP_MODE == 1 ]]; then
  echo "→ 编译调试版 .app（第一次要几分钟，之后快很多）"
  if [[ "$(uname)" == "Darwin" ]]; then
    npx tauri build --debug --config "$CONF" --bundles app
    APP="${CARGO_TARGET_DIR:-src-tauri/target}/debug/bundle/macos/PhotoPicker Preview.app"
    echo "✓ $APP"
    open "$APP"
  else
    npx tauri build --debug --config "$CONF" --no-bundle
    echo "✓ ${CARGO_TARGET_DIR:-src-tauri/target}/debug/photo-picker"
  fi
else
  echo "→ 开发模式启动（第一次编译 Rust 要几分钟；之后改 src/ 下的文件，窗口里立刻刷新）"
  npx tauri dev --config "$CONF"
fi

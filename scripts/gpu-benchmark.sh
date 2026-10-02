#!/usr/bin/env bash
#
# Real-GPU frame rate measurement.
#
# Why this is a separate script: head-less Chrome renders through SwiftShader, a software
# rasteriser, and its frame times are dominated by the environment rather than by the
# scene. Measured that way, both the trap-free and the trap-heavy scene pinned at a p95 of
# exactly 30.4 ms — a vsync beat, not a workload. Those numbers cannot answer the question
# the architecture document actually asks ("does this hold 60 FPS at 100 units + 20 props").
#
# This launches a VISIBLE Chrome window so the measurement goes through the real GPU. A
# window will open on screen and will close when the run finishes.
#
# Usage:
#   npm run bench:gpu
#   SCENES="stress" SECONDS=8 npm run bench:gpu
#
# While it runs, do not start anything else heavy — the point is a clean measurement.

set -euo pipefail

PORT="${PORT:-9333}"
PREVIEW_PORT="${PREVIEW_PORT:-4173}"
SECONDS_PER_SCENE="${SECONDS:-8}"
SCENES="${SCENES:-battle mechanism stress}"
PROFILE_DIR="${PROFILE_DIR:-.bench-chrome-gpu}"

# Git Bash on Windows needs the /c/ form; a native install may be anywhere else.
CHROME_CANDIDATES=(
  "${CHROME:-}"
  "/c/Program Files/Google/Chrome/Application/chrome.exe"
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "$(command -v google-chrome || true)"
  "$(command -v chromium || true)"
)

CHROME_BIN=""
for candidate in "${CHROME_CANDIDATES[@]}"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "找不到 Chrome。请设置 CHROME=/path/to/chrome 后重试。" >&2
  exit 1
fi

if [ ! -f dist/index.html ]; then
  echo "dist/index.html 不存在。请先运行：npx vite build --emptyOutDir" >&2
  exit 1
fi

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${PREVIEW_PID:-}" ] && kill "$PREVIEW_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "启动预览服务 (127.0.0.1:$PREVIEW_PORT) ..."
npx vite preview --port "$PREVIEW_PORT" --strictPort --host 127.0.0.1 >/dev/null 2>&1 &
PREVIEW_PID=$!

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PREVIEW_PORT/"; then
    break
  fi
  sleep 0.25
done

echo "启动有头 Chrome（真实 GPU）..."
# No --headless, no --disable-gpu, no SwiftShader: the whole point is the real pipeline.
"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$(pwd)/$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --window-size=1600,900 \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome 调试端口未就绪。" >&2
  exit 1
fi

echo
echo "开始测量（每场景 ${SECONDS_PER_SCENE} 秒）。请不要在此时操作其他重负载程序。"
echo

for scene in $SCENES; do
  echo "=== scene=$scene ==="
  node scripts/benchmark.mjs \
    "http://127.0.0.1:$PREVIEW_PORT/?scene=$scene" \
    --seconds="$SECONDS_PER_SCENE" \
    --port="$PORT"
  echo
done

echo "完成。上面的 fps / p95Ms 即为真机 GPU 读数，请与架构文档承诺的 60 FPS 对照。"

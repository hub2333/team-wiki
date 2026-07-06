#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_PORT=3100
UI_PORT=3101

# ── 判断是否已存在 ──────────────────────────────────
kill_port() {
  local port=$1 name=$2
  local pid
  pid=$(lsof -ti tcp:"$port" 2>/dev/null) || true
  if [ -n "$pid" ]; then
    echo "发现 $name (PID: $pid) 占用端口 $port，正在关闭..."
    kill "$pid" 2>/dev/null || true
    # 等待释放
    for i in $(seq 1 10); do
      if ! lsof -ti tcp:"$port" >/dev/null 2>&1; then
        break
      fi
      sleep 0.3
    done
    echo "$name 已关闭"
  fi
}

kill_port $SERVER_PORT "server"
kill_port $UI_PORT "ui"

# ── 启动服务 ────────────────────────────────────────

echo ""
echo "========================================="
echo "  开发模式 - 启动 server (watch) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
npm run dev &
SERVER_PID=$!
echo "server PID: $SERVER_PID"

echo ""
echo "========================================="
echo "  开发模式 - 启动 ui (watch) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-vue-ui"
npm run dev &
UI_PID=$!
echo "ui PID: $UI_PID"

echo ""
echo "server (watch) -> http://localhost:$SERVER_PORT"
echo "ui     (watch) -> http://localhost:$UI_PORT"
echo ""
echo "按 Ctrl+C 停止所有服务"

trap "kill $SERVER_PID $UI_PID 2>/dev/null; exit" SIGINT SIGTERM
wait

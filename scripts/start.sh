#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "========================================="
echo "  启动 server ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
npm start &
SERVER_PID=$!
echo "server PID: $SERVER_PID"

echo ""
echo "========================================="
echo "  启动 ui (开发模式) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-vue-ui"
npm run dev &
UI_PID=$!
echo "ui PID: $UI_PID"

echo ""
echo "server  -> http://localhost:3100"
echo "ui      -> http://localhost:3101"
echo ""
echo "按 Ctrl+C 停止所有服务"

trap "kill $SERVER_PID $UI_PID 2>/dev/null; exit" SIGINT SIGTERM
wait

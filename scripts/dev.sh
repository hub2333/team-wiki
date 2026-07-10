#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_PORT=3100
UI_PORT=3202
if [ -z "${ENV_FILE_NAME:-}" ]; then
  if [ -f "$ROOT_DIR/team-wiki-server/.env.sqlite" ]; then
    ENV_FILE_NAME=".env.sqlite"
  elif [ -f "$ROOT_DIR/team-wiki-server/.env" ]; then
    ENV_FILE_NAME=".env"
  else
    ENV_FILE_NAME=".env.sqlite"
  fi
fi

kill_port() {
  local port=$1 name=$2
  local pid
  pid=$(lsof -ti tcp:"$port" 2>/dev/null) || true
  if [ -n "$pid" ]; then
    echo "Stopping $name on port $port (PID: $pid) ..."
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 10); do
      if ! lsof -ti tcp:"$port" >/dev/null 2>&1; then
        break
      fi
      sleep 0.3
    done
  fi
}

kill_port $SERVER_PORT "server"
kill_port $UI_PORT "ui"

echo ""
echo "========================================="
echo "  Starting server (watch) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
ENV_FILE="$ENV_FILE_NAME" npm run dev &
SERVER_PID=$!
echo "server PID: $SERVER_PID"

echo ""
echo "========================================="
echo "  Starting ui (watch) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-react-ui"
npm run dev &
UI_PID=$!
echo "ui PID: $UI_PID"

echo ""
echo "server (watch) -> http://localhost:$SERVER_PORT"
echo "ui     (watch) -> http://localhost:$UI_PORT"
echo "env            -> $ENV_FILE_NAME"
echo ""
echo "Press Ctrl+C to stop both services"

trap "kill $SERVER_PID $UI_PID 2>/dev/null; exit" SIGINT SIGTERM
wait

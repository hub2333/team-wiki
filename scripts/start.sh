#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE_NAME="${ENV_FILE_NAME:-.env.sqlite}"

echo "========================================="
echo "  Starting server ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
npm run start -- --env-file "$ENV_FILE_NAME" &
SERVER_PID=$!
echo "server PID: $SERVER_PID"

echo ""
echo "========================================="
echo "  Starting ui (vite dev) ..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-react-ui"
npm run dev &
UI_PID=$!
echo "ui PID: $UI_PID"

echo ""
echo "server -> http://localhost:3100"
echo "ui     -> http://localhost:3202"
echo "env    -> $ENV_FILE_NAME"
echo ""
echo "Press Ctrl+C to stop both services"

trap "kill $SERVER_PID $UI_PID 2>/dev/null; exit" SIGINT SIGTERM
wait

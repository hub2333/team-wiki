#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "启动 server ..."
cd "$ROOT_DIR/team-wiki-server"
npm start

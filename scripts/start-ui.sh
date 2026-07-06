#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "启动 ui (开发模式) ..."
cd "$ROOT_DIR/team-wiki-vue-ui"
npm run dev

#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "========================================="
echo "  构建 server..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
npm run build
echo "server 构建完成"

echo ""
echo "========================================="
echo "  构建 ui..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-vue-ui"
npm run build
echo "ui 构建完成"

echo ""
echo "✅ 全部构建完成"

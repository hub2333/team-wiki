#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "========================================="
echo "  Building server..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-server"
npm run build
echo "server build complete"

echo ""
echo "========================================="
echo "  Building ui..."
echo "========================================="
cd "$ROOT_DIR/team-wiki-vue-ui"
npm run build
echo "ui build complete"

echo ""
echo "All builds complete"

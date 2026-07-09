#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Starting ui (vite dev) ..."
cd "$ROOT_DIR/team-wiki-react-ui"
npm run dev

#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE_NAME="${ENV_FILE_NAME:-.env.sqlite}"

echo "Starting server ..."
cd "$ROOT_DIR/team-wiki-server"
npm run start -- --env-file "$ENV_FILE_NAME"

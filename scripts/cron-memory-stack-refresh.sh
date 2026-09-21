#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACK_DIR="$REPO_DIR/memory-stack"
MODE="${1:-fast}"
LOG_DIR="$REPO_DIR/logs"
LOCK_DIR="/tmp/openclaw-memory-stack-${MODE}.lock"

source "$SCRIPT_DIR/cron-env.sh"

mkdir -p "$LOG_DIR"

timestamp() {
  date +%Y-%m-%dT%H:%M:%S%z
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(timestamp) memory-stack ${MODE}: previous run still active; skipping"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

cd "$STACK_DIR"

case "$MODE" in
  fast)
    echo "$(timestamp) memory-stack fast: ingest + Milvus index start"
    npm run index-milvus
    echo "$(timestamp) memory-stack fast: done"
    ;;
  hindsight)
    echo "$(timestamp) memory-stack hindsight: retain start"
    npm run retain
    echo "$(timestamp) memory-stack hindsight: done"
    ;;
  *)
    echo "$(timestamp) memory-stack: unknown mode '$MODE' (expected fast or hindsight)" >&2
    exit 64
    ;;
esac

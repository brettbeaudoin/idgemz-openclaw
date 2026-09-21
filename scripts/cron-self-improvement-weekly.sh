#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
LOCK_DIR="/tmp/openclaw-self-improvement-weekly.lock"

source "$SCRIPT_DIR/cron-env.sh"

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/self-improvement-weekly.log" 2>&1

timestamp() {
  date +%Y-%m-%dT%H:%M:%S%z
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(timestamp) self-improvement weekly: previous run still active; skipping"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "$(timestamp) self-improvement weekly: start"
cd "$REPO_DIR"
node "$REPO_DIR/scripts/self-improvement-weekly.js"
echo "$(timestamp) self-improvement weekly: done"

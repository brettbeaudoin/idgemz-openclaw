#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
LOCK_DIR="/tmp/idgemz-daily-db-operating-brief.lock"

source "$SCRIPT_DIR/cron-env.sh"

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/daily-db-operating-brief.log" 2>&1

timestamp() {
  date +%Y-%m-%dT%H:%M:%S%z
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(timestamp) daily DB operating brief: previous run still active; skipping"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "$(timestamp) daily DB operating brief: start"
cd "$REPO_DIR"
node "$REPO_DIR/scripts/daily-db-operating-brief.js"
echo "$(timestamp) daily DB operating brief: done"

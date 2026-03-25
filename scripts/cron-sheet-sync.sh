#!/bin/bash
# Direct cron: Sheet Sync — Postgres → Google Sheet (hourly, 12 min after Amazon sync)
set -euo pipefail
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-sheet-sync.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting sheet sync" >> "$LOG"
/opt/homebrew/bin/node postgres-sheet-orders-sync.js >> "$LOG" 2>&1
EXIT=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

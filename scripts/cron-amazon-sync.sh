#!/bin/bash
# Direct cron: Amazon Sales Sync (hourly)
# No AI agent wrapper — just runs the script and logs output
set -euo pipefail
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-amazon-sync.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Amazon sync" >> "$LOG"
AMAZON_SYNC_DAYS_BACK=7 /opt/homebrew/bin/node sync-amazon.js >> "$LOG" 2>&1
EXIT=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
# Keep log from growing forever (last 500 lines)
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

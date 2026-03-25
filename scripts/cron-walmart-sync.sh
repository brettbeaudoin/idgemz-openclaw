#!/bin/bash
# Direct cron: Walmart Orders Sync (daily 7:06 AM ET)
set -euo pipefail
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-walmart-sync.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Walmart sync" >> "$LOG"
DAYS_BACK=2 /opt/homebrew/bin/node sync-walmart.js >> "$LOG" 2>&1
EXIT=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

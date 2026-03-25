#!/bin/bash
# Direct cron: Shopify Orders Sync (hourly)
set -euo pipefail
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-shopify-sync.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Shopify sync" >> "$LOG"
/opt/homebrew/bin/node sync-shopify.js >> "$LOG" 2>&1
EXIT=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

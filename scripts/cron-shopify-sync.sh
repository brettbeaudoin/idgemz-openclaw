#!/bin/bash
# Direct cron: Shopify Orders Sync (hourly)
set -euo pipefail
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-shopify-sync.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Shopify sync" >> "$LOG"
if /opt/homebrew/bin/node sync-shopify.js >> "$LOG" 2>&1; then
  if /opt/homebrew/bin/node order-telegram-notifier.js --channel shopify >> "$LOG" 2>&1; then
    EXIT=0
  else
    EXIT=$?
  fi
else
  EXIT=$?
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

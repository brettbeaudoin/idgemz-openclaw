#!/bin/bash
# Direct cron: Etsy forwarded email import (hourly)
set -euo pipefail
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-etsy-import.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Etsy import" >> "$LOG"
if /opt/homebrew/bin/node process-etsy-forwarded-emails.js >> "$LOG" 2>&1; then
  if /opt/homebrew/bin/node order-telegram-notifier.js --channel etsy >> "$LOG" 2>&1; then
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

#!/bin/bash
# Direct cron: Etsy forwarded email import (hourly)
set -euo pipefail
cd /Users/bbeaudoin/clawd/idgemz-openclaw
LOG="/tmp/cron-etsy-import.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Etsy import" >> "$LOG"
/opt/homebrew/bin/node import-etsy-forwarded-emails.js >> "$LOG" 2>&1
EXIT=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (exit $EXIT)" >> "$LOG"
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $EXIT

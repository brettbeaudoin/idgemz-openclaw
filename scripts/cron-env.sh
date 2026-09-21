#!/bin/bash
# Shared environment for IDGemz cron jobs.
# gog uses file keyring so non-interactive cron can access OAuth reliably.
export HOME="/Users/bbeaudoin"
export USER="bbeaudoin"
export LOGNAME="bbeaudoin"
export SHELL="/bin/bash"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Give non-interactive OpenClaw CLI sends enough time under morning load.
export OPENCLAW_HANDSHAKE_TIMEOUT_MS="${OPENCLAW_HANDSHAKE_TIMEOUT_MS:-30000}"
GOG_KEYRING_PASSWORD_FILE="/Users/bbeaudoin/.config/gogcli-keyring-password"
if [ -r "$GOG_KEYRING_PASSWORD_FILE" ]; then
  export GOG_KEYRING_PASSWORD="$(cat "$GOG_KEYRING_PASSWORD_FILE")"
fi

#!/bin/bash
# Export the complete NerdWidgets Google Sheet as a date-stamped XLSX backup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/cron-env.sh"

SHEET_ID="1HoedZLqY6iq3hIKJLq2-qIAEiKuyoQdWflu7bozWpKg"
ACCOUNT="dangerboatai@gmail.com"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/NerdWidgets}"
DATE_TAG="$(date +%Y%m%d)"
OUT_FILE="$BACKUP_DIR/NerdWidgets_BACKUP_${DATE_TAG}.xlsx"
TMP_FILE="$BACKUP_DIR/.NerdWidgets_BACKUP_${DATE_TAG}.xlsx"

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$TMP_FILE"' EXIT

gog drive download "$SHEET_ID" \
  --format xlsx \
  --out "$TMP_FILE" \
  --account "$ACCOUNT" \
  --no-input

# XLSX files are ZIP containers. Refuse to replace a backup with an error page
# or a partial/corrupt download.
if [ ! -s "$TMP_FILE" ] \
  || [ "$(head -c 2 "$TMP_FILE")" != "PK" ] \
  || ! unzip -tqq "$TMP_FILE" >/dev/null \
  || ! unzip -Z1 "$TMP_FILE" | grep -qx '\[Content_Types\].xml' \
  || ! unzip -Z1 "$TMP_FILE" | grep -qx 'xl/workbook.xml'; then
  echo "Google Sheet export failed or was not an XLSX file" >&2
  exit 1
fi

mv -f "$TMP_FILE" "$OUT_FILE"
echo "Created NerdWidgets XLSX backup: $OUT_FILE"

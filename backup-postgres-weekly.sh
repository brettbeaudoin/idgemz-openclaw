#!/bin/bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/postgres}"
DB_URL="${DATABASE_URL:-postgresql://localhost/idgemz}"
PG_DUMP_BIN="${PG_DUMP_BIN:-/opt/homebrew/opt/postgresql@16/bin/pg_dump}"
RETENTION_COUNT="${RETENTION_COUNT:-12}"
DATE_TAG="$(date +%F)"
OUT_FILE="$BACKUP_DIR/idgemz-$DATE_TAG.dump"
TMP_FILE="$OUT_FILE.tmp"
TRASH_BIN="${TRASH_BIN:-$(command -v trash || true)}"

mkdir -p "$BACKUP_DIR"

"$PG_DUMP_BIN" -Fc -d "$DB_URL" -f "$TMP_FILE"

if [ ! -s "$TMP_FILE" ]; then
  echo "Backup failed: dump file is empty" >&2
  exit 1
fi

mv "$TMP_FILE" "$OUT_FILE"

while IFS= read -r old_backup; do
  [ -n "$old_backup" ] || continue
  if [ -n "$TRASH_BIN" ]; then
    "$TRASH_BIN" "$old_backup"
  else
    echo "Skipping retention cleanup because no trash command is available: $old_backup" >&2
  fi
done < <(
  python3 - "$BACKUP_DIR" "$RETENTION_COUNT" <<'PY'
import os, sys
backup_dir = sys.argv[1]
keep = int(sys.argv[2])
files = []
for name in os.listdir(backup_dir):
    if name.startswith('idgemz-') and name.endswith('.dump'):
        path = os.path.join(backup_dir, name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        files.append((mtime, path))
files.sort(reverse=True)
for _, path in files[keep:]:
    print(path)
PY
)

echo "Created Postgres backup: $OUT_FILE"

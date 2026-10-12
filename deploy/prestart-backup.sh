#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/bin:/usr/bin:/bin
export PATH
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ROOT_DIR="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
readonly BACKUP_DIR="$ROOT_DIR/data/backups"

fail() {
  printf 'pre-start backup failed: %s\n' "$1" >&2
  exit 1
}

DATABASE_PATH="${DATABASE_PATH:-}"
RELEASE_SHA="${RELEASE_SHA:-}"
[ -n "$DATABASE_PATH" ] || fail "DATABASE_PATH is missing"
[ -n "$RELEASE_SHA" ] || fail "RELEASE_SHA is missing"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA must be a 40-character lowercase hexadecimal SHA"
[ "$DATABASE_PATH" = "$ROOT_DIR/data/bot.sqlite" ] || fail "DATABASE_PATH must be the persistent application database"

if [ ! -e "$DATABASE_PATH" ]; then
  exit 0
fi
[ -f "$DATABASE_PATH" ] || fail "DATABASE_PATH is not a regular file"

mkdir -p -- "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

readonly BACKUP_TIME="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="${BACKUP_TIME}-${RELEASE_SHA}.sqlite"
suffix=0
while [ -e "$BACKUP_DIR/$BACKUP_NAME" ] || [ -e "$BACKUP_DIR/$BACKUP_NAME.meta" ]; do
  suffix=$((suffix + 1))
  BACKUP_NAME="${BACKUP_TIME}-${RELEASE_SHA}.${suffix}.sqlite"
done
readonly BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
readonly TEMPORARY_BACKUP="$BACKUP_DIR/.${BACKUP_NAME}.tmp.$$"
readonly TEMPORARY_METADATA="$BACKUP_DIR/.${BACKUP_NAME}.meta.tmp.$$"

cleanup() {
  rm -f -- "$TEMPORARY_BACKUP" "$TEMPORARY_METADATA"
}
trap cleanup EXIT

sqlite3 "$DATABASE_PATH" ".timeout 5000" ".backup $TEMPORARY_BACKUP"
[ -s "$TEMPORARY_BACKUP" ] || fail "SQLite backup is empty"

readonly INTEGRITY="$(sqlite3 "$TEMPORARY_BACKUP" "PRAGMA integrity_check;")"
[ "$INTEGRITY" = "ok" ] || fail "SQLite integrity check returned: $INTEGRITY"

readonly SOURCE_BYTES="$(stat -c '%s' "$DATABASE_PATH" 2>/dev/null || stat -f '%z' "$DATABASE_PATH")"
mv -f -- "$TEMPORARY_BACKUP" "$BACKUP_PATH"
printf '{"backupTime":"%s","releaseSha":"%s","sourceBytes":%s}\n' "$BACKUP_TIME" "$RELEASE_SHA" "$SOURCE_BYTES" > "$TEMPORARY_METADATA"
mv -f -- "$TEMPORARY_METADATA" "${BACKUP_PATH}.meta"

BACKUPS=()
while IFS= read -r backup_path; do
  BACKUPS+=("${backup_path##*/}")
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -print | sort)
UNMARKED_COUNT=0
UNMARKED_BACKUPS=()
for backup_name in "${BACKUPS[@]}"; do
  # The application writes bot-<ISO timestamp>.sqlite backups to this same
  # directory; deployment backups use the release timestamp/SHA format.
  [[ "$backup_name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}(\.[0-9]+)?\.sqlite$ ||
    "$backup_name" =~ ^bot-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.sqlite$ ]] || fail "unexpected backup filename: $backup_name"
  if [ -e "$BACKUP_DIR/${backup_name}.keep" ]; then
    continue
  fi
  UNMARKED_BACKUPS+=("$backup_name")
  UNMARKED_COUNT=$((UNMARKED_COUNT + 1))
done

while [ "$UNMARKED_COUNT" -gt 7 ]; do
  oldest="${UNMARKED_BACKUPS[0]}"
  rm -f -- "$BACKUP_DIR/$oldest" "$BACKUP_DIR/$oldest.meta"
  UNMARKED_BACKUPS=("${UNMARKED_BACKUPS[@]:1}")
  UNMARKED_COUNT=$((UNMARKED_COUNT - 1))
done

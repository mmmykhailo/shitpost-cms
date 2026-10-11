#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly SQLITE3="$(command -v sqlite3)"
FAKE_ROOT="$(realpath "$(mktemp -d /tmp/queuebot-backup-test.XXXXXX)")"
trap 'rm -rf -- "$FAKE_ROOT"' EXIT

readonly BASE_RELEASE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly SCRIPT_PATH="$FAKE_ROOT/releases/$BASE_RELEASE_SHA/deploy/prestart-backup.sh"
mkdir -p "$(dirname -- "$SCRIPT_PATH")" "$FAKE_ROOT/data"
cp "$REPO_DIR/deploy/prestart-backup.sh" "$SCRIPT_PATH"
chmod 0755 "$SCRIPT_PATH"

DATABASE_PATH="$FAKE_ROOT/data/bot.sqlite" RELEASE_SHA="$BASE_RELEASE_SHA" "$SCRIPT_PATH"

sqlite3 "$FAKE_ROOT/data/bot.sqlite" 'CREATE TABLE queue_items (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO queue_items(body) VALUES ("backup-test");'
DATABASE_PATH="$FAKE_ROOT/data/bot.sqlite" RELEASE_SHA="$BASE_RELEASE_SHA" "$SCRIPT_PATH"

readonly BACKUP_DIR="$FAKE_ROOT/data/backups"
readonly FIRST_BACKUP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -print | head -n 1)"
[ -n "$FIRST_BACKUP" ]
[ -f "${FIRST_BACKUP}.meta" ]
sqlite3 "$FIRST_BACKUP" 'PRAGMA integrity_check;' | grep -qx ok
touch "${FIRST_BACKUP}.keep"

for index in 1 2 3 4 5 6 7 8; do
  sha="$(printf '%040x' "$index")"
  DATABASE_PATH="$FAKE_ROOT/data/bot.sqlite" RELEASE_SHA="$sha" "$SCRIPT_PATH"
done

backup_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -print | wc -l | tr -d ' ')"
[ "$backup_count" -eq 8 ]
[ -f "$FIRST_BACKUP" ]
[ -f "${FIRST_BACKUP}.keep" ]
[ "$(stat -f '%Lp' "$BACKUP_DIR" 2>/dev/null || stat -c '%a' "$BACKUP_DIR")" = 700 ]

printf 'SQLite pre-start backup, integrity, rotation, and keep-marker tests passed\n'

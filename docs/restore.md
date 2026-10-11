# SQLite restore procedure

Use a verified standalone file produced by the backup service. Do not restore by copying `bot.sqlite` while the bot is running; committed data may still be in its WAL.

1. Stop the bot and confirm no second process owns the database.
2. Preserve the current data directory before changing anything.
3. Inspect the backup with `createRestoreService().inspectBackup(path)`. The service rejects WAL sidecars, checks `PRAGMA integrity_check`, and requires schema migration history.
4. Restore with `createRestoreService().restoreBackup(source, destination)`. The current destination is atomically renamed to a `.before-restore-*` file before the verified backup is installed.
5. Start the bot with scheduling paused. Review uncertain operations, terminal orphans, pending/quarantined updates, and physical source ages.
6. Revalidate Telegram identity and channel rights, then resume scheduling only after admin confirmation.

Keep the pre-restore file until the health review and the first successful post-restore backup are complete.


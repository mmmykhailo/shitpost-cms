# Telegram Channel Queue Bot

This is a single Bun + TypeScript process that treats a private Telegram channel as a durable FIFO queue and publishes one logical post per configured UTC wall-clock slot.

## Quick start

1. Install Bun 1.3 or newer.
2. Copy `.env.example` to `.env` and fill in `BOT_TOKEN`, `ADMIN_USER_ID`, `QUEUE_CHANNEL_ID`, and `TARGET_CHANNEL_ID`.
3. Add the bot as an administrator in both channels. The queue channel needs posting and deletion rights; the destination needs posting, editing, and deletion rights.
4. Start a private chat with the bot.
5. Run `bun install --frozen-lockfile`, then `bun run typecheck` and `bun test`.
6. Start with `bun run start`, use `/health`, add UTC slots, and resume scheduling from `/manage`.

The database defaults to `./data/bot.sqlite`. It is WAL-backed and is intentionally kept on local durable storage. Run exactly one process against one database.

## Behavior and limits

- Whitelisted channel origins are forwarded; other channel origins are copied without attribution.
- User origins are copied and receive `by <alias>` or the Telegram display name. Hidden-user origins can receive a displayed name but cannot have a stable alias.
- Direct posts composed in the queue are copied without a byline.
- Albums are collected briefly and count as one logical FIFO item.
- A source is deleted only after the complete destination output is recorded. Ambiguous sends stop for admin review; they are never silently retried.
- The Bot API retains unconsumed updates for at most 24 hours, so the process must be monitored. It cannot enumerate missed queue history.
- Ordinary Bot API deletion has a 48-hour age limit. The renewal worker creates a new physical queue generation at 36 hours while SQLite keeps the immutable logical FIFO order. Renewals visibly move messages to the bottom of the private channel.
- Queue and destination IDs are numeric Telegram chat IDs. Publication slots are strict daily `HH:MM UTC` values, with at most 96 slots.

## Admin commands

`/start` and `/manage` open the dashboard. The bot also supports `/queue`, `/schedule`, `/whitelist`, `/authors`, `/health`, `/recover`, and `/cancel`. Every command, text prompt, and callback requires the configured numeric admin ID and a private chat.

The recovery flow accepts a private queue-channel link, an explicit message ID, or an increasing ID range. It is intentionally explicit: it cannot discover which posts were missed during downtime.

## Operations

Use `bun run check` for the typecheck and unit suite. `bun run test:coverage` writes the LCOV report and `bun run coverage:gate` enforces the 90% deployment safety-scope target. `bun run test:deploy` exercises activation and rollback in a fake root. Do not commit `.env`, the SQLite database, WAL/SHM files, backups, or logs.

For a backup, stop the bot or use SQLite's backup/VACUUM mechanism after a WAL checkpoint; do not copy only the main database file while WAL is active. Keep seven daily backups by default. To restore, stop the bot, preserve the current data directory, run an integrity check on the restored database, start the bot paused, inspect uncertain operations and physical source ages, then resume workers.

Before production, complete [`docs/telegram-compatibility.md`](docs/telegram-compatibility.md) with a disposable bot and channels. The checklist is a product gate, especially the origin-preserving renewal test.

## Deployment

The VPS deployment uses one systemd-supervised process, a persistent `data/` directory, immutable SHA-named releases, an atomic `current` symlink, pinned SSH host keys, and no inbound application port. Keep the host clock synchronized and allow at least 30 seconds of shutdown grace. A stateless/serverless deployment is not supported because long polling, SQLite, physical renewal, and in-process scheduling are part of the design.

The complete operator runbook is [`docs/deployment.md`](docs/deployment.md). Automatic production enablement remains gated on the remediation findings in [`IMPLEMENTATION_REVIEW.md`](IMPLEMENTATION_REVIEW.md), the 90% coverage gate, and the real-Telegram checklist in [`docs/telegram-compatibility.md`](docs/telegram-compatibility.md).

See `IMPLEMENTATION_PLAN.md` for the full state machine, failure matrix, and Bot API constraints.

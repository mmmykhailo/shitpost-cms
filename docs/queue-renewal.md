# Queue renewal and readable ages

This document records the accepted queue-renewal requirements and the implementation verified on 2026-10-15. The detailed code handoff remains in [the implementation plan](./queue-renewal-implementation-plan.md).

## Accepted requirements

- Queue age means elapsed time since initial enqueueing and does not reset on renewal. Source age controls renewal.
- Renewal preserves the stable item number, publishing position, content, attribution, and album grouping. Replacement messages appear at the bottom of the Telegram queue channel without changing logical publishing order.
- Start renewal at a source age of 36 hours, retaining a 12-hour margin before Telegram's ordinary deletion deadline. Process due items promptly instead of renewing only one item per 15-minute iteration.
- Renewal continues while scheduled publishing is paused.
- After downtime leaves a source older than 48 hours, attempt to create a fresh replacement. Alert the admin when old messages cannot be deleted and require manual cleanup.
- Generate each linked item number using its current queue-channel source; link albums to the first current member. Previously sent listings remain snapshots: opening the queue again obtains updated links.
- Display age using exactly one appropriate unit: seconds, minutes, hours, days, or months. Switch units at 60 seconds, 60 minutes, 24 hours, and 30 days; a month is an approximate 30-day period.
- Use at most two decimal places, removing trailing zeros and using the appropriate singular or plural. Examples: `45 seconds`, `12 minutes`, `3.5 hours`, `2.87 days`, `1.2 months`.
- Apply the same readable age formatting to queue listings and dashboard age fields. Keep internal timestamps and durations numeric.

## Accepted failure behavior

- Drain due renewals oldest source first. A definitely failed item receives a delayed retry and yields to other eligible items instead of monopolizing the worker. This changes maintenance order without changing publishing order.
- Respect Telegram's full rate-limit waiting period, including a bot-wide wait when that is the scope of the limit. Do not shorten the wait to a local retry cap.
- If a replacement may exist but its result is uncertain, retain the originals and request admin review. Do not blindly send another replacement or delete the originals. Continue maintenance for other eligible items while the uncertain item awaits resolution.
- Adopt a replacement only after confirming the complete post or album. If an album is only partially replaced, preserve every surviving original member and flag the item for review. A short replacement result alone does not justify deleting originals or removing the logical item from the queue.
- After a complete replacement is recorded as current, attempt old-source deletion. If deletion fails, retain the replacement as current and track the old messages for cleanup. Alert the admin when manual cleanup is needed, including messages beyond the deletion deadline.

## Implementation status and automated verification

The requested behavior is implemented in the existing queue and renewal paths:

- Queue rows link the stable item number to the first current Telegram source. Reopening `/queue` after repeated renewal resolves the newest generation; older listings remain snapshots.
- Queue and dashboard ages use one readable unit and at most two decimal places. Queue age remains tied to initial enqueueing, while health labels the physical source age separately.
- A sequential worker drains due sources from 36 hours, paces each physical message, resumes full batches without an added idle minute, and continues while scheduled publishing is paused. Definite failures get per-item retry deadlines so ready items can proceed.
- Complete replacement evidence is required before installing a generation. Partial albums and ambiguous results retain originals and require review. Confirmed replacements become current before old-source cleanup.
- Telegram flood waits persist as a shared mutation cooldown across restart. Health capacity uses the worker's pacing, eligibility, per-item retries, and actual cooldown; due uncertain renewals are identified as blocked.
- Normal renewal timestamps replacement sources immediately before transfer. Recovery uses the operation creation time as a conservative source-age lower bound, then retries only old-source cleanup.
- Manual-cleanup alerts group known old IDs by item and generation and include current-source context.

On 2026-10-15, `bun run check:all` passed: typecheck, **262 tests and 1,142 assertions**, the coverage gate (94.75% line and 96.67% function coverage), and both deployment-script suites. The suite includes real temporary-SQLite worker tests for a 60-item due cohort, 100-item batch continuation, retry starvation, paused publishing, shared flood waits, 40-hour recovery, partial albums, replacement updates arriving before the send response, and links after repeated renewal.

These results are automated evidence using local clocks and fake Telegram transport. No live Telegram bot or channel was available, so actual private-link opening, server-side age limits, and live Bot API album/origin behavior remain unverified. The cause of any particular production incident has not been established from runtime evidence.

## Telegram references

- [Bot API deletion limits](https://core.telegram.org/bots/api#deletemessage): ordinary deletion requires a message sent less than 48 hours ago.
- [Message links](https://core.telegram.org/api/links#message-links): public and private channel messages support direct links.

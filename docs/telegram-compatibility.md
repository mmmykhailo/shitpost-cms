# Telegram compatibility gate

The automated Bun/grammY spike is covered by `test/compatibility-spike.test.ts`. As of 2026-10-06 it exercises the actual gateway adapter with grammY-shaped `{ message_id }` responses for `forwardMessages` and `copyMessages`, verifies ordered numeric IDs and numeric deletion payloads, and classifies malformed responses as ambiguous without making network calls. The publisher-plus-adapter regression matrix also covers copied and forwarded single messages and albums.

The real Telegram checklist remains a deployment prerequisite. It requires a disposable bot, a private queue channel, and a disposable destination channel; no credentials or channels were supplied to this workspace, so these observations are intentionally not fabricated:

1. Long polling receives queue posts and edits under the pinned Bun/grammY versions.
2. Re-forwarding channel, known-user, and hidden-user origins back into the queue retains the original origin.
3. Bulk forward/copy preserves albums and returns every expected output ID.
4. Partial album results and missing source messages have the expected Bot API behavior.
5. Copy/edit preserves entities and accepts the appended byline.
6. Captionless user-origin content followed by a separate byline message renders acceptably.
7. Renewal-generated channel posts are suppressed without duplicate ingestion, including after restart.
8. Configured rights allow queue and destination cleanup.
9. Protected and unsupported content produces the expected errors.
10. Private queue message links used by recovery resolve as expected.

Record the date, Bot API behavior, and any plan changes here before enabling production scheduling. In particular, a failed origin-preservation check blocks the Bot API renewal design.

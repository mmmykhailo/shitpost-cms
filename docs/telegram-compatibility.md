# Telegram compatibility gate

The automated Bun/grammY spike is covered by `test/compatibility-spike.test.ts`. It exercises the actual gateway adapter with grammY-shaped `{ message_id }` responses for `forwardMessages` and `copyMessages`, verifies ordered numeric IDs and numeric deletion payloads, and classifies malformed responses as ambiguous without making network calls. The publisher-plus-adapter regression matrix covers copied and forwarded single messages and albums. Preparation, renewal, recovery, restart evidence, and notification retry behavior are exercised separately with temporary SQLite databases and fake Telegram transport.

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
11. Reopening `/queue` after one and repeated renewals links the stable item number to the current replacement message.
12. A renewed album retains every member and order, and its queue link opens the first current member.
13. `/queue`, `/manage`, and `/health` display readable ages and label total queue age separately from physical source age.
14. Partial album replacement evidence is shown for admin review while surviving originals remain in the queue.
15. Prepared user posts show exactly one credit in the queue and destination, while prepared channel posts retain the captured forward/copy behavior.
16. Nickname edits refresh only bot-owned credits, including for exact hidden sender names; admin-edited or removed credits remain unchanged.
17. An issue on an older item does not prevent a later ready item from publishing, while an uncertain send consumes its slot without automatic resend.
18. Recovery defaults to the selected messages as shown, and an explicit `--credit-last` bundle transfers its content and standalone credit as one queue item.
19. A materially changed or recurring issue sends a new notification; an unchanged issue is deduplicated, and failed delivery retries with newly issued callback tokens.

The listed checks are still unverified against live Telegram; the automated suite uses fake transport and local clocks. Record the date, observed Bot API behavior, and any plan changes here before enabling production scheduling. In particular, a failed origin-preservation check blocks the Bot API renewal design. No live Telegram credentials or disposable channels were available during implementation.

# Telegram reliability and admin control

Decisions agreed on 2026-10-17 after the [production investigation](investigations/2026-10-17-telegram-flood-waits.md). Both interview rounds are answered. Final confirmation of shared understanding precedes application implementation. This document supersedes earlier preparation-plan language that allows nickname refresh after a body-only admin edit or leaves scheduled flood-wait retries undefined.

The complete coding handoff is [the detailed implementation plan](telegram-reliability-implementation-plan.md), including migrations, interfaces, transaction boundaries, failure states, and regression checks. Writing that plan does not mean application changes have been implemented.

## Agreed behavior

- Eliminate the nickname revision loop that repeatedly refreshes a post whose author already had a nickname when it was enqueued. Correct existing affected rows without overwriting any newer nickname change or admin edit.
- Any admin edit freezes the whole logical post permanently: all album members, text, captions, formatting, and a separate credit. Leaving the generated credit unchanged does not preserve bot editing rights. Adopt an edited raw submission as shown without adding a byline. Nickname changes do not refresh a frozen post; renewal and publication may copy it unchanged. Freezing is distinct from pausing or blocking publication.
- An admin edit observed before a mutation begins blocks the mutation. If a remote request already initiated collides with an admin edit, stop automatic work for the post and request review. Preserve the admin version and operation evidence; never attempt another bot rewrite to repair the collision.
- Respect Telegram's flood wait. Short waits remain quiet. Notify for a disruption lasting five minutes or requiring admin action; only send recovery for an opening warning confirmed delivered. Recurring waits belong to one incident until five uninterrupted minutes without another wait plus a successful relevant Telegram request. Deadline expiry alone is not recovery.
- Retry a scheduled send only after a definite rejection before output, and for at most five minutes after the original scheduled time. The deadline survives restart. Pausing or successful manual publication cancels pending scheduled retries. Expired occurrences remain skipped; no catch-up burst. A possibly completed send consumes its occurrence and requires review without automatic resend.
- Retain blocked admin responses and prioritize them over background maintenance once Telegram permits delivery. Responses survive restart. New requests for dashboard, health, or queue views replace obsolete pending views; confirmations for distinct actions remain separate. Retry safe delivery rather than replaying a state-changing command.

## Implementation outline

### Stop repeated and unnecessary refresh work

Trace initial enqueue, album completion, preparation claim/install, refresh, nickname updates during an operation, and all owner-release paths. Reconcile the requested revision with the revision actually captured for rendering, preserving a newer request. A newer applied revision with an obsolete zero target must not request another refresh indefinitely. Return the actual persisted preparation state.

Skip Telegram edits when rendered content and relevant entities/options are unchanged. Treat a definite no-op rejection as no remote edit and retire its expected-edit record. Prevent an earliest pending item from spinning or starving later preparation, and pace background requests before rate limits occur. Keep `retry_after` authoritative across every caller; fixing the loop must not be replaced by bypassing cooldowns.

### Persist editorial protection

Record the frozen status independently of credit ownership and carry it through source generations, operation contracts, restart, renewal, recovery of known items, and publication eligibility. A frozen valid post must remain publishable even when the author's nickname revision changes. Automatic preparation/refresh and their retries must honor it; corrective edits may revalidate current content without transforming it again.

Distinguish bot edit echoes from admin edits using current operation evidence and update ordering. Retire expectations after definite failed/no-op requests and obsolete superseded work. A stale matching fingerprint must not indefinitely suppress a later admin revision. Flush known pending edits and recheck protection/version at actual request initiation, including after any wait in outbound delivery. Reject stale completion and preserve review evidence after an in-flight collision.

The Bot API has no conditional expected-version edit, so an already-initiated request cannot be revoked by a later database guard. Preserve this limitation in tests and operator messages instead of claiming a local lock removes it. Existing history does not contain a complete audit that proves all past human edits; do not infer safe bot ownership solely from missing edit timestamps.

### Retain scheduled occurrences through safe retries

Persist the occurrence identity, original deadline, retry eligibility, and pending/cancelled/terminal outcome. A cooldown before any destination request is a deferral rather than a terminal failure. Wake on a due retry within the deadline, recheck pause/cancellation and output uncertainty, and enforce one success for the occurrence. Preserve the distinction between completed destination output and source cleanup; cleanup failure must never resend publication.

### Separate notification state from transport availability

Track incident start, warning delivery, last wait, successful relevant requests, stable recovery, and resolution delivery independently. Repeated retry deadlines update evidence without creating another incident. An undelivered opening warning must not generate an orphan recovery message. A notification itself encountering the cooldown must not reset incident identity or create a feedback loop.

Persist pending response delivery independently of command execution. Cover both gateway-generated messages and direct command replies/edits, including `/start` command registration. Regenerate expiring callback tokens when delivering retained interactive views. Coalesce only replaceable views; preserve distinct action confirmations. Do not retry an ambiguous send as though Telegram definitely rejected it.

## Acceptance checks

- Enqueue after an existing user or hidden-sender nickname: preparation becomes ready once, then subsequent scans are empty. Nickname changes during preparation still receive the latest requested refresh.
- Existing stale wanted/applied rows converge without discarding a newer target. No-op rendering makes no edit request and cannot leave a reusable stale expectation.
- Body-only, credit-only, formatting, raw-source, separate-credit, and album-member admin edits freeze the entire post. Later nickname updates, retries, renewal, restart, and known-item recovery cannot restore bot edit rights or reconstruct content.
- A manual restoration matching old bot output is ingested as the latest admin content. Edits acknowledged while work waits block request initiation; already-initiated collisions preserve evidence and enter review without another rewrite.
- A definite 429 yields one late publication within the original five-minute window; repeated waits, restart, and boundary timing cannot extend it. Pause/manual success cancel retry. Expiry and uncertain output never cause a duplicate send.
- A flood-wait warning blocked by the cooldown produces no standalone recovery. Short repeated waits produce one incident, and only a delivered warning plus the agreed stable-recovery evidence yields one recovery notification.
- Command responses survive a flood wait and restart. Replaceable views coalesce, distinct confirmations survive, callback tokens are fresh at delivery, and state-changing commands execute once.
- Run the typecheck, relevant regression tests, then the full required repository checks. Replace the frozen diagnostic probes with corrected-behavior regression tests at the same real seams; update the incident report with verified fix results.

## Recorded decisions

- [Freeze the whole post after admin edits](adr/0006-freeze-the-whole-post-after-admin-edits.md)
- [Bound scheduled retries to five minutes](adr/0007-bound-scheduled-retries-to-five-minutes.md)

No unresolved product questions remain in the design tree. Implementation details should follow these decisions without reopening settled behavior.

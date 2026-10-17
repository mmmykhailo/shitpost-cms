# Telegram flood waits, recovery messages, and missed publication

Investigation date: 2026-10-17. Production snapshot: approximately 09:29 UTC / 11:29 Europe/Prague. Production and local HEAD both ran `9866e598b9076e816b088bd26014b0c2ec16ac97`.

Status: historical production evidence and decision record. The local implementation was completed in checkpoints `049cc4b`, `dace0e2`, `bb95315`, `1f109c7`, `2a53996`, `0702856`, `2840155`, and `fc9d09e`. No production data, service state, or Telegram messages were changed as part of that work. The snapshot, event counts, and causes below describe the October 17 investigation window, not current production state.

## Confirmed cause

Queue item #86 entered an endless credit-refresh cycle after being submitted with an existing author nickname. Enqueue leaves `nickname_revision_wanted` at its default zero. Preparation reads the author's current alias revision, one, and applies it. Installation compares applied one with wanted zero and leaves the item `refresh_pending`. Every subsequent refresh repeats the same comparison and edits the same credit again.

Code path:

- `src/db/repositories.ts`, `observeQueueSnapshot`: insertion omits the wanted nickname revision.
- `src/services/preparation.ts`, initial preparation and `refreshClaim`: target revision is the maximum of wanted revision and current author revision.
- `src/db/preparation-repository.ts`, `installPreparedGeneration` and `completeInPlaceRefresh`: any mismatch with wanted revision leaves `refresh_pending`, including when the applied revision is newer.
- `claimNextPreparation` selects the earliest pending item repeatedly. Later unprepared items can starve behind it, while the mismatched item is ineligible for publication.
- `refreshClaim` reports `preparationState: "ready"` even when the repository retains `refresh_pending`.

Production item #86 had wanted revision zero, applied revision one, current author revision one, bot-owned inline caption credit, source generation one, and content version 21,376. Its initial preparation contract and result already targeted/applied one; refresh began in the same second as initial preparation.

By the snapshot there were 22,444 refresh attempts for #86. Across all items, 21,367 refreshes completed, 1,068 failed with Telegram retry-after rate limits, and one was running. Only two refreshes belonged to other items. Approximately 1,220–1,250 refresh operations occurred per hour. The first rate-limit failure was on October 16 at 15:18:12 UTC, less than a minute after #86 entered the queue.

The historical Telegram method is inferred to be `editMessageCaption` from the item's inline-caption attribution and refresh code path. Stored error evidence does not retain the method; it does distinguish Telegram retry-after responses from locally synthesized cooldown responses.

## How this produces the reported symptoms

1. **Unpaired recovery notifications.** A Telegram 429 starts a persisted cooldown covering outbound sends and edits. The alert worker records a flood-wait condition and tries to send its warning through that same blocked path. Once the deadline passes, `createAlertService.resolve` sends a recovery notification without checking whether the opening warning was delivered. Repeated waits therefore produce repeated standalone recovery messages. The production flood-wait alert had 662 observations and `last_sent_at = NULL`.
2. **Missed publication occurrences.** The publisher returns `retry_scheduled` after a definite 429, but the scheduler records the occurrence as terminal `failed`, advances its scan cursor, and sleeps until the next configured occurrence. The item becomes eligible again after its wait; the failed occurrence is never retried. A cooldown from credit refresh can therefore consume a publication occurrence before a destination request is made.
3. **Commands without replies.** Command replies use `sendMessage` and share the mutation cooldown. They receive a locally synthesized 429 before reaching Telegram. The outer `bot.catch` logs the middleware failure; it does not retain or retry the response. `/start` also performs a gated `setMyCommands` before its dashboard reply.
4. **Preparation starvation.** The earliest pending credit refresh is selected repeatedly. At the snapshot, three newer items remained unprepared, the oldest since October 16 at 16:40:06 UTC. The backlog contained 40 queued ready items and one item pending credit refresh. The minimized reproduction establishes starvation mechanics; it does not prove every minute of each item's historical delay.

A cooldown deadline expiring is only permission to attempt another request. It is not evidence that Telegram accepted a request or that a failed publication occurrence was recovered. Successful publication also resolves all active `shared_issue:*` alerts before source cleanup, which can produce the other recovery wording quoted in the report.

## Production timeline

All dates are 2026. Prague was UTC+2 on these dates.

| UTC | Prague | Evidence |
| --- | --- | --- |
| Oct 15 17:41:07 | Oct 15 19:41:07 | Service started; no subsequent systemd restarts at snapshot. |
| Oct 16 15:00 | Oct 16 17:00 | Publication of #43 succeeded. |
| Oct 16 15:17:33 | Oct 16 17:17:33 | #86 enqueued, prepared with revision one, and immediately refreshed again. |
| Oct 16 15:18:12 | Oct 16 17:18:12 | First refresh rate limit. First three waits were approximately 44, 42, and 42 seconds. |
| Oct 16 17:00 / 19:00 / 21:00 | Oct 16 19:00 / 21:00 / 23:00 | #44's scheduled occurrences failed with `retry_scheduled`. |
| Oct 17 05:00 | Oct 17 07:00 | #44 published at a later occurrence. |
| Oct 17 06:56:12 | Oct 17 08:56:12 | Command response rejected by local cooldown with 30 seconds remaining. |
| Oct 17 07:00 | Oct 17 09:00 | #45 published; this aligns with the first quoted publication-recovery message. |
| Oct 17 08:00 / 09:00 | Oct 17 10:00 / 11:00 | #46's scheduled occurrences failed with `retry_scheduled`; stored error indicates local cooldown. |
| Oct 17 09:26:12 / 09:26:17 | Oct 17 11:26:12 / 11:26:17 | Command responses rejected by local cooldown with 33 / 28 seconds remaining. |

Service readiness, release identity, and `NRestarts=0` contradict a restart-based explanation for these incidents. Today's operations included two completed/two rate-limited publications and twenty completed/two rate-limited renewals; normal renewal also encountered Telegram rate limits, but the overwhelming repeated work came from #86.

## Follow-up: what causes the wait in the first place?

The user asked to distinguish the original trigger from the consequences. At the follow-up production snapshot, October 17 at approximately 09:34 UTC / 11:34 Prague, preparation had accumulated 1,073 actual Telegram rate-limit failures; #86 still had wanted zero/applied one and content version 21,471.

Aggregate read-only checks found zero `transient_network` or `transient_server` errors in preparation/operation records, zero stored timeout descriptions, and zero matching network/timeout errors in the current deployment journal since October 15 at 17:41 UTC. The journal did contain three command-response errors from locally synthesized cooldown 429s and 151 failed flood-wait alert deliveries. These are the observable failures for this incident; they do not establish a network timeout.

The originating failure is Telegram flood control. An existing nickname followed by a new submission initializes wanted revision incorrectly, causing endless identical caption-edit requests. The preparation worker has no proactive request spacing: it can process ten operations consecutively and immediately start another cycle while work remains. Unlike renewal's separate pacing policy, nothing limits this repeated refresh burst before Telegram returns a real 429. The shared transformer then rejects other outbound mutations locally until `retry_after` expires. The same refresh resumes and repeats the cycle.

Completion counts mean successfully completed local refresh operations, not necessarily content changes accepted by Telegram. The service treats `message is not modified` as successful completion and still leaves the revision mismatch pending. Thus even a no-op rejection does not stop repeated API requests. Production storage does not retain every no-op response, so the number of actual successful caption changes cannot be recovered from the operation count.

Telegram does not publish a complete caption-edit quota or report which internal bucket was exhausted in these stored responses. The evidence supports the runaway requests as the cause of the recurring flood waits; it does not support inventing a precise rate-limit threshold. The exact historical method remains inferred from the inline-caption path.

## Follow-up: permanent protection after admin edits

The requested rule is stronger than the current implementation: any admin edit must end later bot rewriting, even when the generated byline is unchanged. Current code only transfers credit ownership when the generated credit itself changes. There is no durable permanent message-edit lock.

Four minimized reproductions exercise real ingestion, policy, preparation, generated-event, and queue repositories with fake Telegram transport:

1. Prepare a user post, edit its body as admin while preserving the credit, change the author's nickname. Ingestion accepts the admin edit but retains bot credit ownership; refresh edits the same physical message again. The desired no-further-edits assertion fails. Control: changing both body and credit instead transfers ownership to admin and prevents the refresh.
2. Edit a raw submission before preparation. Preparation copies the edited source and appends a byline to the replacement. The original physical source is not edited, but the logical post is transformed. Whether protection covers the entire post is now an explicit frontier decision.
3. Receive `message is not modified` during refresh. Its generated-edit expectation remains pending. A later admin edit that matches the old expected fingerprint is suppressed as a bot edit, leaving SQLite with obsolete content. Control: obsoleting that expectation after the no-op causes the same later edit to be accepted and stored correctly. Pending expectations have no expiry, and the existing operation-obsoletion helper has no production caller.
4. Hold an already-initiated refresh request, ingest an admin edit, then release the request. The stale request can still reach Telegram. The repository detects the version conflict afterward, preserves admin content in SQLite, and marks the operation uncertain; that does not undo the remote mutation. The fake transport demonstrates the race boundary rather than proving a historical production collision.

Production message metadata cannot prove whether #86 received an admin edit: generated edit updates are deliberately consumed without persisting their `edit_date`, and there is no complete human-edit audit. The stale-expectation and admin-edit overwrite defects are independently reproduced, but are not asserted to have historically triggered #86's initial revision loop.

Telegram's documented [text-edit](https://core.telegram.org/bots/api#editmessagetext) and [caption-edit](https://core.telegram.org/bots/api#editmessagecaption) parameters provide no expected content version or conditional edit. Consequently, a guard can prevent initiating future mutations after an observed admin edit; it cannot promise to revoke an already-initiated remote request. The collision policy must be explicit. Source renewal currently copies the current representation without text/caption edits and can preserve protected content unchanged.

## Reproductions and regression coverage

The original diagnostic probes were removed after tests covered the corrected behavior at the relevant service and repository seams. Run those regressions without production credentials or network access:

```sh
bun test test/preparation.test.ts test/publisher.test.ts test/scheduler.test.ts test/admin-reliability.test.ts test/admin.test.ts test/operations.test.ts test/telegram-admission.test.ts test/recovery.test.ts test/migration.test.ts
```

The focused reliability batch passed with 103 tests and 469 assertions; the admin suite passed with 32 tests and 182 assertions after the health view gained durable action counts. The full required repository gate is `bun run check:all`; its final result is recorded below after completion.

Ranked explanations and distinguishing evidence:

| Explanation | Prediction | Result |
| --- | --- | --- |
| Wanted nickname revision is stale after enqueue | Setting wanted to current revision in a synthetic fixture stops the loop. | Confirmed: one edit, then `prepared / empty / empty`. |
| Telegram's own edit updates re-trigger preparation | Removing edit echoes stops the loop. | Rejected: loop persists with no incoming edit updates; echoed edits are correctly classified as generated messages. |
| Concurrent nickname changes keep invalidating the result | Holding the nickname constant stops the loop. | Rejected for this incident: constant nickname reproduces it; production contracts/results consistently target revision one. |
| Opening-alert delivery failure causes orphan recovery messages | Allowing the warning to arrive produces a paired warning/recovery sequence. | Confirmed in the isolated control. |
| Shared cooldown causes lost admin responses | Retrying the same response after expiry reaches Telegram. | Confirmed without changing the gateway or command output. |
| Scheduler discards the failed occurrence | After expiry, a scheduler scan does nothing but explicit publication succeeds. | Confirmed with real publisher, scheduler, repositories, and fake Telegram transport. |

## Documentation and decision tree

Existing ADR 0005 permits one successful publication per occurrence and forbids automatic resend of possibly completed output. `docs/queue-preparation.md` says a preparation problem outside a slot does not trigger unscheduled publication. Neither clearly defines whether a definite no-output rejection should be retried within the same occurrence.

Round one answered on 2026-10-17:

- **Q1: Incident notifications — accepted.** Quiet transient waits, warning after five minutes or when action is required, recovery only after a delivered warning and evidence of recovery.
- **Q2: Late publication — accepted with a five-minute limit.** Retry definitely rejected/no-output publication for at most five minutes after its scheduled time. Ambiguous output retains the existing review requirement.
- **Q3: Admin replies — accepted.** Retain and prioritize safe response delivery after the cooldown, without replaying state-changing commands.
- **Admin edits — new explicit requirement.** Once an admin edits a message in the queue channel, the bot must never edit that message afterward, including when the generated byline itself was left untouched. Investigate all preparation/refresh paths and the relationship to source renewal before implementing.

Round two answered on 2026-10-17; all recommendations accepted:

- **Q4: Admin protection scope — accepted.** An edit freezes the whole logical post, including album members and separate credit, across renewal and nickname changes; an edited raw submission is adopted as shown.
- **Q5: Incident boundaries — accepted.** Repeated waits stay one incident until five uninterrupted minutes without another wait plus a successful relevant Telegram request.
- **Q6: Retry cancellation and deadline — accepted.** Five minutes from the original scheduled time, preserved across restart; pausing or successful manual publication cancels pending scheduled retries, and expired occurrences stay skipped.
- **Q7: Retained reply semantics — accepted.** Replies survive restart; newer dashboard/health/queue requests supersede obsolete views, while distinct action confirmations remain separate.
- **Q8: In-flight edit collision — accepted.** Stop automatic work and request review, without a bot rewrite; accepted admin edits block initiating further edits. An already-initiated Telegram request cannot be revoked; that transport boundary remains explicit.

The refresh revision invariant was implemented together with enqueue revision capture, edit freezing, durable request evidence, and restart reconciliation. Telegram still offers no conditional edit API, so a request already initiated before an admin edit cannot be revoked; an observed collision remains review work rather than triggering a compensating rewrite.

No unresolved product decisions remain. The accepted editorial-protection and bounded-retry decisions are recorded in ADRs 0006 and 0007. The glossary names credit refresh, publication occurrence, admin-edited messages, and frozen posts; storage revisions, notification thresholds, and retry policy do not belong in the glossary.

## External constraints

Telegram advises avoiding more than one message per second to a single chat, permits only limited bursts, and returns 429 when limits are exceeded ([Bots FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)). This published message guidance is not a complete specification of caption-edit limits.

The Bot API's `retry_after` is the required wait before repeating a request following flood control ([ResponseParameters](https://core.telegram.org/bots/api#responseparameters)). It does not identify a safe narrower chat-only scope. Bypassing the shared cooldown for replies would require assumptions the response does not establish. grammY recommends handling flood waits and notes that fixed throttling alone cannot eliminate all limits ([Flood Limits](https://grammy.dev/advanced/flood)).

## Evidence handling

Production evidence came from read-only service status, journal entries, and narrowly selected SQLite operational fields. Credentials, author identities, and post contents were excluded. The database was opened read-only. No live API probes were sent. The deployed SHA matches local code, so the isolated reproductions exercise the incident's implementation.

## Local implementation verification

The corrected regression coverage is in the normal test suite; the three standalone defect probes above were removed. The final local verification passed:

- `bun run check:all` — passed.
- 371 tests and 1,661 assertions passed.
- Application line coverage: 91.39%; function coverage: 93.39%. The configured aggregate and per-file thresholds were unchanged.
- Deployment activation/rollback/path-validation and SQLite backup suites passed.

The implementation adds durable queue edit protection and request receipts, safe five-minute scheduled retries, shared Telegram pacing and incident tracking, and a persistent admin action/reply outbox. Migration 6 conservatively freezes prepared legacy rows whose edit history cannot be proven; stored visible credits remain as-is and automatic nickname refresh stops for those rows.

Remaining platform and rollout limits:

- Telegram provides no conditional edit API. A request already dispatched before an admin edit cannot be revoked; an observed collision stays in review and does not trigger a compensating rewrite.
- The Bot API has no ordinary channel-message deletion update. The queue can learn about source deletion only when a normal operation next encounters that source.
- No live Telegram compatibility probe, staging rollout, or production deployment was performed as part of the local implementation. Those remain separate operator acceptance steps in the deployment and compatibility runbooks.

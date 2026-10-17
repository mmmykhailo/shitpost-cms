# Prepare posts in the queue channel

This page summarizes current behavior. The [reliability decisions](telegram-reliability.md) and [implementation plan](telegram-reliability-implementation-plan.md) are the detailed authority. The older [queue preparation implementation plan](queue-preparation-implementation-plan.md) is a historical design handoff; use it for background only where it agrees with the current reliability documents.

## Current behavior

- Preparation runs after queue ingestion. The configured channel forwarding rule is captured for each new item, and publication transfers the prepared representation without adding a second credit or queue-channel attribution.
- Identifiable-user credits use the configured alias or Telegram display-name fallback. Hidden-sender aliases are keyed by the exact sender name and remain separate from user-ID aliases.
- Any accepted admin edit in the queue channel permanently freezes the whole logical post, including album members and a separate credit. The edited representation is adopted as shown. Later nickname changes, preparation retries, or renewal do not rewrite a frozen post; publication and renewal may carry it unchanged.
- Migration conservatively freezes legacy prepared rows whose edit history cannot be proven. It preserves their stored content and visible credits and disables automatic nickname refresh. Raw legacy items without evidence of preparation or edits are not frozen by that fallback.
- Confirmed intentional member deletion updates the current representation. Missing-message evidence is discovered through normal Telegram operations; ambiguous transfer results and access failures are not treated as deletion.
- Scheduled publication selects the earliest eligible item. A definite no-output rejection may retry only within five minutes of the original occurrence. Ambiguous output requires explicit review and cannot be automatically sent again.
- Telegram flood waits share a durable cooldown and one incident through recovery. Short disruptions stay quiet; a recovery message requires an opening warning that was actually delivered and confirmed recovery evidence.
- Admin actions are durably recorded before background execution. Private replies and prompts are independently queued, survive restart, and do not repeat the action when delivery retries.
- Recovery preserves selected messages as shown unless the admin explicitly chooses **Apply preparation rules**. It does not infer missing author metadata or add another credit.

## Telegram limits

Albums arrive as separate updates and are collected briefly before preparation. One logical post may contain both an album and a separate text credit. Telegram provides no ordinary Bot API update for channel-message deletion, so local state can lag until a normal copy, forward, renewal, or publication attempt reaches the missing source. A bulk-transfer response that omits members without identifying them remains uncertain and requires review.

See the [Telegram compatibility checklist](telegram-compatibility.md) for live Bot API acceptance work. Run local regression checks with `bun run check:all`; the former frozen defect probes were removed after their corrected behavior was covered by tests.

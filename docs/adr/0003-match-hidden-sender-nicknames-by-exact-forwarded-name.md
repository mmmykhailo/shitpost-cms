# Match hidden sender nicknames by exact forwarded name

Telegram forwards from privacy-hidden users expose a sender display name without an account identifier. Use that exact forwarded name as the reusable nickname key for hidden senders, separately from existing user-ID nicknames; this accepts that different people with the same name share a nickname and a changed name no longer matches, in exchange for reusable attribution with the available data. Do not infer links to identifiable accounts or extend nickname support to channel and chat origins.

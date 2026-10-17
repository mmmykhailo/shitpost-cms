# Telegram publishing queue

Posts wait in a Telegram queue channel before publication. A queue item retains its identity while its messages in that channel can be renewed.

## Language

**Queue channel**:
The Telegram channel containing posts waiting for publication.
_Avoid_: Destination channel, publication channel

**Queue item**:
A logical post waiting for publication, identified by a stable number such as `#29`. An album is one queue item even though it contains multiple Telegram messages.
_Avoid_: Telegram message, source generation

**Queue age**:
The total elapsed time since a queue item was first enqueued. Renewal does not reset this age.
_Avoid_: Message age, time since renewal

**Current source**:
The ordered set of Telegram messages currently representing a queue item in the queue channel, including its content and any separate credit. It can contain a single message, an album, or content accompanied by a separate credit.
_Avoid_: Original source, queue item

**Source age**:
The elapsed time since the current source was posted to the queue channel. This age determines when renewal is due.
_Avoid_: Queue age, waiting time

**Renewal**:
Replacement of a queue item's current source with newly posted messages in the same queue channel. The item keeps its identity, publishing position, content, attribution, album grouping, and queue age.
_Avoid_: Requeueing, moving to the end, publishing

**Queue listing**:
An admin view of queue items in publishing order. Each item's number links to its current source when the listing is generated; an album links to its first current message.
_Avoid_: Queue channel, live message link

**Uncertain renewal**:
A renewal whose replacement result cannot be confirmed, including a request that may have succeeded before its response was lost. It requires admin resolution before that item's renewal can proceed safely.
_Avoid_: Failed renewal, safe retry

**Incomplete replacement**:
A bot-created replacement containing fewer messages than the queue item's complete current source. For an album, it is not a valid replacement of the original post; an admin's intentional removal of a member is an edit instead.
_Avoid_: Renewed album, complete source

**Orphaned source**:
A message from a previous source that remains in the queue channel after a complete replacement becomes current. It is a cleanup remnant, rather than another queue item.
_Avoid_: Current source, duplicate queue item

**Hidden sender**:
An original sender whose Telegram forwarding privacy exposes a display name without identifying their account. Different people can appear under the same name, and one person can appear under different names.
_Avoid_: Anonymous account, identified author

**Author nickname**:
A custom name used to credit an original sender. For identifiable senders it belongs to their account; for hidden senders it belongs to the exact forwarded display name, shared by every hidden sender with that name and separate from account nicknames.
_Avoid_: Profile name, username

**Prepared post**:
A queue item's publication form, including its content, attribution, grouping, and intentional admin edits, already visible in the queue channel. It can comprise several messages, including a separate credit when the content cannot carry a caption.
_Avoid_: Raw submission, published post

**Preparation**:
Transformation of a submitted queue item into its prepared post under the applicable attribution and reposting rules.
_Avoid_: Publication, renewal

**Credit refresh**:
An update to a generated author credit on a post the admin has not edited, so that it reflects the author's current nickname.
_Avoid_: Renewal, republication, preparing a new post

**Admin-edited message**:
A queue-channel message deliberately changed by the admin. Any such edit freezes its whole queue item, even when the generated credit is unchanged.
_Avoid_: Bot-generated edit, untouched generated credit

**Frozen post**:
A queue item whose full visible representation is under admin control after an admin edit. Its content, album members, and credits remain as shown through nickname changes, renewal, and publication.
_Avoid_: Paused publication, blocked post, frozen message

**Publication occurrence**:
One scheduled opportunity to publish a post, at a configured UTC time on a particular date.
_Avoid_: Queue item, recurring schedule, publication attempt

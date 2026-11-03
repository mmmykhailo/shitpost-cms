import type { ChatId, CreditIdentity, QueueAuthor, SemanticOrigin } from "../types";

/** Delivery origin and the person credited for submitting a post are independent. */
export const selectCreditIdentity = (origin: SemanticOrigin, author: QueueAuthor | undefined, queueChatId: ChatId, friendlyChannel: boolean): CreditIdentity | undefined => {
  if (origin.kind === "user" || origin.kind === "hidden_user") return origin;
  if (origin.kind === "unknown" || (origin.kind === "channel" && friendlyChannel) || !author) return undefined;
  return author.kind === "user" ? author : { kind: "signature", queueChatId, exactName: author.exactName };
};

export const mergeQueueAuthors = (previous: QueueAuthor | undefined, incoming: QueueAuthor | undefined): { author?: QueueAuthor; conflict: boolean } => {
  if (!previous) return incoming ? { author: incoming, conflict: false } : { conflict: false };
  if (!incoming) return { author: previous, conflict: false };
  if (previous.kind === "user" && incoming.kind === "user") return { author: previous, conflict: previous.userId !== incoming.userId };
  if (previous.kind === "signature" && incoming.kind === "signature") return { author: previous, conflict: previous.exactName !== incoming.exactName };
  const user = previous.kind === "user" ? previous : incoming as Extract<QueueAuthor, { kind: "user" }>;
  const signature = previous.kind === "signature" ? previous : incoming as Extract<QueueAuthor, { kind: "signature" }>;
  return { author: user, conflict: user.displayName !== signature.exactName };
};

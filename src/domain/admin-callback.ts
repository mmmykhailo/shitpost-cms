/** Only read-only views and fresh interaction entry points may bypass opaque tokens. */
const reusableActions: Record<string, string | null> = {
  dashboard: null, queue: "offset", queue_item: "itemId", schedule: null, whitelist: null,
  authors: null, authors_page: "offset", hidden_authors: "offset", hidden_author_select: "hiddenAuthorId",
  hidden_alias_set: "hiddenAuthorId", signature_authors: "offset", signature_author_select: "signatureAuthorId",
  signature_alias_set: "signatureAuthorId", health: null, logs: null, safety: "offset", publish: null,
  slot_add: null, whitelist_add: null, alias_add: null, queue_retry: "itemId", queue_move_end: "itemId",
  queue_move_first: "itemId", queue_delete: "itemId", queue_uncertain: "itemId",
  preparation_uncertain: "itemId", renewal_uncertain: "itemId",
};
export const isReusableAction = (action: string): boolean => Object.hasOwn(reusableActions, action);
export type ResolvedCallback = { action: string; payload: Record<string, unknown>; itemVersion?: number };

export const encodeReusableCallback = (action: string, value: unknown): string | undefined => {
  if (!isReusableAction(action)) return undefined;
  const key = reusableActions[action];
  const payload = value as Record<string, unknown>;
  const arg = key === null ? undefined : payload?.[key!];
  if (arg !== undefined && (!Number.isSafeInteger(arg) || Number(arg) < (key === "offset" ? 0 : 1))) throw new Error("Invalid callback argument");
  const data = `v2:${action}${arg === undefined ? "" : `:${arg}`}`;
  if (new TextEncoder().encode(data).length > 64) throw new Error("Callback data is too long");
  return data;
};

export const decodeReusableCallback = (data: string): ResolvedCallback | undefined => {
  if (new TextEncoder().encode(data).length > 64) return undefined;
  const match = /^v2:([a-z_]+)(?::(0|[1-9]\d*))?$/u.exec(data);
  if (!match || !isReusableAction(match[1]!)) return undefined;
  const action = match[1]!;
  const key = reusableActions[action];
  if (key === null) return match[2] === undefined ? { action, payload: {} } : undefined;
  if (match[2] === undefined) return key === "offset" ? { action, payload: {} } : undefined;
  const arg = Number(match[2]);
  if (!Number.isSafeInteger(arg) || arg < (key === "offset" ? 0 : 1)) return undefined;
  return { action, payload: { [key!]: arg } };
};

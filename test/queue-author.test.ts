import { test, expect } from "bun:test";
import type { Message } from "grammy/types";
import { snapshotFromMessage } from "../src/domain/message";
import { validateCreditIdentity, validateQueueAuthor, validateStoredMessageSnapshot } from "../src/domain/validation";
import { classifyPublicationPlan } from "../src/domain/origin-policy";
import { selectCreditIdentity } from "../src/domain/credit-policy";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createIngestionService } from "../src/services/ingestion";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createLoggerSpy, createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";
import { asChatId, asMessageId, asUserId, type CreditIdentity, type SemanticOrigin } from "../src/types";

const AUTHOR = { kind: "user", userId: asUserId(71), displayName: "Submitter", username: "submitter" } as const;
const CHANNEL = { kind: "channel", chatId: asChatId(-200), title: "Original channel" } as const;
const payload = { message_id: 1, date: 1000, chat: { id: -100, type: "channel", title: "Queue" }, text: "post" };

test("captures profile authors and signature-only authors independently of forward origins", () => {
  const forwarded = { ...payload, forward_origin: { type: "channel", chat: { id: -200, type: "channel", title: "Original" }, message_id: 1, date: 500, author_signature: "Original signature" } };
  const profile = snapshotFromMessage({ ...forwarded, from: { id: 71, is_bot: false, first_name: "Submitter", username: "submitter" }, sender_chat: payload.chat, author_signature: "Queue signature" } as Message);
  expect(profile.origin.kind).toBe("channel");
  expect(profile.queueAuthor).toEqual(AUTHOR);
  expect(validateStoredMessageSnapshot(profile).queueAuthor).toEqual(AUTHOR);
  expect(snapshotFromMessage({ ...forwarded, author_signature: "  Exact Queue Name  " } as Message).queueAuthor).toEqual({ kind: "signature", exactName: "  Exact Queue Name  " });
  expect(snapshotFromMessage(forwarded as Message).queueAuthor).toBeUndefined();
  expect(snapshotFromMessage({ ...payload, from: { id: 1087968824, is_bot: true, first_name: "Anonymous" } } as Message).queueAuthor).toBeUndefined();
  expect(snapshotFromMessage({ ...payload, sender_chat: payload.chat } as Message).queueAuthor).toBeUndefined();
  expect(snapshotFromMessage({ ...payload, author_signature: "   " } as Message).queueAuthor).toBeUndefined();
  expect(() => validateQueueAuthor({ kind: "user", userId: -1, displayName: "fake" })).toThrow();
  expect(() => validateCreditIdentity({ kind: "signature", exactName: " " })).toThrow();
});

test("fallback precedence preserves original-user credits and friendly channels", () => {
  const original = { kind: "user", userId: asUserId(88), displayName: "Original" } as const;
  const hidden = { kind: "hidden_user", senderUserName: "Hidden" } as const;
  const cases: Array<{ origin: SemanticOrigin; friendly?: boolean; expected?: CreditIdentity }> = [
    { origin: original, expected: original }, { origin: hidden, expected: hidden },
    { origin: CHANNEL, friendly: true }, { origin: CHANNEL, expected: AUTHOR },
    { origin: { kind: "absent" }, expected: AUTHOR },
    { origin: { kind: "chat", chatId: asChatId(-300) }, expected: AUTHOR },
    { origin: { kind: "unknown", type: "future" } },
  ];
  for (const c of cases) {
    const identity = selectCreditIdentity(c.origin, AUTHOR, asChatId(-100), c.friendly ?? false);
    expect(identity).toEqual(c.expected);
    const plan = classifyPublicationPlan({ origin: c.origin, contentType: "text", channelIsWhitelisted: c.friendly ?? false, ...(identity ? { creditIdentity: identity, alias: "Alias" } : {}) });
    expect(plan.kind).toBe(c.expected ? "copy_with_inline_byline" : c.friendly ? "forward" : "blocked");
  }
  expect(selectCreditIdentity({ kind: "absent" }, undefined, asChatId(-100), false)).toBeUndefined();
  expect(selectCreditIdentity({ kind: "absent" }, { kind: "signature", exactName: "Signature" }, asChatId(-100), false)).toEqual({ kind: "signature", exactName: "Signature", queueChatId: asChatId(-100) });
});

test("pending post/edit coalescing retains the submitter and albums retain a known author", () => {
  const resource = createTestDatabase();
  try {
    const q = createQueueRepository(resource.database), p = createPolicyRepository(resource.database);
    const pending = createPendingUpdateRepository(resource.database);
    let now = 10000;
    const service = createIngestionService({ queueChannelId: asChatId(-100), queue: q, policy: p, generated: createGeneratedMessageRepository(resource.database), pending, now: () => now, logger: createLoggerSpy().logger });
    service.handleChannelPost({ ...payload, from: { id: 71, is_bot: false, first_name: "Submitter", username: "submitter" } } as Message, 1);
    service.handleEditedChannelPost({ ...payload, text: "edited", edit_date: 1001, from: { id: 72, is_bot: false, first_name: "Editor" } } as Message, 2);
    now += 3000;
    service.finalizePendingUpdates();
    expect(q.findItemById(1)).toMatchObject({ queueAuthor: AUTHOR, creditIdentity: AUTHOR, editorialFreezeReason: "admin_edit" });
    service.observe(snapshotFixture({ messageId: asMessageId(2), origin: { kind: "absent" }, mediaGroupId: "album" }), now);
    service.observe(snapshotFixture({ messageId: asMessageId(3), origin: { kind: "absent" }, queueAuthor: AUTHOR, mediaGroupId: "album" }), now);
    now += 3000;
    service.finalizeAlbums();
    expect(q.findItemById(2)).toMatchObject({ status: "queued", queueAuthor: AUTHOR, creditIdentity: AUTHOR });
    expect(p.listAuthors().some(a => a.userId === AUTHOR.userId)).toBe(true);
    service.observe(snapshotFixture({ messageId: asMessageId(4), origin: { kind: "absent" }, queueAuthor: AUTHOR, mediaGroupId: "conflict" }), now);
    service.observe(snapshotFixture({ messageId: asMessageId(5), origin: { kind: "absent" }, queueAuthor: { ...AUTHOR, userId: asUserId(72) }, mediaGroupId: "conflict" }), now);
    now += 3000;
    service.finalizeAlbums();
    expect(q.findItemById(3)?.status).toBe("needs_review");
  } finally { resource.close(); }
});

test("signature nicknames remain separate by queue and exact text, with persistent revision tracking", () => {
  const r = createTestDatabase();
  try {
    const p = createPolicyRepository(r.database);
    for (const name of ["Name", "name", " Name "]) p.observeAuthor({ kind: "signature", queueChatId: asChatId(-100), exactName: name }, 1000);
    p.observeAuthor({ kind: "signature", queueChatId: asChatId(-101), exactName: "Name" }, 1000);
    p.observeAuthor({ kind: "hidden_user", senderUserName: "Name" }, 1000);
    const author = p.listSignatureAuthors(-100)[0]!;
    p.setSignatureAlias(author.id, "Custom", 42, 1001);
    const identity = { kind: "signature", queueChatId: asChatId(-100), exactName: "Name" } as const;
    expect(p.resolveCreditPolicy(identity)).toMatchObject({ alias: "Custom", revision: 1 });
    expect(p.resolveCreditPolicy({ ...identity, queueChatId: asChatId(-101) }).alias).toBeUndefined();
    expect(p.resolveCreditPolicy({ ...identity, exactName: "name" }).alias).toBeUndefined();
    expect(p.resolveCreditPolicy({ kind: "hidden_user", senderUserName: "Name" }).alias).toBeUndefined();
    expect(p.countSignatureAuthors(-100)).toBe(3);
    expect(p.listSignatureAuthors(-100, 1, 1)).toHaveLength(1);
    expect(() => p.listSignatureAuthors(-100, 0)).toThrow();
    expect(() => p.setSignatureAlias(999, "Missing", 42, 1002)).toThrow();
    p.setSignatureAlias(author.id, "Custom", 42, 1002);
    expect(p.getSignatureAuthor(author.id)?.aliasRevision).toBe(1);
    p.setSignatureAlias(author.id, null, 42, 1003);
    expect(p.resolveCreditPolicy(identity)).toMatchObject({ revision: 2 });
    expect(p.resolveCreditPolicy(identity).alias).toBeUndefined();
  } finally { r.close(); }
});

test("album identity merging prefers consistent real metadata and flags conflicting authors", async () => {
  const { mergeQueueAuthors } = await import("../src/domain/credit-policy");
  const signature = { kind: "signature", exactName: AUTHOR.displayName } as const;
  expect(mergeQueueAuthors(undefined, undefined)).toEqual({ conflict: false });
  expect(mergeQueueAuthors(AUTHOR, undefined)).toEqual({ author: AUTHOR, conflict: false });
  expect(mergeQueueAuthors(undefined, AUTHOR)).toEqual({ author: AUTHOR, conflict: false });
  expect(mergeQueueAuthors(AUTHOR, { ...AUTHOR })).toEqual({ author: AUTHOR, conflict: false });
  expect(mergeQueueAuthors(signature, signature)).toEqual({ author: signature, conflict: false });
  expect(mergeQueueAuthors(signature, { kind: "signature", exactName: "Different" }).conflict).toBe(true);
  expect(mergeQueueAuthors(AUTHOR, signature)).toEqual({ author: AUTHOR, conflict: false });
  expect(mergeQueueAuthors(signature, AUTHOR)).toEqual({ author: AUTHOR, conflict: false });
  expect(mergeQueueAuthors({ kind: "signature", exactName: "Different" }, AUTHOR).conflict).toBe(true);
});

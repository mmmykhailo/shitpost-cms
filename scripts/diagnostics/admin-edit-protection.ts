// Frozen 2026-10-17 investigation probes: assertions confirm observed defects.
// Fake Telegram transport only; synthetic messages; no production access.
import assert from 'node:assert/strict';
import { createTestDatabase, createLoggerSpy } from '../../test/support.ts';
import { createPolicyRepository, createQueueRepository, createGeneratedMessageRepository } from '../../src/db/repositories.ts';
import { createPreparationRepository } from '../../src/db/preparation-repository.ts';
import { createGeneratedEventRepository } from '../../src/db/generated-event-repository.ts';
import { createPreparationService } from '../../src/services/preparation.ts';
import { createIngestionService } from '../../src/services/ingestion.ts';
import { createFakeClock } from '../../src/clock.ts';
import { asChatId, asMessageId, asUserId } from '../../src/types.ts';

async function bodyEdit() {
const resource = createTestDatabase('admin-edit-lock');
const NOW = Date.parse('2026-10-17T08:00:00Z');
try {
  const database = resource.database;
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const events = createGeneratedEventRepository(database);
  const preparation = createPreparationRepository(database);
  const clock = createFakeClock(NOW);
  const logger = createLoggerSpy().logger;
  const origin = { kind: 'user' as const, userId: asUserId(55), displayName: 'Alice Example' };
  const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy, generated, events, logger, now: clock.now });
  const message = (messageId: number, text: string, edited = false) => ({ message_id: messageId, date: NOW / 1000, ...(edited ? { edit_date: clock.now() / 1000 } : {}), chat: { id: -100, type: 'channel', title: 'Queue' }, text });
  ingestion.handleChannelPost({ ...message(100, 'hello'), forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 1);
  const edits: unknown[] = [];
  const gateway = {
    copyMessage: async () => asMessageId(500),
    deleteMessages: async () => {},
    editText: async (request: { messageId: number, text: string }) => { edits.push(request); },
  } as never;
  const service = createPreparationService({ queue, preparation, policy, gateway, queueChannelId: asChatId(-100), bootId: 'repro', clock, logger });
  await service.prepareNext();
  const preparedAttribution = queue.findItemById(1)?.attribution;
  clock.advance(1000);
  const adminEdit = ingestion.handleEditedChannelPost(message(500, 'admin changed body\n\nby Alice Example', true) as never, 2);
  const attributionAfterAdminEdit = queue.findItemById(1)?.attribution;
  const botEditsAtAdminEdit = edits.length;
  policy.setAlias(55, 'Professor Alice', 42, clock.now());
  const refreshOutcome = await service.prepareNext();
  console.log(JSON.stringify({ adminEdit, preparedAttribution, attributionAfterAdminEdit, botEditsAtAdminEdit, botEditsAfterAliasChange: edits.length, refreshOutcome, edits, finalText: queue.getCurrentMembers(1)[0]?.snapshot.text }));
  assert.equal(edits.length, botEditsAtAdminEdit + 1);
  assert.equal(attributionAfterAdminEdit?.ownership, 'bot');
} finally { resource.close(); }

}
await bodyEdit();
console.log("CONFIRMED: bodyEdit");

async function rawEdit() {
const resource = createTestDatabase('admin-edit-lock');
const NOW = Date.parse('2026-10-17T08:00:00Z');
try {
  const database = resource.database;
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const events = createGeneratedEventRepository(database);
  const preparation = createPreparationRepository(database);
  const clock = createFakeClock(NOW);
  const logger = createLoggerSpy().logger;
  const origin = { kind: 'user' as const, userId: asUserId(55), displayName: 'Alice Example' };
  const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy, generated, events, logger, now: clock.now });
  const message = (messageId: number, text: string, edited = false) => ({ message_id: messageId, date: NOW / 1000, ...(edited ? { edit_date: clock.now() / 1000 } : {}), chat: { id: -100, type: 'channel', title: 'Queue' }, text });
  ingestion.handleChannelPost({ ...message(100, 'hello'), forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 1);
  const edits: unknown[] = [];
  const gateway = {
    copyMessage: async () => asMessageId(500),
    deleteMessages: async () => {},
    editText: async (request: { messageId: number, text: string }) => { edits.push(request); },
  } as never;
  const service = createPreparationService({ queue, preparation, policy, gateway, queueChannelId: asChatId(-100), bootId: 'repro', clock, logger });
  clock.advance(1000);
  const adminEdit = ingestion.handleEditedChannelPost({ ...message(100, 'admin raw body', true), forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 2);
  const before = queue.findItemById(1);
  const result = await service.prepareNext();
  const finalText = queue.getCurrentMembers(1)[0]?.snapshot.text;
  console.log(JSON.stringify({ adminEdit, beforeAttribution: before?.attribution, beforeRepresentation: before?.representationKind, result, edits, finalMessageId: queue.getCurrentMembers(1)[0]?.messageId, finalText }));
  assert.equal(finalText, 'admin raw body\n\nby Alice Example');
} finally { resource.close(); }

}
await rawEdit();
console.log("CONFIRMED: rawEdit");

async function staleExpectation() {
const resource = createTestDatabase('admin-edit-lock');
const NOW = Date.parse('2026-10-17T08:00:00Z');
try {
  const database = resource.database;
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const events = createGeneratedEventRepository(database);
  const preparation = createPreparationRepository(database);
  const clock = createFakeClock(NOW);
  const logger = createLoggerSpy().logger;
  const origin = { kind: 'user' as const, userId: asUserId(55), displayName: 'Alice Example' };
  const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy, generated, events, logger, now: clock.now });
  const message = (messageId: number, text: string, edited = false) => ({ message_id: messageId, date: NOW / 1000, ...(edited ? { edit_date: clock.now() / 1000 } : {}), chat: { id: -100, type: 'channel', title: 'Queue' }, text });
  ingestion.handleChannelPost({ ...message(100, 'hello'), forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 1);
  const edits: unknown[] = [];
  let noop = false;
  const gateway = {
    copyMessage: async () => asMessageId(500),
    deleteMessages: async () => {},
    editText: async (request: { messageId: number, text: string }) => { edits.push(request); if (noop) throw { error_code: 400, description: 'Bad Request: message is not modified' }; },
  } as never;
  const service = createPreparationService({ queue, preparation, policy, gateway, queueChannelId: asChatId(-100), bootId: 'repro', clock, logger });
  await service.prepareNext();
  const initialText = 'hello\n\nby Alice Example';
  const initialOwnEdit = ingestion.handleEditedChannelPost(message(500, initialText, true) as never, 2);
  noop = true;
  policy.setAlias(55, 'Alice Example', 42, clock.now());
  const refreshOutcome = await service.prepareNext();
  const pendingAfterNoop = database.raw.query("SELECT state, event_kind, expected_fingerprint FROM queue_generated_events WHERE message_id=500 AND event_kind='edit'").all();
  clock.advance(1000);
  const firstAdminEdit = ingestion.handleEditedChannelPost(message(500, 'admin body and admin credit', true) as never, 3);
  clock.advance(1000);
  const secondAdminEdit = ingestion.handleEditedChannelPost(message(500, initialText, true) as never, 4);
  const storedText = queue.getCurrentMembers(1)[0]?.snapshot.text;
  console.log(JSON.stringify({ initialOwnEdit, refreshOutcome, pendingAfterNoop, firstAdminEdit, secondAdminEdit, expectedActualTelegramText: initialText, storedText, edits }));
  assert.equal(storedText, 'admin body and admin credit');
  assert.equal(secondAdminEdit.ignoredReason, 'generated_message');
} finally { resource.close(); }

}
await staleExpectation();
console.log("CONFIRMED: staleExpectation");

async function inFlightEdit() {
const resource = createTestDatabase('admin-edit-lock');
const NOW = Date.parse('2026-10-17T08:00:00Z');
try {
  const database = resource.database;
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const events = createGeneratedEventRepository(database);
  const preparation = createPreparationRepository(database);
  const clock = createFakeClock(NOW);
  const logger = createLoggerSpy().logger;
  const origin = { kind: 'user' as const, userId: asUserId(55), displayName: 'Alice Example' };
  const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy, generated, events, logger, now: clock.now });
  const message = (messageId: number, text: string, edited = false) => ({ message_id: messageId, date: NOW / 1000, ...(edited ? { edit_date: clock.now() / 1000 } : {}), chat: { id: -100, type: 'channel', title: 'Queue' }, text });
  ingestion.handleChannelPost({ ...message(100, 'hello'), forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 1);
  const edits: unknown[] = [];
  let releaseQueuedEdit: (() => void) | undefined;
  let announceQueuedEdit: (() => void) | undefined;
  const queuedEdit = new Promise<void>((resolve) => { announceQueuedEdit = resolve; });
  let holdRefresh = false;
  const gateway = {
    copyMessage: async () => asMessageId(500),
    deleteMessages: async () => {},
    editText: async (request: { messageId: number, text: string }) => {
      if (holdRefresh) { announceQueuedEdit!(); await new Promise<void>((resolve) => { releaseQueuedEdit = resolve; }); }
      edits.push(request);
    },
  } as never;
  const service = createPreparationService({ queue, preparation, policy, gateway, queueChannelId: asChatId(-100), bootId: 'repro', clock, logger });
  await service.prepareNext();
  policy.setAlias(55, 'Professor Alice', 42, clock.now());
  holdRefresh = true;
  const refreshing = service.prepareNext();
  await queuedEdit;
  clock.advance(1000);
  const adminEdit = ingestion.handleEditedChannelPost(message(500, 'admin exact body and credit', true) as never, 2);
  const acceptedText = queue.getCurrentMembers(1)[0]?.snapshot.text;
  releaseQueuedEdit!();
  const outcome = await refreshing;
  console.log(JSON.stringify({ adminEdit, acceptedText, outcome, edits, finalText: queue.getCurrentMembers(1)[0]?.snapshot.text, finalStatus: queue.findItemById(1)?.preparationState }));
  assert.equal(edits.length, 2);
  assert.equal(outcome.kind, 'uncertain');
  assert.equal(queue.getCurrentMembers(1)[0]?.snapshot.text, acceptedText);
} finally { resource.close(); }

}
await inFlightEdit();
console.log("CONFIRMED: inFlightEdit");

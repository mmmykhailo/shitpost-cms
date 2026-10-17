// Frozen investigation probes for the 2026-10-17 refresh storm, including causal controls.
// All messages and author identities below are synthetic. No network or production access.
import assert from 'node:assert/strict';
import { createTestDatabase, createLoggerSpy } from '../../test/support.ts';
import { createPolicyRepository, createQueueRepository, createGeneratedMessageRepository } from '../../src/db/repositories.ts';
import { createPreparationRepository } from '../../src/db/preparation-repository.ts';
import { createGeneratedEventRepository } from '../../src/db/generated-event-repository.ts';
import { createPreparationService } from '../../src/services/preparation.ts';
import { createIngestionService } from '../../src/services/ingestion.ts';
import { createFakeClock } from '../../src/clock.ts';
import { asChatId, asMessageId, asUserId } from '../../src/types.ts';
const NOW = Date.parse('2026-10-17T08:00:00Z');
for (const variant of [
  { name: 'preexisting alias, unsynchronized wanted', alias: true, synchronize: false, echoEdits: false, expectedReady: false },
  { name: 'preexisting alias, own edit echoes', alias: true, synchronize: false, echoEdits: true, expectedReady: false },
  { name: 'no alias before enqueue', alias: false, synchronize: false, echoEdits: false, expectedReady: true },
  { name: 'preexisting alias, synchronized wanted', alias: true, synchronize: true, echoEdits: false, expectedReady: true },
]) {
  const { echoEdits } = variant;
  const resource = createTestDatabase('refresh-loop-repro');
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
    policy.observeAuthor(origin, NOW);
    if (variant.alias) policy.setAlias(55, 'Alice', 42, NOW);
    const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy, generated, events, logger, now: clock.now });
    ingestion.handleChannelPost({ message_id: 100, date: NOW / 1000, chat: { id: -100, type: 'channel', title: 'Queue' }, text: 'hello', forward_origin: { type: 'user', date: NOW / 1000, sender_user: { id: 55, is_bot: false, first_name: 'Alice', last_name: 'Example' } } } as never, 1);
    if (variant.synchronize) database.raw.query('UPDATE queue_items SET nickname_revision_wanted = 1 WHERE id = 1').run();
    const edits: string[] = [];
    const echoes: unknown[] = [];
    let updateId = 2;
    const gateway = {
      copyMessage: async () => asMessageId(500),
      deleteMessages: async () => {},
      editText: async ({ messageId, text }: { messageId: number, text: string }) => {
        edits.push(text);
        if (echoEdits) echoes.push(ingestion.handleEditedChannelPost({ message_id: messageId, date: NOW / 1000, edit_date: NOW / 1000, chat: { id: -100, type: 'channel', title: 'Queue' }, text } as never, updateId++));
      },
    } as never;
    const service = createPreparationService({ queue, preparation, policy, gateway, queueChannelId: asChatId(-100), bootId: 'repro', clock, logger });
    const snapshots: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await service.prepareNext();
      snapshots.push({ outcome, row: database.raw.query('SELECT preparation_state, nickname_revision_wanted, nickname_revision_applied, content_version FROM queue_items WHERE id = 1').get() });
    }
    console.log(JSON.stringify({ variant: variant.name, echoEdits, aliasRevision: policy.aliasRevisionForOrigin(origin), edits, echoes, snapshots }));
    assert.equal(queue.findItemById(1)?.preparationState, variant.expectedReady ? 'ready' : 'refresh_pending');
    assert.equal(edits.length, variant.expectedReady ? 1 : 3);
    const kinds = snapshots.map((value: any) => value.outcome.kind);
    assert.deepEqual(kinds, variant.expectedReady ? ['prepared', 'empty', 'empty'] : ['prepared', 'prepared', 'prepared']);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally { resource.close(); }
}

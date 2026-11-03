import { expect, test } from "bun:test";
import { decodeReusableCallback, encodeReusableCallback } from "../src/domain/admin-callback";
import { createAdminUpdateRepository } from "../src/db/admin-update-repository";
import { createAdminResponseRepository } from "../src/db/admin-response-repository";
import { createAdminRepository } from "../src/db/admin-repository";
import { createDatabase } from "../src/db/database";
import { createTestDatabase } from "./support";

test("stateless callbacks cannot execute mutations or accept malformed arguments", () => {
  expect(encodeReusableCallback("queue", { offset: 10 })).toBe("v2:queue:10");
  expect(decodeReusableCallback("v2:queue:10")).toEqual({ action: "queue", payload: { offset: 10 } });
  for (const data of ["v2:queue_delete_confirm:1", "v2:queue:-1", "v2:queue:1e2", "v2:queue:01", "v2:queue:9007199254740992", "v2:dashboard:1", "v2:queue_item", "v2:queue:0:extra"]) expect(decodeReusableCallback(data)).toBeUndefined();
});

test("callbacks and active prompts survive restart and transaction rollback", () => {
  const resource = createTestDatabase();
  let database = resource.database;
  try {
    let admin = createAdminRepository(database);
    const token = admin.createCallbackToken(42, "schedule_pause", {}, 1000);
    const legacy = admin.createCallbackToken(42, "queue", {}, 1000, undefined, 1);
    admin.consumeCallbackToken(42, legacy, 1000);
    admin.setPrompt(42, "alias_add", {}, 123, 1000);
    database.close();
    database = createDatabase(resource.path);
    admin = createAdminRepository(database);
    admin.purgeExpiredTokensAndPrompts(9 * 86_400_000);
    expect(admin.getPrompt(42, 9 * 86_400_000)?.expectedReplyToMessageId).toBe(123);
    expect(admin.consumeCallbackToken(42, legacy, 9 * 86_400_000)?.action).toBe("queue");
    expect(() => database.transaction(() => {
      expect(admin.consumeCallbackToken(42, token, 9 * 86_400_000)?.action).toBe("schedule_pause");
      throw new Error("interrupted");
    })).toThrow("interrupted");
    expect(admin.consumeCallbackToken(42, token, 9 * 86_400_000)?.action).toBe("schedule_pause");
    expect(admin.consumeCallbackToken(42, token, 9 * 86_400_000)).toBeUndefined();
  } finally { database.close(); resource.close(); }
});


test("retention keeps valid old confirmations and removes stale or definitely undelivered tokens", () => {
  const resource = createTestDatabase();
  try {
    const admin = createAdminRepository(resource.database);
    const responses = createAdminResponseRepository(resource.database);
    const tokens: string[] = [];
    for (let id = 1; id <= 3; id++) {
      createAdminUpdateRepository(resource.database).begin({ updateId: id, adminId: 42, actionKind: "callback", actionPayload: {}, bootId: "test", now: 1000 });
      const row = responses.enqueue({ adminChatId: 42, updateId: id, kind: "confirmation", descriptor: { version: 1, text: "Confirm" }, now: 1000 }).record;
      const payload = { minuteOfDay: id, actionState: admin.actionState("slot_remove", { minuteOfDay: id }) };
      tokens.push(admin.createCallbackToken(42, "slot_remove", payload, 1000, undefined, 0, row.id));
      if (id === 3) responses.cancel(row.id, 1001);
      else {
        const claim = responses.claimDue(1000, "test")!;
        responses.markSent(row.id, claim.claimToken!, 100 + id, 1000);
      }
    }
    resource.database.raw.query("INSERT INTO admin_resource_revisions(resource, revision) VALUES ('schedule_slots:1', 1)").run();
    expect(responses.purgeTerminal(100_000_000_000)).toBe(0);
    const now = 100 * 86_400_000;
    expect(admin.purgeExpiredTokensAndPrompts(now).tokens).toBe(2);
    expect(admin.consumeCallbackToken(42, tokens[0]!, now)).toBeUndefined();
    expect(admin.consumeCallbackToken(42, tokens[1]!, now)?.action).toBe("slot_remove");
    expect(admin.consumeCallbackToken(42, tokens[2]!, now)).toBeUndefined();
    expect(responses.purgeTerminal(now)).toBe(3);
    const corrupt = admin.createCallbackToken(42, "slot_remove", {}, now);
    resource.database.raw.query("UPDATE callback_tokens SET payload_json = '{broken' WHERE token = ?").run(corrupt);
    expect(admin.consumeCallbackToken(42, corrupt, now)).toBeUndefined();
    admin.setPrompt(42, "alias_add", {}, 1, now);
    resource.database.raw.query("UPDATE admin_prompts SET state_json = '{broken'").run();
    expect(admin.getPrompt(42, now)).toBeUndefined();
  } finally { resource.close(); }
});

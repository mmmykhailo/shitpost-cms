import { expect, test } from "bun:test";
import { decodeReusableCallback, encodeReusableCallback } from "../src/domain/admin-callback";
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

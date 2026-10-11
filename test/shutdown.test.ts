import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";
import { createDatabase } from "../src/db/database";
import { createAlertRepository } from "../src/db/alert-repository";
import { createOperationTracker, createTaskSupervisor } from "../src/services/task-supervisor";
import { createAlertService } from "../src/services/alerts";
import { asChatId, asMessageId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";

describe("shutdown lifecycle", () => {
  test("waits for polling middleware and operations before closing workers", async () => {
    const tracker = createOperationTracker();
    const supervisor = createTaskSupervisor({ logger: createLogger("error") });
    const events: string[] = [];
    let finishMiddleware!: () => void;
    const middlewareFinished = new Promise<void>((resolve) => { finishMiddleware = resolve; });
    const finishOperation = tracker.begin("publish-1");

    supervisor.start("worker", async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      events.push("worker-drained");
    });
    tracker.stopAccepting();
    supervisor.requestStop();
    events.push("polling-stopped");
    const middlewareDrain = middlewareFinished.then(() => { events.push("middleware-drained"); });
    const operationDrain = tracker.waitForEmpty(500);
    expect(await Promise.race([operationDrain, Promise.resolve(false)])).toBe(false);

    finishMiddleware();
    finishOperation();
    await middlewareDrain;
    expect(await operationDrain).toBe(true);
    expect(await supervisor.stopAndDrain(500)).toBe(true);

    events.push("database-closed");
    expect(events[0]).toBe("polling-stopped");
    expect(events.at(-1)).toBe("database-closed");
    expect(events.indexOf("middleware-drained")).toBeLessThan(events.indexOf("database-closed"));
    expect(events.indexOf("worker-drained")).toBeLessThan(events.indexOf("database-closed"));
  });

  test("keeps the database open until a lease-loss alert finishes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-shutdown-alert-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    const alert = createAlertRepository(database);
    let finishDelivery!: () => void;
    const deliveryFinished = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const gateway = {
      sendAdminMessage: async () => {
        await deliveryFinished;
        return asMessageId(1);
      },
    } as unknown as TelegramGateway;
    const alerts = createAlertService({ alert, gateway, adminChatId: asChatId(99), logger: createLogger("error") });
    const supervisor = createTaskSupervisor({ logger: createLogger("error") });

    try {
      supervisor.start("lease_heartbeat", async () => {
        // This models the lease-loss branch: stop the runtime first, then keep the
        // supervised task alive while the alert completes.
        supervisor.requestStop();
        await alerts.raise("runtime_lease", "immediate", "Lease lost", 1_000);
      });

      const drain = supervisor.stopAndDrain(500);
      expect(await Promise.race([drain.then(() => "drained"), Promise.resolve("pending")])).toBe("pending");
      expect(alert.find("runtime_lease")?.lastSentAt).toBeUndefined();

      finishDelivery();
      expect(await drain).toBe(true);
      expect(alert.find("runtime_lease")?.lastSentAt).toBe(1_000);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createTestDatabase, createControlledClock } from "./support";
import type { TestDatabase } from "./support";

const resources: TestDatabase[] = [];

afterEach(() => {
  while (resources.length) resources.pop()!.close();
});

const open = (): TestDatabase => {
  const fixture = createTestDatabase("queuebot-database-");
  resources.push(fixture);
  fixture.database.raw.exec("CREATE TABLE tx_probe (value TEXT PRIMARY KEY)");
  return fixture;
};

describe("synchronous database transactions", () => {
  test("commits nested savepoints with the outer transaction", () => {
    const { database, path } = open();
    database.transaction(() => {
      database.raw.query("INSERT INTO tx_probe VALUES ('outer-before')").run();
      database.transaction(() => database.raw.query("INSERT INTO tx_probe VALUES ('inner')").run());
      database.raw.query("INSERT INTO tx_probe VALUES ('outer-after')").run();
    });
    expect(database.raw.query("SELECT value FROM tx_probe ORDER BY value").all()).toEqual([
      { value: "inner" },
      { value: "outer-after" },
      { value: "outer-before" },
    ]);
    expect(database.path).toBe(path);
  });

  test("rolls back only a failed inner savepoint when the outer callback catches it", () => {
    const { database } = open();
    database.transaction(() => {
      database.raw.query("INSERT INTO tx_probe VALUES ('kept-before')").run();
      try {
        database.transaction(() => {
          database.raw.query("INSERT INTO tx_probe VALUES ('discarded')").run();
          throw new Error("inner failure");
        });
      } catch (error) {
        expect((error as Error).message).toBe("inner failure");
      }
      database.raw.query("INSERT INTO tx_probe VALUES ('kept-after')").run();
    });
    expect(database.raw.query("SELECT value FROM tx_probe ORDER BY value").all()).toEqual([
      { value: "kept-after" },
      { value: "kept-before" },
    ]);
  });

  test("rolls back successful inner savepoints when the outer callback fails", () => {
    const { database } = open();
    expect(() => database.transaction(() => {
      database.raw.query("INSERT INTO tx_probe VALUES ('outer')").run();
      database.transaction(() => database.raw.query("INSERT INTO tx_probe VALUES ('inner')").run());
      throw new Error("outer failure");
    })).toThrow("outer failure");
    expect(database.raw.query("SELECT value FROM tx_probe").all()).toEqual([]);
    database.transaction(() => database.raw.query("INSERT INTO tx_probe VALUES ('after-rollback')").run());
    expect(database.raw.query("SELECT value FROM tx_probe").get()).toEqual({ value: "after-rollback" });
  });

  test("rejects thenables and rolls back their synchronous writes", async () => {
    const { database } = open();
    expect(() => database.transaction((async () => {
      database.raw.query("INSERT INTO tx_probe VALUES ('async')").run();
    }) as unknown as () => never)).toThrow("must finish synchronously");
    await Promise.resolve();
    expect(database.raw.query("SELECT value FROM tx_probe").all()).toEqual([]);
    database.transaction(() => database.raw.query("INSERT INTO tx_probe VALUES ('after-async-rejection')").run());
    expect(database.raw.query("SELECT value FROM tx_probe").get()).toEqual({ value: "after-async-rejection" });
  });
});

describe("controlled test clock", () => {
  test("resolves only due sleeps and flushes reactions without advancing time", async () => {
    const clock = createControlledClock(1_000);
    let early = false;
    let due = false;
    void clock.sleep(20).then(() => { early = true; });
    void clock.sleep(50).then(() => { due = true; });
    clock.advance(20);
    await clock.flush();
    expect(early).toBe(true);
    expect(due).toBe(false);
    expect(clock.now()).toBe(1_020);
    expect(clock.pendingSleeps()).toEqual([30]);
    clock.advance(30);
    await clock.flush();
    expect(due).toBe(true);
    expect(clock.pendingSleeps()).toEqual([]);
  });
});

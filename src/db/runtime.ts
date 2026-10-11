import type { AppDatabase } from "./database";

export type RuntimeLease = ReturnType<typeof createRuntimeLease>;

export const createRuntimeLease = (database: AppDatabase, owner: string, clock: { now(): number }, leaseMs = 60_000) => {
  const acquire = (name = "process"): boolean => {
    const now = clock.now();
    const result = database.raw.query(`INSERT INTO runtime_leases (name, owner, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = CASE WHEN runtime_leases.owner = excluded.owner OR runtime_leases.expires_at <= ? THEN excluded.acquired_at ELSE runtime_leases.acquired_at END,
      heartbeat_at = CASE WHEN runtime_leases.owner = excluded.owner OR runtime_leases.expires_at <= ? THEN excluded.heartbeat_at ELSE runtime_leases.heartbeat_at END,
      expires_at = CASE WHEN runtime_leases.owner = excluded.owner OR runtime_leases.expires_at <= ? THEN excluded.expires_at ELSE runtime_leases.expires_at END
      WHERE runtime_leases.owner = excluded.owner OR runtime_leases.expires_at <= ?`).run(name, owner, now, now, now + leaseMs, now, now, now, now);
    return Number(result.changes) === 1;
  };

  const heartbeat = (name = "process"): boolean => {
    const now = clock.now();
    const result = database.raw.query("UPDATE runtime_leases SET heartbeat_at = ?, expires_at = ? WHERE name = ? AND owner = ? AND expires_at > ?").run(now, now + leaseMs, name, owner, now);
    return Number(result.changes) === 1;
  };

  const release = (name = "process"): void => { database.raw.query("DELETE FROM runtime_leases WHERE name = ? AND owner = ?").run(name, owner); };
  const owns = (name = "process"): boolean => Boolean(database.raw.query("SELECT 1 AS value FROM runtime_leases WHERE name = ? AND owner = ? AND expires_at > ?").get(name, owner, clock.now()));
  return { acquire, heartbeat, release, owns };
};

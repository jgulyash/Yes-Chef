import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate, MIGRATIONS } from "../src/db.js";

describe("versioned migrations", () => {
  it("applies every migration to a fresh database and records each version", () => {
    const db = new DatabaseSync(":memory:");
    const applied = migrate(db);
    expect(applied).toBe(MIGRATIONS.length);

    const rows = db
      .prepare(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all() as { version: number; name: string }[];
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(rows[0].name).toBe("stage-1 baseline schema");
  });

  it("is idempotent — a second run applies nothing", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(migrate(db)).toBe(0);
    const count = db.prepare(`SELECT COUNT(*) c FROM schema_migrations`).get() as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
  });

  it("baseline creates the Stage-1 tables", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((t) => t.name);
    for (const t of ["household", "food_item", "inventory", "alias", "event", "unmatched_mention", "shortfall_feedback"]) {
      expect(tables).toContain(t);
    }
  });

  it("versions are unique and ordered", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  // v8 rebuilds the event table on databases that already hold real history — the
  // exact shape of the NAS upgrade. Populate a v1-7 database, then let migrate()
  // apply only v8, and prove nothing is lost and the backfill lifts P1 narration rows.
  it("v8 upgrades a populated v7 database: rows kept, narration backfilled", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const m of MIGRATIONS.filter((m) => m.version <= 7)) m.up(db);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((m) => m.version <= 7)) {
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(m.version, m.name, "2026-07-01T00:00:00Z");
    }

    db.prepare(`INSERT INTO household (id, name) VALUES ('hh', 'test')`).run();
    db.prepare(`INSERT INTO food_item (id, household_id, name, zone, is_discrete, par, reorder_point) VALUES ('fi', 'hh', 'Eggs', 'refrigerated', 1, 12, 4)`).run();
    const insEv = db.prepare(`INSERT INTO event (id, ts, household_id, food_item_id, delta, source, meta) VALUES (?, ?, 'hh', 'fi', 0, ?, ?)`);
    insEv.run("e1", "2026-07-01T00:00:00Z", "manual", null);
    insEv.run("e2", "2026-07-02T00:00:00Z", "quickadd", JSON.stringify({ via: "quickadd" }));
    insEv.run("e3", "2026-07-03T00:00:00Z", "quickadd", JSON.stringify({ via: "narration", capture_id: "c1", utterance: "out of eggs" }));

    expect(migrate(db)).toBe(1); // exactly v8 pending

    const rows = db.prepare(`SELECT id, source FROM event ORDER BY id`).all() as { id: string; source: string }[];
    expect(rows).toEqual([
      { id: "e1", source: "manual" },
      { id: "e2", source: "quickadd" }, // plain quickadd untouched
      { id: "e3", source: "narration" }, // P1 meta-tagged row lifted to the real source
    ]);
    // the rebuilt CHECK accepts narration and still rejects unknown sources
    insEv.run("e4", "2026-07-04T00:00:00Z", "narration", null);
    expect(() => insEv.run("e5", "2026-07-05T00:00:00Z", "bogus", null)).toThrow();
    // the index came back with the rebuild
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_event_household'`).get();
    expect(idx).toBeTruthy();
  });

  it("v8 is re-run safe (noTx contract)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    db.prepare(`INSERT INTO household (id, name) VALUES ('hh', 'test')`).run();
    db.prepare(`INSERT INTO food_item (id, household_id, name, zone, is_discrete, par, reorder_point) VALUES ('fi', 'hh', 'Eggs', 'refrigerated', 1, 12, 4)`).run();
    db.prepare(`INSERT INTO event (id, ts, household_id, food_item_id, delta, source, meta) VALUES ('e1', '2026-07-01T00:00:00Z', 'hh', 'fi', 0, 'narration', null)`).run();
    const v8 = MIGRATIONS.find((m) => m.version === 8)!;
    expect(() => v8.up(db)).not.toThrow(); // replaying the rebuild loses nothing
    const count = db.prepare(`SELECT COUNT(*) c FROM event`).get() as { c: number };
    expect(count.c).toBe(1);
  });
});

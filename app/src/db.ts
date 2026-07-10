import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { nowIso } from "./util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// One SQLite file at the app root, via Node's built-in `node:sqlite` (no native build).
// Override with YESCHEF_DB (the demo/tests use this to run against a throwaway file).
// The DB path is config, never hardcoded logic.
export const DB_PATH =
  process.env.YESCHEF_DB ?? resolve(__dirname, "..", "yeschef.db");

export type DB = DatabaseSync;

// ⚠️ FROZEN as migration v1's baseline. Do NOT edit SCHEMA to change the schema —
// databases that already ran v1 will never see your edit, and fresh databases will,
// so the two diverge (a later ALTER then crashes fresh DBs with 'duplicate column').
// Every schema change is a NEW entry in MIGRATIONS below. No exceptions.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS household (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_item (
  id               TEXT PRIMARY KEY,
  household_id     TEXT NOT NULL REFERENCES household(id),
  name             TEXT NOT NULL,
  zone             TEXT NOT NULL CHECK (zone IN ('frozen','refrigerated','counter','pantry')),
  is_discrete      INTEGER NOT NULL CHECK (is_discrete IN (0,1)),
  par              REAL NOT NULL,
  reorder_point    REAL NOT NULL,
  consumption_rate REAL,
  UNIQUE (household_id, name)
);

CREATE TABLE IF NOT EXISTS inventory (
  household_id  TEXT NOT NULL REFERENCES household(id),
  food_item_id  TEXT NOT NULL REFERENCES food_item(id),
  bucket        TEXT CHECK (bucket IN ('out','low','half','full')),
  count         INTEGER,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (household_id, food_item_id)
);

CREATE TABLE IF NOT EXISTS alias (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES household(id),
  surface_form TEXT NOT NULL,
  food_item_id TEXT NOT NULL REFERENCES food_item(id),
  source_type  TEXT NOT NULL DEFAULT 'any',
  origin       TEXT NOT NULL DEFAULT 'seeded',
  UNIQUE (household_id, surface_form, source_type)
);

CREATE TABLE IF NOT EXISTS event (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES household(id),
  food_item_id TEXT NOT NULL REFERENCES food_item(id),
  delta        INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('receipt','cook','quickadd','predicted','manual')),
  meta         TEXT
);

CREATE TABLE IF NOT EXISTS unmatched_mention (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES household(id),
  raw_text     TEXT NOT NULL,
  normalized   TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','ignored')),
  context      TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shortfall_feedback (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES household(id),
  food_item_id TEXT NOT NULL REFERENCES food_item(id),
  predicted    INTEGER NOT NULL CHECK (predicted IN (0,1)),
  verdict      TEXT NOT NULL CHECK (verdict IN ('confirmed_needed','false_positive','missed_runout'))
);

CREATE INDEX IF NOT EXISTS idx_event_household ON event(household_id, ts);
CREATE INDEX IF NOT EXISTS idx_alias_lookup ON alias(household_id, surface_form);
`;

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  _db = db;
  return db;
}

// --- Versioned migrations -------------------------------------------------------
// Every schema change from here on is a new entry in MIGRATIONS — never edit an old
// one. migrate() applies whatever a given database hasn't seen yet, each inside its
// own transaction, and records it in schema_migrations. Baseline v1 is the Stage-1
// schema above; it's all CREATE ... IF NOT EXISTS, so adopting the mechanism on an
// already-populated database (like a live deployment) is a safe no-op.
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
  // noTx: the migration manages its own BEGIN/COMMIT — required when it must toggle
  // PRAGMA foreign_keys (illegal inside a transaction), e.g. table rebuilds.
  // CONTRACT: a noTx up() MUST be safe to re-run. Its version is recorded AFTER it
  // returns, outside its internal transaction, so a crash in that window replays the
  // migration on next boot. v3's rebuild replays cleanly; any future noTx migration
  // must too (no bare CREATE TABLE without IF NOT EXISTS, etc.).
  noTx?: boolean;
}

// Append-only, ascending versions (enforced by migrations.test.ts). SCHEMA above is
// v1's frozen baseline — new schema changes get a new entry here, never a SCHEMA edit.
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "stage-1 baseline schema", up: (db) => db.exec(SCHEMA) },

  // v2 — stores/vendors, user-managed (UX-REDESIGN §6). Must exist before v3's FK.
  {
    version: 2,
    name: "store table",
    up: (db) =>
      db.exec(`CREATE TABLE store (
        id           TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES household(id),
        name         TEXT NOT NULL,
        kind         TEXT CHECK (kind IN ('grocery','warehouse','online','other')),
        order_method TEXT CHECK (order_method IN ('in_store','pickup','delivery')),
        url          TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        UNIQUE (household_id, name)
      )`),
  },

  // v3 — food_item rebuild: deep_freezer joins the zone CHECK (SQLite can't ALTER a
  // CHECK, so: new table -> copy -> drop -> rename), plus the nullable store/detail
  // columns (UX-REDESIGN §6/§8). Self-managed transaction: PRAGMA foreign_keys can't
  // change inside one, and the drop/rename needs it OFF.
  {
    version: 3,
    name: "food_item rebuild: deep_freezer zone + store/detail columns",
    noTx: true,
    up: (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN");
      try {
        db.exec(`CREATE TABLE food_item_new (
          id               TEXT PRIMARY KEY,
          household_id     TEXT NOT NULL REFERENCES household(id),
          name             TEXT NOT NULL,
          zone             TEXT NOT NULL CHECK (zone IN ('frozen','deep_freezer','refrigerated','counter','pantry')),
          is_discrete      INTEGER NOT NULL CHECK (is_discrete IN (0,1)),
          par              REAL NOT NULL,
          reorder_point    REAL NOT NULL,
          consumption_rate REAL,
          store_id         TEXT REFERENCES store(id),
          brand            TEXT,
          order_url        TEXT,
          package_size     TEXT,
          UNIQUE (household_id, name)
        )`);
        db.exec(`INSERT INTO food_item_new
            (id, household_id, name, zone, is_discrete, par, reorder_point, consumption_rate)
          SELECT id, household_id, name, zone, is_discrete, par, reorder_point, consumption_rate
          FROM food_item`);
        db.exec("DROP TABLE food_item");
        db.exec("ALTER TABLE food_item_new RENAME TO food_item");
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) {
          throw new Error(`food_item rebuild broke ${violations.length} foreign key reference(s)`);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    },
  },

  // v4 — recipes + ingredient links (UX-REDESIGN §5.3/§9).
  {
    version: 4,
    name: "recipe + recipe_ingredient tables",
    up: (db) =>
      db.exec(`CREATE TABLE recipe (
        id           TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES household(id),
        name         TEXT NOT NULL,
        source_url   TEXT,
        notes        TEXT,
        created_at   TEXT NOT NULL,
        UNIQUE (household_id, name)
      );
      CREATE TABLE recipe_ingredient (
        recipe_id    TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
        food_item_id TEXT NOT NULL REFERENCES food_item(id),
        qty          REAL,
        unit         TEXT,
        optional     INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
        PRIMARY KEY (recipe_id, food_item_id)
      )`),
  },

  // v5 — items can be removed from the kitchen without losing history: events,
  // learned aliases, and recipe links all reference food_item, so removal is a
  // visibility flag, never a row delete. (UI wording: "Remove".)
  {
    version: 5,
    name: "food_item active flag (soft remove)",
    up: (db) =>
      db.exec(
        `ALTER TABLE food_item ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))`
      ),
  },

  // v6 — recorded kitchen-pass videos await the future vision/narration pipeline.
  {
    version: 6,
    name: "media_capture table",
    up: (db) =>
      db.exec(`CREATE TABLE media_capture (
        id           TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES household(id),
        path         TEXT NOT NULL,
        filename     TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        captured_at  TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video')),
        status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','processed','failed')),
        note         TEXT
      )`),
  },

  // v7 — narration pipeline P1: a transcript per capture + one draft row per proposed
  // change extracted from it (reviewed by a human, then applied — never auto-applied).
  {
    version: 7,
    name: "narration transcript + capture_draft",
    up: (db) =>
      db.exec(`
        ALTER TABLE media_capture ADD COLUMN transcript TEXT;
        CREATE TABLE capture_draft (
          id           TEXT PRIMARY KEY,
          capture_id   TEXT NOT NULL REFERENCES media_capture(id) ON DELETE CASCADE,
          household_id TEXT NOT NULL REFERENCES household(id),
          utterance    TEXT NOT NULL,
          noun         TEXT NOT NULL,
          food_item_id TEXT REFERENCES food_item(id),
          proposed     TEXT NOT NULL,
          confidence   REAL,
          status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed'))
        );
      `),
  },

  // v8 — narration becomes a first-class event source (P2). SQLite can't ALTER a
  // CHECK, so: rebuild (v3's pattern). P1 tagged narration applies as
  // source='quickadd' + meta.via='narration'; the backfill lifts those to the real
  // source so metrics never split one behavior across two encodings.
  {
    version: 8,
    name: "event rebuild: narration source",
    noTx: true,
    up: (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN");
      try {
        db.exec(`CREATE TABLE event_new (
          id           TEXT PRIMARY KEY,
          ts           TEXT NOT NULL,
          household_id TEXT NOT NULL REFERENCES household(id),
          food_item_id TEXT NOT NULL REFERENCES food_item(id),
          delta        INTEGER,
          source       TEXT NOT NULL CHECK (source IN ('receipt','cook','quickadd','predicted','manual','narration')),
          meta         TEXT
        )`);
        db.exec(`INSERT INTO event_new (id, ts, household_id, food_item_id, delta, source, meta)
          SELECT id, ts, household_id, food_item_id, delta, source, meta FROM event`);
        db.exec("DROP TABLE event");
        db.exec("ALTER TABLE event_new RENAME TO event");
        db.exec("CREATE INDEX IF NOT EXISTS idx_event_household ON event(household_id, ts)");
        db.exec(`UPDATE event SET source = 'narration'
          WHERE source = 'quickadd' AND meta LIKE '%"via":"narration"%'`);
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) {
          throw new Error(`event rebuild broke ${violations.length} foreign key reference(s)`);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    },
  },
];

function appliedVersions(db: DatabaseSync): Set<number> {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const rows = db.prepare(`SELECT version FROM schema_migrations`).all() as {
    version: number;
  }[];
  return new Set(rows.map((r) => r.version));
}

export function migrate(db: DatabaseSync = getDb()): number {
  const done = appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !done.has(m.version));
  if (!pending.length) return 0;

  const record = db.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
  );
  for (const m of pending) {
    if (m.noTx) {
      // Migration manages its own transaction (e.g. table rebuilds that toggle
      // PRAGMA foreign_keys). Record only after it succeeds.
      m.up(db);
      record.run(m.version, m.name, nowIso());
    } else {
      tx(db, () => {
        m.up(db);
        record.run(m.version, m.name, nowIso());
      });
    }
  }
  return pending.length;
}

// Minimal transaction helper (node:sqlite has no transaction() wrapper).
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Used by tests to point at an isolated file before the singleton is created.
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

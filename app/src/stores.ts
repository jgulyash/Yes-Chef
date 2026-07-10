import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { DB } from "./db.js";
import type { Store } from "./types.js";
import { id, patchRow } from "./util.js";

// Stores/vendors are user-managed data, not code (UX-REDESIGN §6): add, rename, hide
// from the app without touching anything else. Deleting is a soft-hide (active=0) so
// items pointing at a store never dangle.

const __dirname = dirname(fileURLToPath(import.meta.url));

// First-run seed, same data-not-code pattern as staples.json.
export const STORES_FILE =
  process.env.YESCHEF_STORES ?? resolve(__dirname, "..", "data", "stores.json");

interface StoreRow {
  id: string;
  household_id: string;
  name: string;
  kind: Store["kind"];
  order_method: Store["order_method"];
  url: string | null;
  sort_order: number;
  active: number;
}

const rowToStore = (r: StoreRow): Store => ({ ...r, active: !!r.active });

export function listStores(db: DB, household_id: string, includeInactive = false): Store[] {
  const rows = db
    .prepare(
      `SELECT * FROM store WHERE household_id = ?${includeInactive ? "" : " AND active = 1"}
       ORDER BY sort_order, name`
    )
    .all(household_id) as unknown as StoreRow[];
  return rows.map(rowToStore);
}

export function getStore(db: DB, household_id: string, store_id: string): Store | null {
  const r = db
    .prepare(`SELECT * FROM store WHERE household_id = ? AND id = ?`)
    .get(household_id, store_id) as StoreRow | undefined;
  return r ? rowToStore(r) : null;
}

export interface StoreInput {
  name: string;
  kind?: Store["kind"];
  order_method?: Store["order_method"];
  url?: string | null;
  sort_order?: number;
}

export function createStore(db: DB, household_id: string, input: StoreInput): Store {
  const sid = id("st");
  db.prepare(
    `INSERT INTO store (id, household_id, name, kind, order_method, url, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    sid,
    household_id,
    input.name.trim(),
    input.kind ?? null,
    input.order_method ?? null,
    input.url ?? null,
    input.sort_order ?? nextSortOrder(db, household_id)
  );
  return getStore(db, household_id, sid)!;
}

function nextSortOrder(db: DB, household_id: string): number {
  const r = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) m FROM store WHERE household_id = ?`)
    .get(household_id) as { m: number };
  return r.m + 1;
}

export interface StorePatch {
  name?: string;
  kind?: Store["kind"];
  order_method?: Store["order_method"];
  url?: string | null;
  sort_order?: number;
  active?: boolean;
}

const STORE_PATCHABLE = ["name", "kind", "order_method", "url", "sort_order", "active"] as const;

export function updateStore(
  db: DB,
  household_id: string,
  store_id: string,
  patch: StorePatch
): Store | null {
  // Same normalization as createStore — an untrimmed rename would sneak "Acme "
  // past the UNIQUE(household_id, name) guard and split the By-Store grouping.
  const normalized = typeof patch.name === "string" ? { ...patch, name: patch.name.trim() } : patch;
  patchRow(db, "store", STORE_PATCHABLE, normalized, { household_id, id: store_id });
  return getStore(db, household_id, store_id);
}

// Soft delete: hide the store, keep history and item links intact.
export function deactivateStore(db: DB, household_id: string, store_id: string): Store | null {
  return updateStore(db, household_id, store_id, { active: false });
}

// Duplicate-name pre-check so routes can 400 cleanly instead of crashing into the
// UNIQUE(household_id, name) constraint with a 500.
export function storeNameExists(
  db: DB,
  household_id: string,
  name: string,
  excludeId?: string
): boolean {
  const r = db
    .prepare(
      `SELECT id FROM store WHERE household_id = ? AND name = ?${excludeId ? " AND id != ?" : ""}`
    )
    .get(...([household_id, name.trim(), ...(excludeId ? [excludeId] : [])] as string[]));
  return !!r;
}

export function storeCount(db: DB, household_id: string): number {
  return (
    db.prepare(`SELECT COUNT(*) c FROM store WHERE household_id = ?`).get(household_id) as {
      c: number;
    }
  ).c;
}

// First-run seeding from data/stores.json (bootstrap calls this only when empty).
export function seedStores(db: DB, household_id: string, file = STORES_FILE): number {
  if (!existsSync(file)) return 0;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { stores?: StoreInput[] };
  if (!parsed?.stores?.length) return 0;
  for (const s of parsed.stores) createStore(db, household_id, s);
  return parsed.stores.length;
}

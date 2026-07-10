import type { DB } from "./db.js";
import type { Bucket, FoodItem, InventoryState, Source } from "./types.js";
import { id, nowIso, patchRow } from "./util.js";
import { normalize } from "./resolver.js";

// Bucket ordering, worst -> best. Index is used for coarse arithmetic in prediction,
// never asserted as a real quantity.
export const BUCKETS: Bucket[] = ["out", "low", "half", "full"];
export function bucketIndex(b: Bucket): number {
  return BUCKETS.indexOf(b);
}

// One notch of coarse depletion (full -> half -> low -> out), clamped at "out".
// Lives here so bucket arithmetic has exactly one home (cook depletion uses it;
// anything else that needs "a notch down" calls this, not its own index math).
export function stepDownBucket(b: Bucket): Bucket {
  return BUCKETS[Math.max(0, bucketIndex(b) - 1)];
}

interface FoodItemRow {
  id: string;
  household_id: string;
  name: string;
  zone: FoodItem["zone"];
  is_discrete: number;
  par: number;
  reorder_point: number;
  consumption_rate: number | null;
  store_id: string | null;
  brand: string | null;
  order_url: string | null;
  package_size: string | null;
  active: number;
}

export function rowToFoodItem(r: FoodItemRow): FoodItem {
  return {
    id: r.id,
    household_id: r.household_id,
    name: r.name,
    zone: r.zone,
    is_discrete: !!r.is_discrete,
    par: r.par,
    reorder_point: r.reorder_point,
    consumption_rate: r.consumption_rate,
    store_id: r.store_id ?? null,
    brand: r.brand ?? null,
    order_url: r.order_url ?? null,
    package_size: r.package_size ?? null,
    active: r.active !== 0,
  };
}

// Editable item fields (UX-REDESIGN §5.5 item detail): store/detail plus the tuning
// numbers that were previously JSON-only. Identity fields (id, name) stay immutable
// here — renames go through the alias/merge flow, not a field edit.
export interface FoodItemPatch {
  store_id?: string | null;
  brand?: string | null;
  order_url?: string | null;
  package_size?: string | null;
  zone?: FoodItem["zone"];
  par?: number;
  reorder_point?: number;
  consumption_rate?: number | null;
}

export const ITEM_PATCHABLE = [
  "store_id",
  "brand",
  "order_url",
  "package_size",
  "zone",
  "par",
  "reorder_point",
  "consumption_rate",
] as const;

export function updateFoodItem(
  db: DB,
  household_id: string,
  food_item_id: string,
  patch: FoodItemPatch
): FoodItem | null {
  patchRow(db, "food_item", ITEM_PATCHABLE, patch, { household_id, id: food_item_id });
  return getFoodItem(db, household_id, food_item_id);
}

// Removed items (active=0) are invisible by default — every list, picker, shortfall,
// and validation path sees only the live kitchen. Pass includeInactive for the few
// paths that need history (reactivation lookup, recipe ingredient names).
export function getFoodItem(
  db: DB,
  household_id: string,
  food_item_id: string,
  includeInactive = false
): FoodItem | null {
  const r = db
    .prepare(
      `SELECT * FROM food_item WHERE household_id = ? AND id = ?${includeInactive ? "" : " AND active = 1"}`
    )
    .get(household_id, food_item_id) as FoodItemRow | undefined;
  return r ? rowToFoodItem(r) : null;
}

export function listFoodItems(db: DB, household_id: string, includeInactive = false): FoodItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM food_item WHERE household_id = ?${includeInactive ? "" : " AND active = 1"} ORDER BY zone, name`
    )
    .all(household_id) as unknown as FoodItemRow[];
  return rows.map(rowToFoodItem);
}

export function findFoodItemByName(db: DB, household_id: string, name: string): FoodItem | null {
  const r = db
    .prepare(`SELECT * FROM food_item WHERE household_id = ? AND name = ?`)
    .get(household_id, name.trim()) as FoodItemRow | undefined;
  return r ? rowToFoodItem(r) : null;
}

// Create a new food item: the item row, its starting inventory, and its aliases
// (canonical name + any extras), all normalized through the resolver. Used by both
// the first-run seed and POST /api/items.
export interface NewFoodItem {
  name: string;
  zone: FoodItem["zone"];
  is_discrete: boolean;
  par: number;
  reorder_point: number;
  consumption_rate?: number | null;
  init: number | Bucket; // starting count (discrete) or bucket (bulk)
  aliases?: string[];
}

export function createFoodItem(db: DB, household_id: string, input: NewFoodItem): FoodItem {
  const fid = id("fi");
  db.prepare(
    `INSERT INTO food_item
       (id, household_id, name, zone, is_discrete, par, reorder_point, consumption_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fid,
    household_id,
    input.name.trim(),
    input.zone,
    input.is_discrete ? 1 : 0,
    input.par,
    input.reorder_point,
    input.consumption_rate ?? null
  );
  db.prepare(
    `INSERT INTO inventory (household_id, food_item_id, bucket, count, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    household_id,
    fid,
    input.is_discrete ? null : ((input.init as Bucket) ?? "full"),
    input.is_discrete ? (typeof input.init === "number" ? input.init : input.par) : null,
    nowIso()
  );
  const forms = new Set([normalize(input.name), ...(input.aliases ?? []).map(normalize)]);
  const insAlias = db.prepare(
    `INSERT OR IGNORE INTO alias (id, household_id, surface_form, food_item_id, source_type, origin)
     VALUES (?, ?, ?, ?, 'any', 'seeded')`
  );
  for (const f of forms) if (f) insAlias.run(id("al"), household_id, f, fid);
  return getFoodItem(db, household_id, fid)!;
}

// "Remove from kitchen" — a visibility flag, never a row delete: events, learned
// aliases, and recipe links keep their history. Reactivating brings it all back.
export function removeFoodItem(db: DB, household_id: string, food_item_id: string): boolean {
  const r = db
    .prepare(`UPDATE food_item SET active = 0 WHERE household_id = ? AND id = ? AND active = 1`)
    .run(household_id, food_item_id);
  return r.changes > 0;
}

export function restoreFoodItem(db: DB, household_id: string, food_item_id: string): FoodItem | null {
  db.prepare(`UPDATE food_item SET active = 1 WHERE household_id = ? AND id = ?`).run(
    household_id,
    food_item_id
  );
  return getFoodItem(db, household_id, food_item_id);
}

interface InvRow {
  bucket: Bucket | null;
  count: number | null;
  updated_at: string;
}

export function getInventory(
  db: DB,
  household_id: string,
  food_item_id: string
): { state: InventoryState; updated_at: string } | null {
  const r = db
    .prepare(`SELECT bucket, count, updated_at FROM inventory WHERE household_id = ? AND food_item_id = ?`)
    .get(household_id, food_item_id) as InvRow | undefined;
  if (!r) return null;
  const state: InventoryState =
    r.count !== null ? { kind: "count", count: r.count } : { kind: "bucket", bucket: r.bucket as Bucket };
  return { state, updated_at: r.updated_at };
}

// Append-only audit log of every inventory motion. delta is the signed count change
// (discrete) or null for a bucket transition (meta carries bucket_to).
export function recordEvent(
  db: DB,
  household_id: string,
  food_item_id: string,
  delta: number | null,
  source: Source,
  meta: Record<string, unknown> | null = null
): void {
  db.prepare(
    `INSERT INTO event (id, ts, household_id, food_item_id, delta, source, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id("ev"), nowIso(), household_id, food_item_id, delta, source, meta ? JSON.stringify(meta) : null);
}

// Set a bulk item's bucket. Records an event. (The count is an estimate, not truth —
// callers set state from real signals: receipts, quick-add, manual reconcile.)
export function setBucket(
  db: DB,
  household_id: string,
  food_item_id: string,
  bucket: Bucket,
  source: Source,
  meta: Record<string, unknown> | null = null
): void {
  db.prepare(
    `UPDATE inventory SET bucket = ?, count = NULL, updated_at = ? WHERE household_id = ? AND food_item_id = ?`
  ).run(bucket, nowIso(), household_id, food_item_id);
  recordEvent(db, household_id, food_item_id, null, source, { ...(meta ?? {}), bucket_to: bucket });
}

// Set a discrete item's absolute count.
export function setCount(
  db: DB,
  household_id: string,
  food_item_id: string,
  count: number,
  source: Source,
  meta: Record<string, unknown> | null = null
): void {
  const c = Math.max(0, Math.round(count));
  db.prepare(
    `UPDATE inventory SET count = ?, bucket = NULL, updated_at = ? WHERE household_id = ? AND food_item_id = ?`
  ).run(c, nowIso(), household_id, food_item_id);
  recordEvent(db, household_id, food_item_id, null, source, { ...(meta ?? {}), count_to: c });
}

// Apply a signed delta to a discrete item's count (e.g. receipt +N, cook -N).
// Returns the new count. Clamps at zero (the estimate never goes negative).
export function applyCountDelta(
  db: DB,
  household_id: string,
  food_item_id: string,
  delta: number,
  source: Source,
  meta: Record<string, unknown> | null = null
): number {
  const cur = getInventory(db, household_id, food_item_id);
  const prev = cur && cur.state.kind === "count" ? cur.state.count : 0;
  const next = Math.max(0, prev + Math.round(delta));
  db.prepare(
    `UPDATE inventory SET count = ?, bucket = NULL, updated_at = ? WHERE household_id = ? AND food_item_id = ?`
  ).run(next, nowIso(), household_id, food_item_id);
  // Log the ACTUAL change (next - prev), not the requested delta — when the zero-clamp
  // bites (cook 3 from a count of 1), the requested value would overstate consumption
  // and poison any future rate-learning that sums event deltas.
  recordEvent(db, household_id, food_item_id, next - prev, source, meta);
  return next;
}

import type { DB } from "./db.js";
import type { Bucket, FoodItem, InventoryState, ShortfallItem } from "./types.js";
import { getInventory, listFoodItems } from "./inventory.js";

// ---------------------------------------------------------------------------
// The reorder engine: TRIGGER-BASED on buckets/counts, never
// continuous-quantity arithmetic.
//   * discrete items: trigger when count <= reorder_point
//   * bulk items:     trigger when bucket is "low" or "out"
// The engine only ever PROPOSES — its output is a shortfall list, never an order.
// ---------------------------------------------------------------------------

const BULK_TRIGGER: ReadonlySet<Bucket> = new Set<Bucket>(["low", "out"]);

export function discreteTriggered(count: number, reorder_point: number): boolean {
  return count <= reorder_point;
}

export function bulkTriggered(bucket: Bucket): boolean {
  return BULK_TRIGGER.has(bucket);
}

// Is this item's CURRENT RECORDED state at/below its reorder point?
export function isShortfall(item: FoodItem, state: InventoryState): boolean {
  if (item.is_discrete) {
    return state.kind === "count" && discreteTriggered(state.count, item.reorder_point);
  }
  return state.kind === "bucket" && bulkTriggered(state.bucket);
}

// Human-readable "order this much" (reorder up to par for discrete; coarse for bulk).
export function needText(item: FoodItem, state: InventoryState): string {
  if (item.is_discrete && state.kind === "count") {
    const qty = Math.max(0, Math.ceil(item.par - state.count));
    return `${qty} more (up to par ${item.par})`;
  }
  return "1 (restock to full + a backup)";
}

export function describeState(state: InventoryState): string {
  return state.kind === "count" ? `count: ${state.count}` : `bucket: ${state.bucket}`;
}

export interface ShortfallOptions {
  // Include low-confidence predicted-depletion items (flagged "confirm?"). Wired in step 5.
  includePredicted?: boolean;
  asOfIso?: string; // "now" for prediction; defaults to actual now
  // Predictor injected by callers (server/demo) so the recorded-trigger engine stays
  // self-contained and import-cycle-free. Supplied by prediction.ts in step 5.
  predictor?: (db: DB, household_id: string, asOfIso?: string) => ShortfallItem[];
}

// Build the weekly shortfall list for a household. Covers RECORDED triggers (high
// confidence). Predicted-depletion items (low confidence, "confirm?") are merged in
// when a predictor is provided (step 5) and never override a hard shortfall.
export function computeShortfall(
  db: DB,
  household_id: string,
  opts: ShortfallOptions = {}
): ShortfallItem[] {
  const items = listFoodItems(db, household_id);
  const out: ShortfallItem[] = [];
  const flagged = new Set<string>();

  for (const item of items) {
    const inv = getInventory(db, household_id, item.id);
    if (!inv) continue;

    if (isShortfall(item, inv.state)) {
      out.push(toRow(item, inv.state, false, "at or below reorder point"));
      flagged.add(item.id);
    }
  }

  if (opts.includePredicted && opts.predictor) {
    for (const p of opts.predictor(db, household_id, opts.asOfIso)) {
      if (flagged.has(p.food_item_id)) continue; // already a hard shortfall
      out.push(p);
      flagged.add(p.food_item_id);
    }
  }

  // Decorate every row (hard + predicted) with its store name for the List tab's
  // "By Store" grouping — one lookup, applied in one place (null = Unassigned).
  // Skipped entirely when nothing is short (the fully-stocked steady state).
  if (!out.length) return out;
  const storeNames = new Map(
    (
      db.prepare(`SELECT id, name FROM store WHERE household_id = ?`).all(household_id) as {
        id: string;
        name: string;
      }[]
    ).map((s) => [s.id, s.name])
  );
  for (const row of out) {
    row.store_name = row.store_id ? (storeNames.get(row.store_id) ?? null) : null;
  }

  // Hard shortfalls first, then predicted; then by zone/name.
  return out.sort(
    (a, b) =>
      Number(a.predicted) - Number(b.predicted) ||
      a.zone.localeCompare(b.zone) ||
      a.name.localeCompare(b.name)
  );
}

export function toRow(
  item: FoodItem,
  state: InventoryState,
  predicted: boolean,
  reason: string
): ShortfallItem {
  return {
    food_item_id: item.id,
    name: item.name,
    zone: item.zone,
    is_discrete: item.is_discrete,
    state,
    reorder_point: item.reorder_point,
    par: item.par,
    need: needText(item, state),
    predicted,
    confidence: predicted ? "confirm?" : "high",
    reason,
    store_id: item.store_id ?? null,
    store_name: null, // filled by computeShortfall's decoration pass
  };
}

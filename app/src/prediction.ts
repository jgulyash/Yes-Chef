import type { DB } from "./db.js";
import type { Bucket, FoodItem, InventoryState, ShortfallItem } from "./types.js";
import { getInventory, listFoodItems } from "./inventory.js";
import { isShortfall, toRow, needText } from "./engine.js";
import { daysBetween, nowIso } from "./util.js";

// ---------------------------------------------------------------------------
// Predicted depletion (Cut Sheet flow 3) — the workhorse that
// carries the count between explicit signals.
//
// It NEVER changes inventory and NEVER orders. It only PROPOSES: when an item's
// estimated state crosses its reorder point, it's added to the shortfall list
// flagged "confirm?" (low confidence) for the human to decide.
//
// Stays bucket/count based: for bulk items we map buckets to a coarse fraction,
// subtract estimated consumption, then map back to a bucket — we never assert a
// continuous quantity as truth, we just decide which bucket the estimate lands in.
// ---------------------------------------------------------------------------

// Coarse fraction-of-container per bucket, and the thresholds to map back.
const BUCKET_FRACTION: Record<Bucket, number> = { full: 1, half: 0.5, low: 0.25, out: 0 };

function fractionToBucket(f: number): Bucket {
  if (f >= 0.75) return "full";
  if (f >= 0.375) return "half";
  if (f > 0.05) return "low";
  return "out";
}

const TRIGGER: ReadonlySet<Bucket> = new Set<Bucket>(["low", "out"]);

export interface Prediction {
  food_item_id: string;
  predicted_state: InventoryState;
  days_since_update: number;
  crosses_reorder: boolean;
}

// Estimate an item's current state from its last recorded state + consumption rate.
export function predictState(
  item: FoodItem,
  recorded: InventoryState,
  updatedAtIso: string,
  asOfIso: string
): Prediction {
  const days = Math.max(0, daysBetween(updatedAtIso, asOfIso));
  const rate = item.consumption_rate ?? 0;

  if (item.is_discrete && recorded.kind === "count") {
    const predicted = Math.max(0, recorded.count - rate * days);
    // Compare the unfloored estimate to the reorder point so we don't false-fire the
    // moment a fresh count rounds down (e.g. 1.99 -> "1"). Round only for display.
    const predicted_state: InventoryState = { kind: "count", count: Math.round(predicted) };
    return {
      food_item_id: item.id,
      predicted_state,
      days_since_update: days,
      crosses_reorder: predicted <= item.reorder_point,
    };
  }

  if (!item.is_discrete && recorded.kind === "bucket") {
    const frac = BUCKET_FRACTION[recorded.bucket] - rate * days;
    const predicted_bucket = fractionToBucket(frac);
    return {
      food_item_id: item.id,
      predicted_state: { kind: "bucket", bucket: predicted_bucket },
      days_since_update: days,
      crosses_reorder: TRIGGER.has(predicted_bucket),
    };
  }

  // No rate or mismatched state shape — no prediction.
  return {
    food_item_id: item.id,
    predicted_state: recorded,
    days_since_update: days,
    crosses_reorder: false,
  };
}

// Items whose ESTIMATED state crosses the reorder point but whose RECORDED state
// does not yet — i.e. low-confidence "confirm?" additions to the shortfall list.
export function predictShortfall(
  db: DB,
  household_id: string,
  asOfIso: string = nowIso()
): ShortfallItem[] {
  const out: ShortfallItem[] = [];
  for (const item of listFoodItems(db, household_id)) {
    if (item.consumption_rate == null) continue;
    const inv = getInventory(db, household_id, item.id);
    if (!inv) continue;

    // Skip items already in hard shortfall — those are reported with high confidence.
    if (isShortfall(item, inv.state)) continue;

    const p = predictState(item, inv.state, inv.updated_at, asOfIso);
    if (!p.crosses_reorder) continue;

    const days = p.days_since_update.toFixed(1);
    const est =
      p.predicted_state.kind === "count"
        ? `~${p.predicted_state.count} left`
        : `~${p.predicted_state.bucket}`;
    const row = toRow(item, inv.state, true, `predicted ${est} after ${days}d at usual rate — confirm?`);
    // Base the "need" on the predicted state (what you'd actually be short), not the
    // still-full recorded count. The displayed state stays the truthful last-known value.
    row.need = needText(item, p.predicted_state);
    out.push(row);
  }
  return out;
}

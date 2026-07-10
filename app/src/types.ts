// Core domain types for the Yes Chef! Stage-1 MVP.
// Kept deliberately small: four tables (FoodItem, Inventory, Alias, Event) plus the
// resolver's UnmatchedMention queue. Everything is scoped by household_id from day one.

export type Zone = "frozen" | "deep_freezer" | "refrigerated" | "counter" | "pantry";

// Single source of truth for zone validation (API input checks, seed validation).
export const ZONES: readonly Zone[] = ["frozen", "deep_freezer", "refrigerated", "counter", "pantry"];

// Bucket states for bulk/continuous items. Ordered worst -> best.
export type Bucket = "out" | "low" | "half" | "full";

// Where an inventory motion came from. (Resolution spec source_type, MVP subset.)
export type Source = "receipt" | "cook" | "quickadd" | "predicted" | "manual" | "narration";

export interface FoodItem {
  id: string;
  household_id: string;
  name: string;
  zone: Zone;
  is_discrete: boolean; // true -> integer count tracking; false -> bucket tracking
  par: number; // target on-hand (count for discrete; informational for bulk)
  reorder_point: number; // count threshold for discrete items
  consumption_rate: number | null; // units/day (discrete) or fraction-of-container/day (bulk)
  // Store/vendor + item detail (UX-REDESIGN §6; all nullable, filled in over time).
  store_id: string | null;
  brand: string | null;
  order_url: string | null;
  package_size: string | null;
  // false = removed from the kitchen (UI: "Remove") — hidden everywhere, history kept.
  active: boolean;
}

// Store enums as value lists for API validation (mirror the SQLite CHECK constraints —
// validating in the route turns a would-be 500 constraint crash into a friendly 400).
export const STORE_KINDS = ["grocery", "warehouse", "online", "other"] as const;
export const ORDER_METHODS = ["in_store", "pickup", "delivery"] as const;

// A store/vendor you buy from — user-managed data, not a hardcoded list (UX-REDESIGN §6).
export interface Store {
  id: string;
  household_id: string;
  name: string;
  kind: "grocery" | "warehouse" | "online" | "other" | null;
  order_method: "in_store" | "pickup" | "delivery" | null;
  url: string | null;
  sort_order: number;
  active: boolean;
}

// Recipes (UX-REDESIGN §5.3): ingredients link to staples; "I made this" -> cook events.
export interface Recipe {
  id: string;
  household_id: string;
  name: string;
  source_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface RecipeIngredient {
  recipe_id: string;
  food_item_id: string;
  qty: number | null; // units for discrete items; ignored for bulk (bucket-notch depletion)
  unit: string | null;
  optional: boolean; // optional ingredients never block "ready" and deplete only if present
}

// Inventory.state is {bucket} OR {count} per the Cut Sheet. We store both nullable
// columns and expose this discriminated shape in code.
export type InventoryState =
  | { kind: "count"; count: number }
  | { kind: "bucket"; bucket: Bucket };

export interface InventoryRow {
  household_id: string;
  food_item_id: string;
  state: InventoryState;
  updated_at: string; // ISO timestamp of last explicit (non-predicted) update
}

export interface Alias {
  id: string;
  household_id: string;
  surface_form: string; // normalized form
  food_item_id: string;
  source_type: Source | "any";
  origin: "seeded" | "learned" | "human_confirmed";
}

export interface Event {
  id: string;
  ts: string; // ISO timestamp
  household_id: string;
  food_item_id: string;
  delta: number | null; // signed count delta for discrete; null for bucket transitions
  source: Source;
  meta: Record<string, unknown> | null; // e.g. { bucket_to, raw_text, receipt_id }
}

export interface UnmatchedMention {
  id: string;
  household_id: string;
  raw_text: string;
  normalized: string;
  source_type: Source;
  qty: number;
  status: "pending" | "resolved" | "ignored";
  context: Record<string, unknown> | null;
  created_at: string;
}

// A recorded kitchen-pass video, awaiting the future vision/narration pipeline.
// Lifecycle: queued -> processing -> processed (or failed). Stored raw now so nothing
// is lost before the AI phase exists.
export interface MediaCapture {
  id: string;
  household_id: string;
  path: string; // relative to the media root
  filename: string;
  bytes: number;
  captured_at: string;
  kind: "video";
  status: "queued" | "processing" | "processed" | "failed";
  note: string | null;
  transcript?: string | null; // set once processed (narration pipeline)
}

// Outcome logging for the metrics view (precision / recall).
export interface ShortfallFeedback {
  id: string;
  ts: string;
  household_id: string;
  food_item_id: string;
  predicted: boolean; // was this a low-confidence (predicted) flag?
  verdict: "confirmed_needed" | "false_positive" | "missed_runout";
}

// A row on the weekly shortfall list.
export interface ShortfallItem {
  food_item_id: string;
  name: string;
  zone: Zone;
  is_discrete: boolean;
  state: InventoryState;
  reorder_point: number;
  par: number;
  need: string; // human-readable "order this much"
  predicted: boolean; // true -> low-confidence, flagged "confirm?"
  confidence: "high" | "confirm?";
  reason: string;
  // Grouping metadata for the List tab's "By Store" view (null = Unassigned).
  store_id: string | null;
  store_name: string | null;
}

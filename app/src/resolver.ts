import type { DB } from "./db.js";
import type { Source } from "./types.js";
import { id, nowIso } from "./util.js";

// ---------------------------------------------------------------------------
// LITE canonical item resolution (Resolution spec, cascade steps 1-3):
//   1. NORMALIZE  -> 2. EXACT ALIAS  -> (3) UNMATCHED QUEUE
// No UPC lookup, no fuzzy/embedding, no LLM, no recipe parser (later phases).
//
// Hard rules enforced here:
//   * Every source resolves through the alias table (one truth, no forks).
//   * Nothing unresolved silently becomes a FoodItem -> it goes to the queue.
// ---------------------------------------------------------------------------

// Common receipt/narration abbreviations -> canonical words. Data, not logic:
// extend freely without touching the cascade.
const ABBREVIATIONS: Record<string, string> = {
  org: "organic",
  whl: "whole",
  wht: "white",
  lg: "large",
  sm: "small",
  med: "medium",
  pnt: "peanut",
  btr: "butter",
  chkn: "chicken",
  veg: "vegetable",
  yogrt: "yogurt",
  choc: "chocolate",
};

// Units / sizes / pack-counts to strip. "hg" (half-gallon), "ct" (count), etc.
const UNIT_TOKENS = new Set([
  "oz", "lb", "lbs", "g", "kg", "ml", "l", "ct", "pk", "pack", "gal",
  "gallon", "hg", "qt", "pt", "dozen", "doz", "count", "fl", "ea", "each",
]);

// Store/brand prefixes to drop so "TJ's basil" matches "basil".
const STORE_PREFIXES = ["tj's", "tjs", "trader joe's", "kirkland", "great value", "store brand"];

export function normalize(raw: string): string {
  let s = raw.toLowerCase().trim();

  // Drop leading store prefixes.
  for (const p of STORE_PREFIXES) {
    if (s.startsWith(p)) s = s.slice(p.length).trim();
  }

  // Tokenize on non-alphanumerics; drop pure numbers, size tokens (e.g. "64oz"),
  // and standalone unit words; expand known abbreviations.
  const tokens = s
    .split(/[^a-z0-9']+/)
    .filter(Boolean)
    .map((t) => t.replace(/'s$/, "")) // possessives
    .filter((t) => !/^\d+$/.test(t)) // pure numbers (pack counts, "2")
    .filter((t) => !/^\d+(\.\d+)?[a-z]+$/.test(t)) // sizes glued to units e.g. "64oz"
    .filter((t) => !UNIT_TOKENS.has(t))
    .map((t) => ABBREVIATIONS[t] ?? t);

  return tokens.join(" ").trim();
}

export interface Resolution {
  food_item_id: string | null;
  confidence: number;
  method: "exact_alias" | "unmatched";
  needs_review: boolean;
  normalized: string;
}

// Step 1-3 of the cascade. Prefers an alias matching the same source_type, then any.
export function resolve(
  db: DB,
  household_id: string,
  raw: string,
  source_type: Source
): Resolution {
  const normalized = normalize(raw);

  // Aliases of REMOVED items don't match — a mention of one falls through to the
  // review queue so the user decides whether to bring the item back, instead of
  // the system silently crediting something invisible.
  const row = db
    .prepare(
      `SELECT a.food_item_id, a.source_type FROM alias a
       JOIN food_item fi ON fi.id = a.food_item_id AND fi.active = 1
       WHERE a.household_id = ? AND a.surface_form = ?
       ORDER BY (a.source_type = ?) DESC, (a.source_type = 'any') DESC
       LIMIT 1`
    )
    .get(household_id, normalized, source_type) as
    | { food_item_id: string; source_type: string }
    | undefined;

  if (row) {
    return {
      food_item_id: row.food_item_id,
      confidence: 0.97,
      method: "exact_alias",
      needs_review: false,
      normalized,
    };
  }

  return {
    food_item_id: null,
    confidence: 0,
    method: "unmatched",
    needs_review: true,
    normalized,
  };
}

// Route an unresolved mention to the review queue. NEVER creates a FoodItem.
export function queueUnmatched(
  db: DB,
  household_id: string,
  raw: string,
  source_type: Source,
  qty: number,
  context: Record<string, unknown> | null = null
): string {
  const normalized = normalize(raw);
  const mid = id("um");
  db.prepare(
    `INSERT INTO unmatched_mention
       (id, household_id, raw_text, normalized, source_type, qty, status, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    mid,
    household_id,
    raw,
    normalized,
    source_type,
    qty,
    context ? JSON.stringify(context) : null,
    nowIso()
  );
  return mid;
}

// Feedback loop: learn an alias so the same mention resolves next time without review.
// This is the only place an alias is created from a human decision.
export function learnAlias(
  db: DB,
  household_id: string,
  surface_form_normalized: string,
  food_item_id: string,
  source_type: Source | "any" = "any"
): void {
  db.prepare(
    `INSERT OR IGNORE INTO alias
       (id, household_id, surface_form, food_item_id, source_type, origin)
     VALUES (?, ?, ?, ?, ?, 'human_confirmed')`
  ).run(id("al"), household_id, surface_form_normalized, food_item_id, source_type);
}

import type { DB } from "./db.js";
import { resolve, queueUnmatched, learnAlias, normalize } from "./resolver.js";
import {
  applyCountDelta,
  getFoodItem,
  setBucket,
  setCount,
} from "./inventory.js";

// ---------------------------------------------------------------------------
// Receipt ingestion (Cut Sheet flow 1) — POST-DELIVERY semantics:
//   * delivered / substituted lines credit what ACTUALLY arrived.
//   * refunded / out-of-stock lines are NOT credited (crediting food you never
//     received is a direct cause of the over-order loop).
// Each line resolves through the alias table; unknowns go to the queue, never
// auto-create a FoodItem.
// ---------------------------------------------------------------------------

export type LineStatus = "delivered" | "substituted" | "refunded";

export interface ReceiptLine {
  raw_text: string; // for substitutions, the text of what arrived
  qty?: number;
  status?: string; // delivered | substituted | refunded
  ordered_text?: string; // optional: what was ordered (for mismatch flagging)
}

export interface ReceiptResult {
  applied: { food_item_id: string; name: string; raw_text: string; qty: number; substituted: boolean }[];
  refunded: { raw_text: string }[];
  unmatched: { unmatched_id: string; raw_text: string; qty: number }[];
}

function normStatus(s?: string): LineStatus {
  const v = (s ?? "delivered").toLowerCase();
  if (v === "refunded" || v === "oos" || v === "out_of_stock") return "refunded";
  if (v === "substituted" || v === "sub") return "substituted";
  return "delivered";
}

// Credit a resolved FoodItem from a received line: discrete += qty; bulk -> full.
function creditStock(db: DB, household_id: string, food_item_id: string, qty: number): void {
  const item = getFoodItem(db, household_id, food_item_id)!;
  if (item.is_discrete) {
    applyCountDelta(db, household_id, food_item_id, qty, "receipt", { qty });
  } else {
    setBucket(db, household_id, food_item_id, "full", "receipt", { qty });
  }
}

export function ingestReceipt(
  db: DB,
  household_id: string,
  lines: ReceiptLine[],
  receipt_id?: string
): ReceiptResult {
  const out: ReceiptResult = { applied: [], refunded: [], unmatched: [] };

  for (const line of lines) {
    const status = normStatus(line.status);
    const qty = Math.max(1, Math.round(line.qty ?? 1));

    if (status === "refunded") {
      out.refunded.push({ raw_text: line.raw_text });
      continue; // never credit a refund
    }

    const r = resolve(db, household_id, line.raw_text, "receipt");
    if (!r.food_item_id) {
      const unmatched_id = queueUnmatched(db, household_id, line.raw_text, "receipt", qty, {
        receipt_id: receipt_id ?? null,
        status,
      });
      out.unmatched.push({ unmatched_id, raw_text: line.raw_text, qty });
      continue;
    }

    creditStock(db, household_id, r.food_item_id, qty);
    const item = getFoodItem(db, household_id, r.food_item_id)!;
    out.applied.push({
      food_item_id: item.id,
      name: item.name,
      raw_text: line.raw_text,
      qty,
      substituted: status === "substituted",
    });
  }

  return out;
}

// --- Unmatched review queue ---------------------------------------------------
export interface UnmatchedRow {
  id: string;
  raw_text: string;
  normalized: string;
  source_type: string;
  qty: number;
  context: Record<string, unknown> | null;
}

export function listUnmatched(db: DB, household_id: string): UnmatchedRow[] {
  const rows = db
    .prepare(
      `SELECT id, raw_text, normalized, source_type, qty, context
         FROM unmatched_mention
        WHERE household_id = ? AND status = 'pending'
        ORDER BY created_at`
    )
    .all(household_id) as unknown as {
    id: string;
    raw_text: string;
    normalized: string;
    source_type: string;
    qty: number;
    context: string | null;
  }[];
  return rows.map((r) => ({
    ...r,
    context: r.context ? (JSON.parse(r.context) as Record<string, unknown>) : null,
  }));
}

// Resolve a queued mention to a FoodItem: learn the alias (so it never asks again),
// then apply the mention's intended effect based on where it came from.
export function resolveUnmatched(
  db: DB,
  household_id: string,
  mention_id: string,
  food_item_id: string
): { ok: boolean; error?: string; learned?: string; applied?: string } {
  const m = db
    .prepare(
      `SELECT id, raw_text, normalized, source_type, qty, context, status
         FROM unmatched_mention WHERE household_id = ? AND id = ?`
    )
    .get(household_id, mention_id) as
    | {
        id: string;
        raw_text: string;
        normalized: string;
        source_type: string;
        qty: number;
        context: string | null;
        status: string;
      }
    | undefined;

  if (!m) return { ok: false, error: "unknown mention" };
  if (m.status !== "pending") return { ok: false, error: "mention already handled" };
  const item = getFoodItem(db, household_id, food_item_id);
  if (!item) return { ok: false, error: "unknown food item" };

  // Feedback loop: create the alias from the (normalized) raw mention.
  learnAlias(db, household_id, m.normalized || normalize(m.raw_text), food_item_id, "any");

  // Apply the deferred effect now that it's resolved.
  const ctx = m.context ? (JSON.parse(m.context) as { level?: "low" | "out" }) : {};
  let applied = "none";
  if (m.source_type === "receipt") {
    creditStock(db, household_id, food_item_id, m.qty);
    applied = `credited ${m.qty}`;
  } else if (m.source_type === "quickadd") {
    const level = ctx.level ?? "out";
    if (item.is_discrete) {
      setCount(db, household_id, food_item_id, level === "out" ? 0 : item.reorder_point, "quickadd");
    } else {
      setBucket(db, household_id, food_item_id, level, "quickadd");
    }
    applied = `set ${level}`;
  }

  db.prepare(`UPDATE unmatched_mention SET status = 'resolved' WHERE id = ?`).run(mention_id);
  return { ok: true, learned: m.normalized, applied };
}

export function ignoreUnmatched(
  db: DB,
  household_id: string,
  mention_id: string
): { ok: boolean } {
  db.prepare(
    `UPDATE unmatched_mention SET status = 'ignored' WHERE household_id = ? AND id = ? AND status = 'pending'`
  ).run(household_id, mention_id);
  return { ok: true };
}

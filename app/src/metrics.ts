import type { DB } from "./db.js";
import { id, nowIso } from "./util.js";

// ---------------------------------------------------------------------------
// The "is it working?" view (Cut Sheet §"What good looks like"):
//   * Precision — few false "you're low" flags (annoying, erodes trust).
//   * Recall    — few "we ran out and it wasn't on the list" misses (the real pain).
//   * Effort    — weekly upkeep taps; should stay under ~5 min/week.
// All derived from logged feedback + the event log. Honest, hand-trackable numbers.
// ---------------------------------------------------------------------------

export type Verdict = "confirmed_needed" | "false_positive" | "missed_runout";

export function recordFeedback(
  db: DB,
  household_id: string,
  food_item_id: string,
  predicted: boolean,
  verdict: Verdict
): void {
  db.prepare(
    `INSERT INTO shortfall_feedback (id, ts, household_id, food_item_id, predicted, verdict)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id("fb"), nowIso(), household_id, food_item_id, predicted ? 1 : 0, verdict);
}

export interface Metrics {
  precision: number | null; // TP / (TP + FP)
  recall: number | null; // TP / (TP + FN)
  counts: { confirmed_needed: number; false_positive: number; missed_runout: number };
  weekly_upkeep: {
    events_last_7d: number; // human-driven inventory touches
    pending_unmatched: number; // review backlog
  };
}

export function computeMetrics(db: DB, household_id: string): Metrics {
  const row = (v: Verdict) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM shortfall_feedback WHERE household_id = ? AND verdict = ?`
        )
        .get(household_id, v) as { c: number }
    ).c;

  const tp = row("confirmed_needed");
  const fp = row("false_positive");
  const fn = row("missed_runout");

  const events_last_7d = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM event
          WHERE household_id = ?
            AND source IN ('quickadd','manual','receipt','narration')
            AND ts >= datetime('now','-7 days')`
      )
      .get(household_id) as { c: number }
  ).c;

  const pending_unmatched = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM unmatched_mention WHERE household_id = ? AND status = 'pending'`
      )
      .get(household_id) as { c: number }
  ).c;

  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    counts: { confirmed_needed: tp, false_positive: fp, missed_runout: fn },
    weekly_upkeep: { events_last_7d, pending_unmatched },
  };
}

import type { DB } from "./db.js";
import { resolve, queueUnmatched } from "./resolver.js";
import { getFoodItem, setBucket, setCount } from "./inventory.js";

// Quick-add (Cut Sheet flow 2): a one-tap "out of X" / "low on X".
// Resolves the text THROUGH THE ALIAS TABLE (same path as every other source -> no fork).
// Unknown text never creates an item; it goes to the unmatched queue.

// Strip the natural-language wrapper ("we're out of olive oil") down to the item noun,
// and infer the level from the phrasing. Check "low" patterns before "out" so that
// "almost out of" reads as low, not out.
const LOW_PAT = /\b(running low on|running low|almost out of|almost out|getting low on|nearly out of|low on|low)\b/;
const OUT_PAT = /\b(we'?re out of|we are out of|all out of|ran out of|out of|outta|out|no more|used up|finished)\b/;
const FILLER_PAT = /\b(i'?m|we'?re|need|to|buy|get|reorder|please|more|some|the|a|of|on|my)\b/g;

export function parseIntent(text: string): { noun: string; level?: "low" | "out" } {
  let s = ` ${text.toLowerCase().trim()} `;
  let level: "low" | "out" | undefined;
  if (LOW_PAT.test(s)) {
    level = "low";
    s = s.replace(LOW_PAT, " ");
  } else if (OUT_PAT.test(s)) {
    level = "out";
    s = s.replace(OUT_PAT, " ");
  }
  s = s.replace(FILLER_PAT, " ").replace(/\s+/g, " ").trim();
  return { noun: s, level };
}

export interface QuickAddResult {
  ok: boolean;
  needs_review: boolean;
  food_item_id: string | null;
  name?: string;
  level: "low" | "out";
  unmatched_id?: string;
  message: string;
}

export function quickAdd(
  db: DB,
  household_id: string,
  text: string,
  level: "low" | "out"
): QuickAddResult {
  const parsed = parseIntent(text);
  const effLevel = parsed.level ?? level;
  const noun = parsed.noun || text;

  const r = resolve(db, household_id, noun, "quickadd");

  if (!r.food_item_id) {
    // Queue the parsed noun (so the learned alias is clean), keep the original for context.
    const unmatched_id = queueUnmatched(db, household_id, noun, "quickadd", 1, {
      level: effLevel,
      original: text,
    });
    return {
      ok: true,
      needs_review: true,
      food_item_id: null,
      level: effLevel,
      unmatched_id,
      message: `"${text}" didn't match a staple — sent to the review queue.`,
    };
  }

  const item = getFoodItem(db, household_id, r.food_item_id)!;
  if (item.is_discrete) {
    // "out" -> 0; "low" -> sit exactly at the reorder point so it triggers.
    setCount(db, household_id, item.id, effLevel === "out" ? 0 : item.reorder_point, "quickadd", {
      raw_text: text,
    });
  } else {
    setBucket(db, household_id, item.id, effLevel, "quickadd", { raw_text: text });
  }

  return {
    ok: true,
    needs_review: false,
    food_item_id: item.id,
    name: item.name,
    level: effLevel,
    message: `Marked ${item.name} ${effLevel}.`,
  };
}

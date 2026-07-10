import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getDb, migrate, tx, type DB } from "./db.js";
import { createFoodItem } from "./inventory.js";
import type { Bucket, Zone } from "./types.js";

export const DEFAULT_HOUSEHOLD = "hh_default";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Your staple list lives in data/staples.json (editable data you own, not code).
// Override the path with YESCHEF_STAPLES if you keep it elsewhere.
export const STAPLES_FILE =
  process.env.YESCHEF_STAPLES ?? resolve(__dirname, "..", "data", "staples.json");

export interface StapleSeed {
  name: string;
  zone: Zone;
  is_discrete: boolean;
  par: number;
  reorder_point: number;
  consumption_rate: number; // units/day (discrete) or fraction-of-container/day (bulk)
  init: number | Bucket; // starting state: count (discrete) or bucket (bulk)
  aliases: string[]; // extra surface forms (canonical name auto-added)
}

export function loadStaples(file = STAPLES_FILE): StapleSeed[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { staples: StapleSeed[] };
  if (!parsed?.staples?.length) throw new Error(`No staples found in ${file}`);
  return parsed.staples;
}

export function seed(db: DB, household_id = DEFAULT_HOUSEHOLD, staples = loadStaples()): void {
  migrate(db);
  db.prepare(`INSERT OR IGNORE INTO household (id, name) VALUES (?, ?)`).run(
    household_id,
    "Home"
  );
  // One creation path for items (item + inventory + normalized aliases) — the same
  // createFoodItem the API uses, so seeded and app-added items can never drift.
  tx(db, () => {
    for (const s of staples) createFoodItem(db, household_id, s);
  });
}

// Count staples already seeded for a household (used by the first-run bootstrap).
export function stapleCount(db: DB, household_id = DEFAULT_HOUSEHOLD): number {
  return (
    db.prepare(`SELECT COUNT(*) c FROM food_item WHERE household_id = ?`).get(household_id) as {
      c: number;
    }
  ).c;
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getDb();
  seed(db);
  const a = db
    .prepare(`SELECT COUNT(*) c FROM alias WHERE household_id = ?`)
    .get(DEFAULT_HOUSEHOLD) as { c: number };
  console.log(
    `Seeded ${stapleCount(db)} staples and ${a.c} aliases for household ${DEFAULT_HOUSEHOLD}.`
  );
}

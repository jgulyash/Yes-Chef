import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "../src/db.js";
import { seed, loadStaples, DEFAULT_HOUSEHOLD } from "../src/seed.js";
import { listFoodItems } from "../src/inventory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests seed from the FROZEN sample list, never from data/staples.json — that file is
// the user's own grocery list and they're told to edit it freely. The sample pins the
// 30 generic staples (Whole milk, Onions, ...) that test assertions reference by name.
export const FIXTURE_STAPLES = resolve(__dirname, "..", "data", "staples.sample.json");

// A fresh in-memory DB: migrations applied + fixture staples seeded. Every domain
// function takes a db argument, so tests never touch the on-disk singleton.
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seed(db, DEFAULT_HOUSEHOLD, loadStaples(FIXTURE_STAPLES));
  return db;
}

export const HH = DEFAULT_HOUSEHOLD;

export function itemId(db: DatabaseSync, name: string): string {
  const it = listFoodItems(db, HH).find((i) => i.name === name);
  if (!it) throw new Error(`no staple named ${name}`);
  return it.id;
}

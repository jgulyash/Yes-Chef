import type { DB } from "./db.js";
import type { Bucket, InventoryState, Recipe, RecipeIngredient } from "./types.js";
import { tx } from "./db.js";
import { getFoodItem, setBucket, applyCountDelta, stepDownBucket } from "./inventory.js";
import { id, nowIso } from "./util.js";

// Recipes (UX-REDESIGN §5.3): each ingredient links to a staple. "I made this" logs
// cook depletions through the same event log as every other inventory motion.
//
// Depletion semantics (documented simplification, revisit with real usage):
//   discrete ingredient -> count -= qty (default 1), clamped at 0
//   bulk ingredient     -> bucket steps down ONE notch per cook (full->half->low->out)
// Buckets are coarse estimates, never real quantities — a notch per
// cook is the honest granularity we have.

export interface IngredientInput {
  food_item_id: string;
  qty?: number | null;
  unit?: string | null;
  optional?: boolean;
}

export interface RecipeInput {
  name: string;
  source_url?: string | null;
  notes?: string | null;
  ingredients: IngredientInput[];
}

export interface RecipeWithIngredients extends Recipe {
  ingredients: (RecipeIngredient & {
    name: string;
    is_discrete: boolean;
    state: InventoryState | null;
    missing: boolean;
  })[];
  missing_count: number; // non-optional ingredients you're out of (or too few of)
  ready: boolean;
}

export function createRecipe(
  db: DB,
  household_id: string,
  input: RecipeInput
): { ok: true; recipe: RecipeWithIngredients } | { ok: false; error: string } {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: "recipe name required" };
  if (!input.ingredients?.length) return { ok: false, error: "at least one ingredient required" };

  // Explicit pre-checks so every failure gets an accurate message — constraint-error
  // sniffing can't tell a duplicate NAME from a duplicate INGREDIENT (both say UNIQUE).
  const seen = new Set<string>();
  for (const ing of input.ingredients) {
    if (!getFoodItem(db, household_id, ing.food_item_id)) {
      return { ok: false, error: `unknown food item: ${ing.food_item_id}` };
    }
    if (seen.has(ing.food_item_id)) {
      return { ok: false, error: "an ingredient appears twice — each item once per recipe" };
    }
    seen.add(ing.food_item_id);
  }
  const dup = db
    .prepare(`SELECT id FROM recipe WHERE household_id = ? AND name = ?`)
    .get(household_id, name);
  if (dup) return { ok: false, error: "a recipe with that name exists" };

  const rid = id("rc");
  tx(db, () => {
    db.prepare(
      `INSERT INTO recipe (id, household_id, name, source_url, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(rid, household_id, name, input.source_url ?? null, input.notes ?? null, nowIso());
    const ins = db.prepare(
      `INSERT INTO recipe_ingredient (recipe_id, food_item_id, qty, unit, optional)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const ing of input.ingredients) {
      ins.run(rid, ing.food_item_id, ing.qty ?? null, ing.unit ?? null, ing.optional ? 1 : 0);
    }
  });
  return { ok: true, recipe: getRecipe(db, household_id, rid)! };
}

export function getRecipe(db: DB, household_id: string, recipe_id: string): RecipeWithIngredients | null {
  const r = db
    .prepare(`SELECT * FROM recipe WHERE household_id = ? AND id = ?`)
    .get(household_id, recipe_id) as Recipe | undefined;
  if (!r) return null;
  return decorate(db, household_id, r);
}

export function listRecipes(db: DB, household_id: string): RecipeWithIngredients[] {
  const rows = db
    .prepare(`SELECT * FROM recipe WHERE household_id = ? ORDER BY name`)
    .all(household_id) as unknown as Recipe[];
  return rows.map((r) => decorate(db, household_id, r));
}

interface IngredientJoinRow {
  recipe_id: string;
  food_item_id: string;
  qty: number | null;
  unit: string | null;
  optional: number; // SQLite integer boolean
  name: string | null;
  is_discrete: number | null;
  bucket: string | null;
  count: number | null;
}

function decorate(db: DB, household_id: string, r: Recipe): RecipeWithIngredients {
  // One joined query per recipe (ingredients + item + inventory) instead of two point
  // queries per ingredient — the recipe list stays flat, not N+1.
  const ingRows = db
    .prepare(
      `SELECT ri.recipe_id, ri.food_item_id, ri.qty, ri.unit, ri.optional,
              fi.name, fi.is_discrete, inv.bucket, inv.count
       FROM recipe_ingredient ri
       LEFT JOIN food_item fi ON fi.id = ri.food_item_id AND fi.household_id = ?
       LEFT JOIN inventory inv ON inv.food_item_id = ri.food_item_id AND inv.household_id = ?
       WHERE ri.recipe_id = ?`
    )
    .all(household_id, household_id, r.id) as unknown as IngredientJoinRow[];

  const ingredients = ingRows.map((row) => {
    const state: InventoryState | null =
      row.count !== null
        ? { kind: "count", count: row.count }
        : row.bucket !== null
          ? { kind: "bucket", bucket: row.bucket as Bucket }
          : null;
    // "Missing" = can I COOK with what's recorded (discrete below the needed qty, bulk
    // at "out"). Deliberately different from the engine's shortfall threshold, which
    // answers "should I REBUY" (count <= reorder_point, bucket low-or-out): a bulk item
    // at "low" is still cookable while it's already on the buy list. Both thresholds
    // are coarse on purpose — estimates, never asserted as truth.
    const needed = row.qty ?? 1;
    const missing =
      !state || (state.kind === "count" ? state.count < needed : state.bucket === "out");
    return {
      recipe_id: row.recipe_id,
      food_item_id: row.food_item_id,
      qty: row.qty,
      unit: row.unit,
      optional: !!row.optional,
      name: row.name ?? "(deleted item)",
      is_discrete: !!row.is_discrete,
      state,
      missing,
    };
  });

  const missing_count = ingredients.filter((i) => i.missing && !i.optional).length;
  return { ...r, ingredients, missing_count, ready: missing_count === 0 };
}

// "I made this" — deplete every linked ingredient through the event log (source: cook).
// Optional ingredients deplete only if there's something recorded to deplete.
export function cookRecipe(
  db: DB,
  household_id: string,
  recipe_id: string
): { ok: true; depleted: { food_item_id: string; name: string }[] } | { ok: false; error: string } {
  const recipe = getRecipe(db, household_id, recipe_id);
  if (!recipe) return { ok: false, error: "unknown recipe" };

  const depleted: { food_item_id: string; name: string }[] = [];
  tx(db, () => {
    for (const ing of recipe.ingredients) {
      if (!ing.state) continue; // nothing recorded — nothing to deplete
      if (ing.state.kind === "count") {
        if (ing.optional && ing.state.count === 0) continue;
        applyCountDelta(db, household_id, ing.food_item_id, -(ing.qty ?? 1), "cook", {
          recipe_id,
          recipe_name: recipe.name,
        });
      } else {
        if (ing.state.bucket === "out") continue; // already out — nothing to step down
        setBucket(db, household_id, ing.food_item_id, stepDownBucket(ing.state.bucket), "cook", {
          recipe_id,
          recipe_name: recipe.name,
        });
      }
      depleted.push({ food_item_id: ing.food_item_id, name: ing.name });
    }
  });
  return { ok: true, depleted };
}

export function deleteRecipe(db: DB, household_id: string, recipe_id: string): { ok: boolean } {
  // ON DELETE CASCADE removes the ingredient links.
  const r = db
    .prepare(`DELETE FROM recipe WHERE household_id = ? AND id = ?`)
    .run(household_id, recipe_id);
  return { ok: r.changes > 0 };
}

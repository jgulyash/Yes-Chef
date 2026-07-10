import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { SCHEMA, migrate, MIGRATIONS } from "../src/db.js";
import { seed, loadStaples, DEFAULT_HOUSEHOLD } from "../src/seed.js";
import { buildServer } from "../src/server.js";
import { freshDb, itemId, FIXTURE_STAPLES, HH } from "./helpers.js";

// ---------------------------------------------------------------------------------
// Phase B: migration chain (v2 stores, v3 food_item rebuild, v4 recipes) + the new
// stores / item-detail / recipes API surface.
// ---------------------------------------------------------------------------------

describe("migration chain v1 -> v4", () => {
  it("upgrades a POPULATED v1 database preserving every food item and its values", () => {
    // Simulate a real pre-Phase-B database: v1 schema, v1-shaped data inserted with raw
    // SQL (seed() can't be used here — it auto-migrates to the latest version).
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO schema_migrations VALUES (1, 'stage-1 baseline schema', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO household (id, name) VALUES (?, 'Home')`).run(HH);
    const staples = loadStaples(FIXTURE_STAPLES);
    const insItem = db.prepare(
      `INSERT INTO food_item (id, household_id, name, zone, is_discrete, par, reorder_point, consumption_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insInv = db.prepare(
      `INSERT INTO inventory (household_id, food_item_id, bucket, count, updated_at) VALUES (?, ?, ?, ?, ?)`
    );
    staples.forEach((s, i) => {
      const fid = `fi_v1_${i}`;
      insItem.run(fid, HH, s.name, s.zone, s.is_discrete ? 1 : 0, s.par, s.reorder_point, s.consumption_rate);
      insInv.run(HH, fid, s.is_discrete ? null : "full", s.is_discrete ? 5 : null, "2026-01-01T00:00:00Z");
    });

    const before = db
      .prepare(`SELECT id, name, zone, par, reorder_point FROM food_item ORDER BY id`)
      .all() as { id: string; name: string; zone: string; par: number; reorder_point: number }[];
    expect(before.length).toBe(30);

    const applied = migrate(db);
    expect(applied).toBe(MIGRATIONS.length - 1); // everything after v1

    const after = db
      .prepare(`SELECT id, name, zone, par, reorder_point, store_id, brand FROM food_item ORDER BY id`)
      .all() as (typeof before)[number] & { store_id: string | null; brand: string | null }[];
    expect(after.length).toBe(30);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toMatchObject(before[i]); // values survive the rebuild
      expect((after[i] as { store_id: string | null }).store_id).toBeNull();
    }
    // FK integrity intact after the rebuild (inventory/alias/event still reference items).
    expect(db.prepare("PRAGMA foreign_key_check").all().length).toBe(0);
  });

  it("accepts deep_freezer as a zone after v3 and rejects unknown zones", () => {
    const db = freshDb();
    const eggs = itemId(db, "Eggs");
    db.prepare(`UPDATE food_item SET zone = 'deep_freezer' WHERE id = ?`).run(eggs);
    expect(() =>
      db.prepare(`UPDATE food_item SET zone = 'garage' WHERE id = ?`).run(eggs)
    ).toThrow();
  });
});

describe("item add + remove (soft, household-worded)", () => {
  let db: DatabaseSync;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = freshDb();
    app = await buildServer(db);
  });
  afterEach(async () => {
    await app.close();
  });

  it("creates a new item with inventory and a working alias", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/items",
      payload: { name: "Hot sauce", zone: "pantry", is_discrete: false, par: 1, reorder_point: 0, init: "full" },
    });
    expect(res.statusCode).toBe(200);
    const items = (await app.inject({ method: "GET", url: "/api/items" })).json();
    expect(items.find((i: { name: string }) => i.name === "Hot sauce").inventory).toEqual({ kind: "bucket", bucket: "full" });
    // canonical alias resolves immediately
    const qa = await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "hot sauce", level: "low" } });
    expect(qa.statusCode).toBe(200);
  });

  it("validates create input", async () => {
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/items", payload });
    expect((await post({ zone: "pantry" })).statusCode).toBe(400); // no name
    expect((await post({ name: "X", zone: "garage", is_discrete: true, par: 1, reorder_point: 0 })).statusCode).toBe(400);
    expect((await post({ name: "X", zone: "pantry", is_discrete: true, par: -1, reorder_point: 0 })).statusCode).toBe(400);
    expect((await post({ name: "Eggs", zone: "pantry", is_discrete: true, par: 1, reorder_point: 0 })).statusCode).toBe(400); // active dup
  });

  it("remove hides the item everywhere and its aliases stop matching", async () => {
    const eggs = itemId(db, "Eggs");
    // drive to shortfall first so we can confirm it disappears from there too
    await app.inject({ method: "POST", url: `/api/items/${eggs}/state`, payload: { count: 0 } });
    expect((await app.inject({ method: "DELETE", url: `/api/items/${eggs}` })).statusCode).toBe(200);

    const items = (await app.inject({ method: "GET", url: "/api/items" })).json();
    expect(items.some((i: { id: string }) => i.id === eggs)).toBe(false);
    const shortfall = (await app.inject({ method: "GET", url: "/api/shortfall" })).json();
    expect(shortfall.some((s: { food_item_id: string }) => s.food_item_id === eggs)).toBe(false);
    // alias no longer matches -> review queue instead of crediting an invisible item
    const qa = await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "eggs" } });
    expect(qa.statusCode).toBe(202);
    // state posts and PATCH now 404
    expect((await app.inject({ method: "POST", url: `/api/items/${eggs}/state`, payload: { count: 5 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/items/${eggs}`, payload: { brand: "X" } })).statusCode).toBe(404);
    // second remove 404s (already gone)
    expect((await app.inject({ method: "DELETE", url: `/api/items/${eggs}` })).statusCode).toBe(404);
  });

  it("re-adding a removed item's name brings it back with history intact", async () => {
    const eggs = itemId(db, "Eggs");
    await app.inject({ method: "POST", url: `/api/items/${eggs}/state`, payload: { count: 7 } }); // creates an event
    await app.inject({ method: "DELETE", url: `/api/items/${eggs}` });

    const res = await app.inject({ method: "POST", url: "/api/items", payload: { name: "Eggs" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toBe(true);
    expect(res.json().id).toBe(eggs); // same row, same history
    const events = db.prepare(`SELECT COUNT(*) c FROM event WHERE food_item_id = ?`).get(eggs) as { c: number };
    expect(events.c).toBeGreaterThan(0);
    // alias works again
    const qa = await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "eggs", level: "low" } });
    expect(qa.statusCode).toBe(200);
  });

  it("recipes still show a removed ingredient's name", async () => {
    const eggs = itemId(db, "Eggs");
    await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { name: "Omelet", ingredients: [{ food_item_id: eggs, qty: 2 }] },
    });
    await app.inject({ method: "DELETE", url: `/api/items/${eggs}` });
    const recipes = (await app.inject({ method: "GET", url: "/api/recipes" })).json();
    expect(recipes[0].ingredients[0].name).toBe("Eggs");
  });
});

describe("stores API", () => {
  let db: DatabaseSync;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = freshDb();
    app = await buildServer(db);
  });
  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });

  it("creates, lists (sorted), patches, and soft-deletes stores", async () => {
    const a = await post("/api/stores", { name: "Acme Club", kind: "warehouse" });
    expect(a.statusCode).toBe(200);
    const b = await post("/api/stores", { name: "Amazon", kind: "online" });
    const amazonId = b.json().id;

    let list = (await app.inject({ method: "GET", url: "/api/stores" })).json();
    expect(list.map((s: { name: string }) => s.name)).toEqual(["Acme Club", "Amazon"]); // sort_order

    await app.inject({ method: "PATCH", url: `/api/stores/${amazonId}`, payload: { name: "Amazon Fresh" } });
    await app.inject({ method: "DELETE", url: `/api/stores/${amazonId}` });

    list = (await app.inject({ method: "GET", url: "/api/stores" })).json();
    expect(list.length).toBe(1); // soft-deleted store hidden
    const all = (await app.inject({ method: "GET", url: "/api/stores?all=1" })).json();
    expect(all.length).toBe(2); // but not gone
    expect(all.find((s: { id: string }) => s.id === amazonId).name).toBe("Amazon Fresh");
  });

  it("400s a store with no name", async () => {
    expect((await post("/api/stores", {})).statusCode).toBe(400);
  });

  // Review regressions: constraint violations must be friendly 400s, never 500s.
  it("400s (not 500s) a duplicate store name on create", async () => {
    await post("/api/stores", { name: "Acme Club" });
    const res = await post("/api/stores", { name: "Acme Club" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/exists/);
  });

  it("400s an invalid kind or order_method instead of crashing into the CHECK", async () => {
    expect((await post("/api/stores", { name: "X", kind: "supermarket" })).statusCode).toBe(400);
    const s = (await post("/api/stores", { name: "Y" })).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/stores/${s.id}`,
      payload: { order_method: "shipping" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("trims names on rename so ' Acme Club ' can't dodge the duplicate guard", async () => {
    await post("/api/stores", { name: "Acme Club" });
    const s = (await post("/api/stores", { name: "Temp" })).json();
    const dup = await app.inject({
      method: "PATCH",
      url: `/api/stores/${s.id}`,
      payload: { name: " Acme Club " },
    });
    expect(dup.statusCode).toBe(400); // trimmed match hits the duplicate pre-check
  });
});

describe("item detail PATCH", () => {
  let db: DatabaseSync;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = freshDb();
    app = await buildServer(db);
  });
  afterEach(async () => {
    await app.close();
  });

  it("writes store assignment + detail fields and they flow through GET /api/items and shortfall", async () => {
    const store = (
      await app.inject({ method: "POST", url: "/api/stores", payload: { name: "Acme Club" } })
    ).json();
    const eggs = itemId(db, "Eggs");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/items/${eggs}`,
      payload: { store_id: store.id, brand: "House-brand", package_size: "24 ct" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ store_id: store.id, brand: "House-brand", package_size: "24 ct" });

    const items = (await app.inject({ method: "GET", url: "/api/items" })).json();
    expect(items.find((i: { id: string }) => i.id === eggs).brand).toBe("House-brand");

    // Drive eggs to shortfall; the row carries store metadata for By-Store grouping.
    await app.inject({ method: "POST", url: `/api/items/${eggs}/state`, payload: { count: 4 } });
    const shortfall = (await app.inject({ method: "GET", url: "/api/shortfall" })).json();
    const row = shortfall.find((s: { food_item_id: string }) => s.food_item_id === eggs);
    expect(row.store_id).toBe(store.id);
    expect(row.store_name).toBe("Acme Club");
  });

  it("validates zone and store_id; 404s unknown items", async () => {
    const eggs = itemId(db, "Eggs");
    expect(
      (await app.inject({ method: "PATCH", url: `/api/items/${eggs}`, payload: { zone: "garage" } })).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/items/${eggs}`, payload: { store_id: "st_nope" } })).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/items/${eggs}`, payload: { zone: "deep_freezer" } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/items/fi_nope", payload: { brand: "X" } })).statusCode
    ).toBe(404);
  });

  // Review regressions: the numbers feeding reorder/prediction math must be real and
  // non-negative, and hidden stores can't take new assignments.
  it("rejects non-numeric, NaN-ish, and negative tuning values", async () => {
    const eggs = itemId(db, "Eggs");
    const patch = (payload: object) =>
      app.inject({ method: "PATCH", url: `/api/items/${eggs}`, payload });
    expect((await patch({ consumption_rate: "fast" })).statusCode).toBe(400);
    expect((await patch({ reorder_point: -1 })).statusCode).toBe(400);
    expect((await patch({ par: -5 })).statusCode).toBe(400);
    expect((await patch({ consumption_rate: null })).statusCode).toBe(200); // unknown rate ok
    expect((await patch({ consumption_rate: 0.5 })).statusCode).toBe(200);
  });

  it("rejects assignment to a soft-deleted store", async () => {
    const store = (
      await app.inject({ method: "POST", url: "/api/stores", payload: { name: "Ghost Mart" } })
    ).json();
    await app.inject({ method: "DELETE", url: `/api/stores/${store.id}` });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/items/${itemId(db, "Eggs")}`,
      payload: { store_id: store.id },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("recipes", () => {
  let db: DatabaseSync;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = freshDb();
    app = await buildServer(db);
  });
  afterEach(async () => {
    await app.close();
  });

  const makeRecipe = async () =>
    (
      await app.inject({
        method: "POST",
        url: "/api/recipes",
        payload: {
          name: "Scrambled eggs & rice",
          ingredients: [
            { food_item_id: itemId(db, "Eggs"), qty: 3 },
            { food_item_id: itemId(db, "White rice") }, // bulk
            { food_item_id: itemId(db, "Bell peppers"), qty: 1, optional: true },
          ],
        },
      })
    ).json();

  it("creates and lists a recipe with readiness", async () => {
    await makeRecipe();
    const list = (await app.inject({ method: "GET", url: "/api/recipes" })).json();
    expect(list.length).toBe(1);
    expect(list[0].ready).toBe(true); // fixture seeds everything at par
    expect(list[0].ingredients.length).toBe(3);
  });

  it("rejects a recipe with an unknown ingredient", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { name: "Mystery", ingredients: [{ food_item_id: "fi_nope" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("'I made this' depletes discrete by qty and steps bulk down one bucket notch via cook events", async () => {
    const recipe = await makeRecipe();
    const eggs = itemId(db, "Eggs");
    const rice = itemId(db, "White rice");

    const res = await app.inject({ method: "POST", url: `/api/recipes/${recipe.id}/made` });
    expect(res.statusCode).toBe(200);
    expect(res.json().depleted.length).toBe(3);

    const items = (await app.inject({ method: "GET", url: "/api/items" })).json();
    expect(items.find((i: { id: string }) => i.id === eggs).inventory).toEqual({ kind: "count", count: 9 }); // 12 - 3
    expect(items.find((i: { id: string }) => i.id === rice).inventory).toEqual({ kind: "bucket", bucket: "half" }); // full -> half

    const cookEvents = db
      .prepare(`SELECT * FROM event WHERE source = 'cook' AND household_id = ?`)
      .all(DEFAULT_HOUSEHOLD);
    expect(cookEvents.length).toBe(3);
  });

  it("optional ingredients never block readiness", async () => {
    const recipe = await makeRecipe();
    // Deplete the optional bell peppers to zero.
    await app.inject({
      method: "POST",
      url: `/api/items/${itemId(db, "Bell peppers")}/state`,
      payload: { count: 0 },
    });
    const got = (await app.inject({ method: "GET", url: `/api/recipes/${recipe.id}` })).json();
    expect(got.ready).toBe(true);
    expect(got.ingredients.find((i: { optional: boolean }) => i.optional).missing).toBe(true);
  });

  // Review regressions: accurate error for duplicate ingredients; clamped cook
  // depletion logs the ACTUAL change, not the requested one.
  it("rejects a duplicate ingredient with an accurate message (not 'name exists')", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: {
        name: "Double eggs",
        ingredients: [
          { food_item_id: itemId(db, "Eggs"), qty: 2 },
          { food_item_id: itemId(db, "Eggs"), qty: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ingredient/);
    expect(res.json().error).not.toMatch(/name/);
  });

  it("logs the clamped actual delta when cooking more than is on hand", async () => {
    const eggs = itemId(db, "Eggs");
    await app.inject({ method: "POST", url: `/api/items/${eggs}/state`, payload: { count: 1 } });
    const recipe = (
      await app.inject({
        method: "POST",
        url: "/api/recipes",
        payload: { name: "Big omelet", ingredients: [{ food_item_id: eggs, qty: 3 }] },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/recipes/${recipe.id}/made` });

    const ev = db
      .prepare(`SELECT delta FROM event WHERE source = 'cook' AND food_item_id = ?`)
      .get(eggs) as { delta: number };
    expect(ev.delta).toBe(-1); // had 1, requested -3, actual change is -1
    const items = (await app.inject({ method: "GET", url: "/api/items" })).json();
    expect(items.find((i: { id: string }) => i.id === eggs).inventory).toEqual({ kind: "count", count: 0 });
  });

  it("delete removes the recipe and its ingredient links", async () => {
    const recipe = await makeRecipe();
    const res = await app.inject({ method: "DELETE", url: `/api/recipes/${recipe.id}` });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/recipes" })).json().length).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM recipe_ingredient`).get()).toMatchObject({ c: 0 });
  });
});

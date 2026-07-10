import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { freshDb, itemId, HH } from "./helpers.js";
import type { DatabaseSync } from "node:sqlite";

// HTTP-layer tests: a fresh in-memory DB per test, driven through fastify.inject()
// (no port, no network). Domain logic has its own tests — these cover the wiring:
// status codes, validation guards, and request→response shapes.

let db: DatabaseSync;
let app: FastifyInstance;

beforeEach(async () => {
  db = freshDb();
  app = await buildServer(db);
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/items", () => {
  it("returns all staples with their inventory state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/items" });
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items.length).toBe(30);
    const eggs = items.find((i: { name: string }) => i.name === "Eggs");
    expect(eggs.inventory).toEqual({ kind: "count", count: 12 });
  });
});

describe("POST /api/items/:id/state", () => {
  it("404s on an unknown item", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/items/fi_nope/state",
      payload: { count: 3 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when a discrete item gets no count", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/items/${itemId(db, "Eggs")}/state`,
      payload: { bucket: "low" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sets a discrete count and echoes the new state", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/items/${itemId(db, "Eggs")}/state`,
      payload: { count: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inventory).toEqual({ kind: "count", count: 4 });
  });

  it("sets a bulk bucket", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/items/${itemId(db, "Whole milk")}/state`,
      payload: { bucket: "low" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inventory).toEqual({ kind: "bucket", bucket: "low" });
  });
});

describe("GET /api/shortfall", () => {
  it("includes an item driven to its reorder point", async () => {
    await app.inject({
      method: "POST",
      url: `/api/items/${itemId(db, "Eggs")}/state`,
      payload: { count: 4 }, // reorder point for Eggs in the sample data
    });
    const res = await app.inject({ method: "GET", url: "/api/shortfall" });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((s: { name: string }) => s.name);
    expect(names).toContain("Eggs");
  });
});

describe("POST /api/quickadd", () => {
  it("400s without text", async () => {
    const res = await app.inject({ method: "POST", url: "/api/quickadd", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("200s on a known alias and applies the level", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quickadd",
      payload: { text: "milk", level: "out" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().food_item_id).toBe(itemId(db, "Whole milk"));
  });

  it("202s an unknown mention into the review queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quickadd",
      payload: { text: "dragonfruit syrup" },
    });
    expect(res.statusCode).toBe(202);
    const queue = (await app.inject({ method: "GET", url: "/api/unmatched" })).json();
    expect(queue.some((m: { raw_text: string }) => m.raw_text === "dragonfruit syrup")).toBe(true);
  });
});

describe("POST /api/receipt", () => {
  it("400s without lines", async () => {
    const res = await app.inject({ method: "POST", url: "/api/receipt", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("applies matched lines and queues unmatched ones", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/receipt",
      payload: { lines: [{ raw_text: "eggs", qty: 12 }, { raw_text: "yuzu paste", qty: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied.length).toBe(1);
    expect(body.unmatched.length).toBe(1);
  });
});

describe("unmatched queue round-trip", () => {
  it("resolve learns the alias and empties the queue entry", async () => {
    await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "green onions" } });
    const [mention] = (await app.inject({ method: "GET", url: "/api/unmatched" })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/unmatched/${mention.id}/resolve`,
      payload: { food_item_id: itemId(db, "Onions") },
    });
    expect(res.statusCode).toBe(200);
    // Learned: the same text now resolves directly (200, not 202).
    const again = await app.inject({
      method: "POST",
      url: "/api/quickadd",
      payload: { text: "green onions" },
    });
    expect(again.statusCode).toBe(200);
  });

  it("ignore drops the mention", async () => {
    await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "mystery jar" } });
    const [mention] = (await app.inject({ method: "GET", url: "/api/unmatched" })).json();
    await app.inject({ method: "POST", url: `/api/unmatched/${mention.id}/ignore` });
    const queue = (await app.inject({ method: "GET", url: "/api/unmatched" })).json();
    expect(queue.length).toBe(0);
  });
});

describe("feedback → metrics", () => {
  it("missed_runout is recorded and surfaces in recall", async () => {
    const eggs = itemId(db, "Eggs");
    await app.inject({
      method: "POST",
      url: "/api/shortfall/feedback",
      payload: { food_item_id: eggs, predicted: false, verdict: "missed_runout" },
    });
    await app.inject({
      method: "POST",
      url: "/api/shortfall/feedback",
      payload: { food_item_id: itemId(db, "Whole milk"), predicted: true, verdict: "confirmed_needed" },
    });
    const m = (await app.inject({ method: "GET", url: "/api/metrics" })).json();
    expect(m.counts.missed_runout).toBe(1);
    expect(m.counts.confirmed_needed).toBe(1);
    expect(m.recall).toBeCloseTo(0.5); // 1 caught / (1 caught + 1 missed)
  });

  it("400s without a verdict", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shortfall/feedback",
      payload: { food_item_id: itemId(db, "Eggs") },
    });
    expect(res.statusCode).toBe(400);
  });
});

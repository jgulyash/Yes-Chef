import { describe, it, expect } from "vitest";
import { freshDb, HH, itemId } from "./helpers.js";
import {
  discreteTriggered,
  bulkTriggered,
  isShortfall,
  computeShortfall,
} from "../src/engine.js";
import { setCount, setBucket, getFoodItem, getInventory } from "../src/inventory.js";
import { predictShortfall, predictState } from "../src/prediction.js";
import { nowIso } from "../src/util.js";

describe("reorder engine — trigger logic (bucket + count)", () => {
  it("discrete trigger fires at and below the reorder point, not above", () => {
    expect(discreteTriggered(5, 4)).toBe(false); // above
    expect(discreteTriggered(4, 4)).toBe(true); // at boundary
    expect(discreteTriggered(3, 4)).toBe(true); // below
    expect(discreteTriggered(0, 4)).toBe(true); // empty
  });

  it("bulk trigger fires only on low/out", () => {
    expect(bulkTriggered("full")).toBe(false);
    expect(bulkTriggered("half")).toBe(false);
    expect(bulkTriggered("low")).toBe(true);
    expect(bulkTriggered("out")).toBe(true);
  });

  it("isShortfall uses count for discrete and bucket for bulk", () => {
    const db = freshDb();
    const eggs = getFoodItem(db, HH, itemId(db, "Eggs"))!; // discrete, reorder 4
    const milk = getFoodItem(db, HH, itemId(db, "Whole milk"))!; // bulk

    expect(isShortfall(eggs, { kind: "count", count: 4 })).toBe(true);
    expect(isShortfall(eggs, { kind: "count", count: 5 })).toBe(false);
    expect(isShortfall(milk, { kind: "bucket", bucket: "low" })).toBe(true);
    expect(isShortfall(milk, { kind: "bucket", bucket: "half" })).toBe(false);
  });
});

describe("reorder engine — shortfall list", () => {
  it("seeded-at-par kitchen has no hard shortfall", () => {
    const db = freshDb();
    const list = computeShortfall(db, HH); // recorded triggers only
    expect(list.length).toBe(0);
  });

  it("flags a discrete item dropped to its reorder point and a bulk item set low", () => {
    const db = freshDb();
    setCount(db, HH, itemId(db, "Eggs"), 4, "manual");
    setBucket(db, HH, itemId(db, "Olive oil"), "out", "manual");

    const list = computeShortfall(db, HH);
    const names = list.map((r) => r.name).sort();
    expect(names).toContain("Eggs");
    expect(names).toContain("Olive oil");
    expect(list.every((r) => r.confidence === "high")).toBe(true);
    // discrete need reorders up to par (12 - 4 = 8)
    const eggs = list.find((r) => r.name === "Eggs")!;
    expect(eggs.need).toContain("8");
  });
});

describe("predicted depletion — proposes, never asserts", () => {
  it("does not fire on a freshly recorded count (no false day-0 trigger)", () => {
    const db = freshDb();
    // Bread: count 2, reorder 1, rate 0.15/day. At ~0 days it must NOT predict.
    const predicted = predictShortfall(db, HH, nowIso());
    expect(predicted.find((r) => r.name === "Bread")).toBeUndefined();
  });

  it("predicts a discrete crossing once enough time passes, flagged confirm?", () => {
    const db = freshDb();
    const bread = getFoodItem(db, HH, itemId(db, "Bread"))!; // count 2, reorder 1, rate 0.15
    const inv = getInventory(db, HH, bread.id)!;

    // ~10 days later: 2 - 0.15*10 = 0.5 <= 1 -> crosses.
    const future = new Date(Date.now() + 10 * 86400_000).toISOString();
    const p = predictState(bread, inv.state, inv.updated_at, future);
    expect(p.crosses_reorder).toBe(true);

    const list = predictShortfall(db, HH, future);
    const row = list.find((r) => r.name === "Bread")!;
    expect(row).toBeDefined();
    expect(row.predicted).toBe(true);
    expect(row.confidence).toBe("confirm?");
  });

  it("predicted item does not change recorded inventory", () => {
    const db = freshDb();
    const breadId = itemId(db, "Bread");
    const before = getInventory(db, HH, breadId)!.state;
    const future = new Date(Date.now() + 30 * 86400_000).toISOString();
    predictShortfall(db, HH, future);
    const after = getInventory(db, HH, breadId)!.state;
    expect(after).toEqual(before); // estimate only — stock untouched
  });

  it("predicts a bulk bucket crossing (full -> low) over time", () => {
    const db = freshDb();
    const milk = getFoodItem(db, HH, itemId(db, "Whole milk"))!; // full, rate 0.2/day
    const inv = getInventory(db, HH, milk.id)!;
    // 4 days: 1.0 - 0.2*4 = 0.2 -> "low"
    const future = new Date(Date.now() + 4 * 86400_000).toISOString();
    const p = predictState(milk, inv.state, inv.updated_at, future);
    expect(p.predicted_state).toEqual({ kind: "bucket", bucket: "low" });
    expect(p.crosses_reorder).toBe(true);
  });
});

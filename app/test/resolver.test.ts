import { describe, it, expect } from "vitest";
import { freshDb, HH, itemId } from "./helpers.js";
import { normalize, resolve } from "../src/resolver.js";
import { quickAdd, parseIntent } from "../src/quickadd.js";
import { ingestReceipt, listUnmatched, resolveUnmatched } from "../src/receipt.js";

function foodItemCount(db: ReturnType<typeof freshDb>): number {
  return (db.prepare(`SELECT COUNT(*) c FROM food_item WHERE household_id = ?`).get(HH) as { c: number }).c;
}

describe("normalize (cascade step 1)", () => {
  it("lowercases, strips sizes/units/pack-counts, expands abbreviations, drops store prefixes", () => {
    expect(normalize("HORIZON ORG WHL MILK HG 64OZ")).toBe("horizon organic whole milk");
    expect(normalize("2 Large Eggs")).toBe("large eggs");
    expect(normalize("TJ's seasonal squash blend")).toBe("seasonal squash blend");
    expect(normalize("Olive Oil 16.9 fl oz")).toBe("olive oil");
  });
});

describe("resolver cascade (steps 2-3)", () => {
  it("exact-alias hit resolves to a FoodItem with high confidence", () => {
    const db = freshDb();
    const r = resolve(db, HH, "whl milk", "receipt");
    expect(r.food_item_id).toBe(itemId(db, "Whole milk"));
    expect(r.method).toBe("exact_alias");
    expect(r.needs_review).toBe(false);
  });

  it("unknown mention routes to unmatched (needs_review), resolves to null", () => {
    const db = freshDb();
    const r = resolve(db, HH, "dragon fruit", "receipt");
    expect(r.food_item_id).toBeNull();
    expect(r.needs_review).toBe(true);
    expect(r.method).toBe("unmatched");
  });
});

describe("no-silent-create (the load-bearing rule)", () => {
  it("an unknown receipt line never creates a FoodItem — it queues for review", () => {
    const db = freshDb();
    const before = foodItemCount(db);
    const res = ingestReceipt(db, HH, [{ raw_text: "exotic durian paste", qty: 1 }]);
    expect(foodItemCount(db)).toBe(before); // nothing created
    expect(res.applied.length).toBe(0);
    expect(res.unmatched.length).toBe(1);
    expect(listUnmatched(db, HH).some((m) => m.raw_text === "exotic durian paste")).toBe(true);
  });

  it("an unknown quick-add never creates a FoodItem — it queues for review", () => {
    const db = freshDb();
    const before = foodItemCount(db);
    const r = quickAdd(db, HH, "out of dragon fruit", "out");
    expect(r.needs_review).toBe(true);
    expect(r.food_item_id).toBeNull();
    expect(foodItemCount(db)).toBe(before);
  });
});

describe("anti-fork (the single most important test)", () => {
  it("the same physical item via receipt and via quick-add resolves to ONE food_item_id", () => {
    const db = freshDb();
    // Receipt OCR line and a spoken quick-add for the same food.
    const viaReceipt = resolve(db, HH, "whl milk", "receipt").food_item_id;
    const viaQuickAdd = resolve(db, HH, parseIntent("we're out of milk").noun, "quickadd").food_item_id;
    expect(viaReceipt).not.toBeNull();
    expect(viaReceipt).toBe(viaQuickAdd);
    expect(viaReceipt).toBe(itemId(db, "Whole milk"));
  });

  it("learning from one source benefits all sources (still one id)", () => {
    const db = freshDb();
    // 'moo juice' is unknown to both sources initially.
    expect(resolve(db, HH, "moo juice", "receipt").food_item_id).toBeNull();

    // A receipt line queues it; the human resolves it to Whole milk.
    const res = ingestReceipt(db, HH, [{ raw_text: "moo juice", qty: 1 }]);
    const mentionId = res.unmatched[0].unmatched_id;
    const r = resolveUnmatched(db, HH, mentionId, itemId(db, "Whole milk"));
    expect(r.ok).toBe(true);

    // Now BOTH sources resolve 'moo juice' to the same single id — no fork.
    const fromReceipt = resolve(db, HH, "moo juice", "receipt").food_item_id;
    const fromQuickAdd = resolve(db, HH, "moo juice", "quickadd").food_item_id;
    expect(fromReceipt).toBe(itemId(db, "Whole milk"));
    expect(fromQuickAdd).toBe(itemId(db, "Whole milk"));
  });
});

describe("feedback loop (confirm-to-learn)", () => {
  it("resolving an unmatched mention learns an alias so it never asks again", () => {
    const db = freshDb();
    quickAdd(db, HH, "low on scallions", "low");
    const pending = listUnmatched(db, HH);
    const m = pending.find((x) => x.raw_text.includes("scallion"))!;
    expect(m).toBeDefined();

    resolveUnmatched(db, HH, m.id, itemId(db, "Onions"));
    // Same surface form now resolves directly.
    expect(resolve(db, HH, "scallions", "quickadd").food_item_id).toBe(itemId(db, "Onions"));
    // And it is no longer pending.
    expect(listUnmatched(db, HH).some((x) => x.id === m.id)).toBe(false);
  });
});

describe("receipt post-delivery semantics", () => {
  it("refunded lines are not credited; delivered/substituted lines are", () => {
    const db = freshDb();
    const res = ingestReceipt(db, HH, [
      { raw_text: "large eggs", qty: 6, status: "delivered" },
      { raw_text: "fresh basil", qty: 1, status: "refunded" },
      { raw_text: "oat milk", qty: 1, status: "substituted" }, // unknown food -> queue
    ]);
    expect(res.applied.map((a) => a.name)).toContain("Eggs");
    expect(res.refunded.length).toBe(1);
    // oat milk is a genuinely different food item -> not silently merged into milk
    expect(res.unmatched.some((u) => u.raw_text === "oat milk")).toBe(true);
  });
});

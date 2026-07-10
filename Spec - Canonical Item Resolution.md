# Spec — Canonical Item Resolution

*One of the core specs behind Yes Chef!. This is the
highest-leverage open item from the red-team: without it, the four capture pipelines
update **different** records for the same food and inventory silently forks, which is the
root cause of the "perpetually empty → over-order" loop.*

---

## 1. The problem in one picture

Four pipelines describe the same carton of milk four different ways:

| Source | Raw mention |
|---|---|
| Vision (frame) | `"carton"`, label crop reads `"Horizon Organic Whole"` |
| Narration (speech) | `"milk is low"` |
| Receipt OCR | `"HORIZON ORG WHL MILK HG 64OZ"` |
| Recipe ingredient | `"1 cup whole milk"` |

All four must resolve to **one** internal entity. If they don't, cook-to-deplete
subtracts from `recipe:whole-milk` while the receipt increments `receipt:horizon-64oz`
and the count for "milk" is never right. **Resolution is the subsystem that guarantees
one truth.**

---

## 2. The model: Food Item vs. Product (the granularity rule)

Two distinct entities, and getting the line between them right is the whole game.

- **Food Item** — the thing you plan meals and set par levels against; the unit of
  *inventory*. Interchangeable instances collapse here. `whole-milk` is one Food Item
  regardless of brand.
- **Product** — a specific buyable SKU under a Food Item; the unit of *ordering*. Brand,
  size, UPC, store, price. `Horizon Organic Whole Milk 64oz @ StoreA` is a Product of
  Food Item `whole-milk`.

**The granularity rule:** *split into different Food Items only when the difference
changes meal planning, a dietary constraint, or how you'd reorder it.* Apply it
consistently:

- `whole-milk` ≠ `skim-milk` ≠ `oat-milk` — **different Food Items** (fat/diet differ).
- `Horizon whole milk` vs `store-brand whole milk` — **same Food Item, two Products**
  (interchangeable for planning).
- `64oz` vs `gallon` whole milk — **same Food Item, two Products** (size is a Product
  attribute; the par level is in "containers" or a normalized unit).
- `fresh basil` ≠ `dried basil` — **different Food Items** (not interchangeable in a
  recipe).

When in doubt, ask: *"If I had one but not the other, would the meal plan or the reorder
change?"* Yes → separate Food Items. No → same Food Item, different Products.

---

## 3. Data model

```jsonc
// FoodItem — the canonical entity. The thing inventory & par levels attach to.
{
  "id": "fi_whole_milk",
  "canonical_name": "Whole milk",
  "category": "dairy",
  "default_zone": "refrigerated",         // §4 storage zone
  "default_unit": "container",            // how par levels count it
  "diet_tags": ["vegetarian", "contains_dairy"],
  "allergen_tags": ["milk"],             // feeds the allergen gate (§10) — never inferred
  "is_discrete": false                    // false → bucket tracking; true → integer count
}

// Alias — surface form → FoodItem. Curated + learned. The heart of resolution.
{
  "id": "al_0291",
  "food_item_id": "fi_whole_milk",
  "surface_form": "whl milk",             // normalized
  "source_type": "receipt",              // receipt | vision | narration | recipe | any
  "origin": "learned",                   // seeded | learned | human_confirmed
  "weight": 0.95                          // confidence this alias is correct
}

// Product — buyable SKU under a FoodItem. The unit of ordering (§7, §8).
{
  "id": "pr_horizon_whole_64",
  "food_item_id": "fi_whole_milk",
  "brand": "Horizon Organic",
  "size": { "value": 64, "unit": "oz" },
  "upc": "742365000123",
  "store_skus": [ { "store": "storeA", "sku": "A-558231", "in_stock": true } ],
  "is_preferred": true                    // default pick when this FoodItem is ordered
}

// UnmatchedMention — anything resolution couldn't place with confidence. The review queue.
{
  "id": "um_4410",
  "raw_text": "TJ's seasonal squash blend",
  "source_type": "receipt",
  "context": { "walkthrough_id": null, "receipt_id": "rc_88" },
  "candidates": [ { "food_item_id": "fi_butternut_squash", "score": 0.41 } ],
  "status": "pending"                     // pending | resolved | created_new | ignored
}

// ResolutionLog — every decision, for audit + training the matcher.
{
  "mention": "HORIZON ORG WHL MILK HG 64OZ",
  "source_type": "receipt",
  "resolved_food_item_id": "fi_whole_milk",
  "resolved_product_id": "pr_horizon_whole_64",
  "confidence": 0.97,
  "method": "upc_lookup",                 // which stage of the cascade fired
  "human_confirmed": false
}
```

---

## 4. The resolution cascade (one ordered algorithm)

`resolve(mention, source_type, context) → Resolution`. Try stages in order; **stop at
the first that clears its confidence threshold.** Never silently guess below threshold —
fall through to the unmatched queue.

```
1. NORMALIZE
   lowercase, strip units/sizes/pack-counts, expand known abbreviations
   ("ORG"→organic, "WHL"→whole, "HG"→half-gallon), drop store prefixes ("TJ'S").
   → keep the parsed-out size/brand; they help pick the Product later.

2. EXACT IDENTIFIER  (highest confidence — receipts & barcodes)
   if mention has a UPC / store SKU → look up Product → its FoodItem.  conf ≈ 0.99

3. EXACT ALIAS
   normalized form matches an Alias (prefer same source_type) → its FoodItem. conf ≈ 0.97

4. FUZZY / EMBEDDING
   nearest Alias/canonical_name by edit-distance + embedding similarity.
   accept only if top score ≥ τ_high AND margin over #2 candidate ≥ τ_margin. conf = score

5. STRUCTURED PARSE  (recipes & rich receipt lines)
   ingredient parser → {qty, unit, descriptor, core noun}; resolve the core noun
   ("whole milk") via steps 3–4. carries the quantity through.

6. LLM FALLBACK  (last resort, bounded)
   ask the model to map mention → one of the existing FoodItems (closed set) OR
   "none". Cheap, cached, and only invoked when 2–5 miss. conf = model-reported, capped.

7. UNMATCHED QUEUE
   nothing cleared threshold → write an UnmatchedMention with top candidates.
   NEVER auto-create a FoodItem from an unresolved mention (that's how the count forks).
```

**Ambiguity rule:** if two candidates are within `τ_margin` of each other, do **not**
pick — treat as unmatched and surface both. Silent wrong matches are worse than asking.

---

## 5. Source-specific notes

- **Receipt / barcode (highest trust):** UPC → Product is near-certain; this is the
  signal that should *anchor* a FoodItem's Products. Remember §4's fix — ingest the
  **post-delivery** receipt so substitutions resolve to what actually arrived.
- **Vision:** combine the visual class (`"carton"`) with OCR of the label crop
  (`"Horizon Organic Whole"`); the label often gets you to a Product, the shape to a
  category. Low-confidence visual-only detections lean on narration to disambiguate.
- **Narration:** short, human, deictic — `"this is low"`. Resolve the noun if present;
  if it's a pointer (`"this"`, `"that one"`), bind it to the **on-screen item at that
  timestamp** (see the narration spec) before resolving.
- **Recipe:** the structured parser (step 5) is reliable here; the same parser powers
  cook-to-deplete, so a recipe and its depletion always hit the same FoodItem.

---

## 6. The feedback loop (why it gets better with use)

Every human action in the review chart (§ draft-chart spec) is training data:

- Confirm a proposed row → bump the firing Alias `weight`, log `human_confirmed`.
- Correct a row ("that's oat milk, not whole") → **create/strengthen an Alias** from the
  raw mention to the corrected FoodItem; demote the wrong one.
- Resolve an UnmatchedMention → create the Alias so it never asks again; optionally
  `create_new` FoodItem (the *only* sanctioned path to new items — human-gated).

This is the §11 personalization moat in miniature: a household's alias table becomes a
fingerprint of how *they* name and buy food, and resolution accuracy climbs week over
week.

---

## 7. Interface

```
resolve(mention: string, source_type, context) -> {
  food_item_id: string | null,
  product_id: string | null,
  confidence: number,            // 0..1
  method: string,                // which cascade stage fired
  needs_review: boolean          // true → goes to the chart's review queue, not inventory
}

resolveBatch(mentions[]) -> Resolution[]      // a whole receipt or walkthrough at once
confirm(mention, food_item_id)                // feedback loop: strengthen alias
createFoodItem(draft) -> FoodItem             // human-gated; the only path to new items
mergeFoodItems(keep_id, merge_id)             // fix a fork after the fact
```

**Idempotence & merge/split:** resolution must be deterministic for a given alias table.
When two FoodItems turn out to be one, `mergeFoodItems` re-points aliases, products, and
inventory and keeps a tombstone so historical logs still resolve.

---

## 8. Testing (the red-team insisted: this is a tested subsystem, not plumbing)

- **Golden set:** a fixture of real mentions per source (messy receipt lines, ASR
  transcripts, vision labels, recipe ingredients) each with the expected FoodItem. Run
  on every change; track precision/recall.
- **Anti-fork test:** feed the same physical item through all four sources; assert they
  resolve to one `food_item_id`. This is the single most important test in the system.
- **Ambiguity test:** near-tie mentions must route to unmatched, not pick.
- **No-silent-create test:** an unknown mention must never auto-create a FoodItem.
- **Regression on feedback:** after a human correction, the same mention resolves
  correctly without review next time.

---

## 9. Build order

1. FoodItem + Alias + Product tables; seed a starter alias table (common staples).
2. Cascade steps 1–3 (normalize, UPC, exact alias) — covers most receipt/barcode volume.
3. Unmatched queue + the review/confirm feedback loop — start learning immediately.
4. Fuzzy/embedding (step 4) and the recipe parser (step 5).
5. LLM fallback (step 6) last — it's the safety net, not the workhorse.

> One-line summary: **one Food Item per interchangeable food, Products underneath it, an
> ever-growing alias table resolving every source to that one ID, and a hard rule that
> nothing unresolved silently becomes inventory.**

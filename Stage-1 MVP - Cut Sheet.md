# Stage-1 MVP — Cut Sheet

*The smallest thing worth running in a kitchen. One household, the "cheap loop":
receipts + predicted depletion + quick-add → a weekly shortfall list **you** order.
**No vision. No grocery API. No payment integration.** Those come later — this proves
the engine first.*

---

## The bet this MVP tests

> *If the system tells me what I'm low on each week — accurately enough to trust — is
> that already worth it?* If yes, every later phase (video capture, auto-cart, multi-store)
> is an enhancement on a proven core. If no, you learned it in an afternoon, not a year.

**Definition of done:** every Sunday you get a shortfall list that's right often enough
that you stop maintaining a separate "what do we need" list. That's the whole win.

---

## In scope  /  explicitly out

| In | Out (deferred — and that's the point) |
|---|---|
| ~30 staples with par levels | Full-pantry inventory |
| Receipt → inventory increment | Narrated video capture (Phase 1b) |
| Cook / quick-add → decrement | Store connectors & carts (Phase 3) |
| Predicted depletion + confirm | Auto-payment (never, by design) |
| Weekly shortfall list (you order) | Meal planner, presence, guests (Phase 0/2) |
| Canonical item resolution (lite) | Multi-household / config (Stage 3+) |

Keep the list to your **30 most-bought staples**. The 80/20 of value lives there; pantry
long-tail is noise for now.

**Client for Stage 1:** a **PWA / mobile web** app (or even Notion/Airtable, Option A) —
quick-add and receipt-paste from your phone, no app-store friction. The camera-heavy
native app (React Native/Flutter) graduates in with video capture in a later phase.
Build the backend as a service behind an API from day one so the client can swap
without a rewrite.

---

## Minimal data model (a spreadsheet or one small DB is fine)

```jsonc
FoodItem { id, name, zone, is_discrete, par, reorder_point, consumption_rate? }
Inventory { food_item_id, state }      // {bucket: full|half|low|out} OR {count: n}
Alias     { surface_form, food_item_id }   // the lite resolver (Resolution spec, steps 1-3)
Event     { ts, food_item_id, delta, source }  // receipt | cook | quickadd | predicted
```

That's it. Four tables. No new entities until the loop works.

---

## The four data flows

1. **Receipt in (+).** Paste/forward a delivery receipt → resolve each line to a
   FoodItem (alias table; unmatched → a 2-minute review) → set state toward `full` /
   bump count. *Use the **post-delivery** receipt so subs/refunds are right.*
2. **Depletion (−).** Two cheap sources: a one-tap **quick-add** ("out of olive oil")
   and, if you want, marking a meal cooked to subtract its recipe. Both low-confidence;
   that's fine.
3. **Predicted depletion (the workhorse).** Per item, a simple consumption rate
   ("milk ~1 every 5 days"). When predicted state crosses the reorder point, **don't
   auto-act — add it to the shortfall list flagged "confirm?"** This carries the count
   between receipts without any scanning.
4. **Shortfall list out.** Weekly job: for each staple, if `state ≤ reorder_point`
   (bucket trigger or count), add to the list. Send it to yourself (email/notes).
   You order. Done.

---

## Build checklist (ordered — each step is usable on its own)

- [ ] **1.** Seed your 30 staples with `zone`, `par`, `reorder_point`. (1 sitting.)
- [ ] **2.** Manual state entry + the weekly shortfall job. *← already useful here.*
- [ ] **3.** Quick-add (one tap / one text) to set an item `low`/`out`.
- [ ] **4.** Receipt ingestion + the lite resolver (alias table + unmatched queue).
- [ ] **5.** Predicted depletion with "confirm?" flags on the list.
- [ ] **6.** Tune par/reorder points from 2–3 weeks of real misses.

Ship after step 2. Everything after is accuracy, not existence.

---

## What "good" looks like (so you know it's working)

- **Precision:** few false "you're low" items (annoying, erodes trust).
- **Recall:** few "we actually ran out and it wasn't on the list" misses (the real pain).
- **Effort:** under ~5 min/week of upkeep. If it's more, the loop is too heavy — lean
  harder on prediction, trim the staple list.

Track these by hand for a month. They tell you whether to invest in Phase 1b (video) or
fix the cheap loop first.

---

## Cheap-insurance habits to carry from day one

Even at one household, these cost ~nothing and stop a future rewrite:
- Scope every row by `household_id` (even though there's one).
- Keep par levels / aliases / rates as **data**, not hardcoded.
- Don't hardcode "you" or one store anywhere.
- Resolve every source through the alias table — never let two sources write two records.

---

> One-line summary: **30 staples, four tables, four flows — receipts and a consumption
> model keep the count, prediction fills the gaps, and a weekly list you order yourself is
> the whole product. Prove that's worth it before building anything fancier.**

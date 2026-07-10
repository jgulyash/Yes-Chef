# Yes Chef! — Stage-1 MVP (the "cheap loop")

The smallest useful slice of [Yes Chef!](../README.md): track ~30 staple foods and
produce a **weekly shortfall list** of what to reorder. Receipts and a consumption model
keep the count, prediction fills the gaps, and a weekly list **you** order yourself is the
whole product. **No vision, no grocery API, no payment** — those are later phases.

This is a backend **service behind a clean HTTP API** (the inventory + reorder engine are
the source of truth) plus a thin web UI, so a native iOS client can attach later without a
rewrite.

## The four flows

1. **Receipt in (+)** — paste a post-delivery receipt; each line resolves to a FoodItem via
   the alias table and increments stock. Substitutions credit what arrived; **refunds are
   not credited** (crediting food you never received is what causes the over-order loop).
2. **Depletion (−)** — one-tap quick-add ("out of olive oil"), resolved through the same
   alias table.
3. **Predicted depletion** — a per-item consumption rate. When the *estimated* state
   crosses the reorder point, the item is added to the shortfall list flagged **`confirm?`**.
   Prediction only ever proposes — it never changes stock and never orders.
4. **Shortfall list out** — every staple at/below its reorder point. Hard triggers are
   high-confidence; predicted ones are `confirm?`. You order it.

## Stack

- **TypeScript + Fastify** HTTP service.
- **Node's built-in `node:sqlite`** for storage (one file, zero native build). We chose this
  over `better-sqlite3` because it needs no native build step or binary downloads. It's behind a thin `db.ts` layer, so swapping in
  another SQLite driver later is a one-file change.
- **Vitest** for tests. Plain HTML/JS for the UI (no build step).

Requires **Node ≥ 22.5** (for `node:sqlite`). Tested on Node 22.22.

## Run it

```bash
cd app
npm install            # fastify, tsx, vitest — no native compilation

npm run migrate        # create the SQLite schema (yeschef.db)
npm run seed           # load 30 staples + aliases for the default household
npm run start          # serve the API + UI on http://localhost:3000
```

Then open **http://localhost:3000** — you get the shortfall list, quick-add, receipt paste,
the unmatched review queue, a metrics panel, and the full inventory with manual reconcile.

`npm run dev` runs the same server with auto-reload. Set `PORT` to change the port.

Your staple list lives in **`data/staples.json`** (editable data, not code) — the field
notes at the top of that file explain every column. It seeds the database on first run.

## Run it on your NAS (deployment)

To run it 24/7 on a Synology NAS in Docker, see **[DEPLOY-SYNOLOGY.md](./DEPLOY-SYNOLOGY.md)**
— a step-by-step guide (Container Manager + a zero-trust VPN app for off-network access + backups). The
container build/run path is:

```bash
npm run build          # compile TypeScript -> dist/ (no tsx at runtime)
npm run bootstrap:prod # migrate + seed only if the DB is empty
npm run start:prod     # node dist/server.js
```

The `Dockerfile` and `docker-compose.yml` wrap exactly those steps; the SQLite file is kept
on a mounted NAS folder so it persists and is covered by your backups.

### See the whole loop without a UI

```bash
npm run demo           # loads sample data, runs all four flows, prints the shortfall list
```

### Tests

```bash
npm test               # 18 tests: reorder engine + resolver (incl. the anti-fork test)
```

## Data model (four tables + the resolver's queue, all scoped by `household_id`)

| Table | Purpose |
|---|---|
| `food_item` | the canonical staple: `name, zone, is_discrete, par, reorder_point, consumption_rate` |
| `inventory` | current state per item: `{count: n}` (discrete) **or** `{bucket: full/half/low/out}` (bulk) |
| `alias` | `surface_form → food_item_id` — the lite resolver; seeded + learned |
| `event` | append-only log of every inventory motion (`receipt / cook / quickadd / predicted / manual`) |
| `unmatched_mention` | the review queue — anything the resolver couldn't place |
| `shortfall_feedback` | logged outcomes for the precision/recall metrics |

Par levels, aliases, and consumption rates are **data**, not code. Nothing hardcodes a
person or a store.

## The reorder engine (bucket/count triggers — never continuous arithmetic)

- **Discrete** items (eggs, cans): trigger when `count ≤ reorder_point`; reorder up to par.
- **Bulk** items (oil, rice, milk): tracked as `full/half/low/out`; trigger on `low`/`out`.
- The inventory count is an **estimate, never asserted as truth**. Predicted depletion maps
  buckets to a coarse fraction, subtracts estimated consumption, and maps back to a bucket —
  it only decides which bucket the estimate lands in, and only ever *proposes*.

## Item resolution (lite — Resolution spec cascade steps 1–3)

`normalize → exact-alias → unmatched queue`, plus the confirm-to-learn feedback loop.
No UPC/fuzzy/embedding/LLM/recipe-parser (those are later phases).

- **Every source resolves through the alias table** — receipts, quick-add, everything — so
  two sources can never fork into two records for the same food (see the *anti-fork* test).
- **Nothing unresolved is ever auto-created.** Unknown mentions go to the review queue;
  resolving one **learns an alias** so it won't ask again.

## HTTP API

| Method & path | What it does |
|---|---|
| `GET /api/items` | all staples with current inventory state |
| `POST /api/items/:id/state` | manual reconcile — `{count}` (discrete) or `{bucket}` (bulk) |
| `GET /api/shortfall` | the weekly list (`?predicted=0` to omit `confirm?` items) |
| `POST /api/quickadd` | `{text, level?}` — resolve & set low/out (or queue if unknown) |
| `POST /api/receipt` | `{lines:[{raw_text, qty?, status?}]}` — post-delivery ingest |
| `GET /api/unmatched` | the pending review queue |
| `POST /api/unmatched/:id/resolve` | `{food_item_id}` — learn the alias & apply the effect |
| `POST /api/unmatched/:id/ignore` | drop a queued mention |
| `POST /api/shortfall/feedback` | `{food_item_id, predicted, verdict}` — for metrics |
| `GET /api/metrics` | precision / recall / weekly upkeep |

All endpoints accept the household via `x-household-id` header or `?household_id=`,
defaulting to the seeded household — multi-household drops in without a schema change.

## Metrics ("is it working?")

- **Precision** — few false "you're low" flags (annoying, erodes trust).
- **Recall** — few "we ran out and it wasn't on the list" misses (the real pain).
- **Effort** — human-driven touches per 7 days; aim for under ~5 min/week of upkeep.

Log outcomes from the shortfall list (✓ needed / ✗ false alarm) and they feed these numbers.

## What's intentionally NOT here

No video/vision capture, no narration parsing, no store connector / cart / payment, no meal
planner, no presence/calendar, no multi-household UI. The architecture leaves room for each
(resolver source types, the event log, household scoping), but none is implemented.

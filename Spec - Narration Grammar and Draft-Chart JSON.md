# Spec — Narration Grammar & Draft-Chart JSON

*One of the core specs behind Yes Chef!. Two interlocking
artifacts for the narrated-video capture loop:*
1. *the **narration grammar** — spoken phrases → structured inventory actions, and*
2. *the **draft-chart JSON** — the reviewable output the app renders and the human edits.*

*Both speak the vocabulary defined in "Spec — Canonical Item Resolution": every item
reference becomes a `food_item_id`, quantities use the bucket set `full/half/low/out`
(or an integer count for discrete items), and unresolved mentions go to a review queue
rather than into inventory.*

---

## Part 1 — Narration grammar

### 1.1 Design principles

- **No wake word.** Everything spoken during a walkthrough is in-scope; the parser
  extracts the phrases that match an intent and **ignores the rest** (chatter, "umm",
  talking to a kid). Non-matching speech is never an error — it's just dropped.
- **Deixis is first-class.** People say *"this one's almost empty"* while holding a jar.
  The parser resolves pointers (`this`, `that`, `these`) to the **on-screen item at that
  timestamp** before item resolution (§1.5).
- **Forgiving, not rigid.** Treat the grammar as intent patterns over the ASR
  transcript, not a strict command language. Many phrasings map to one intent.
- **Low ASR confidence → review, never guess.** A garbled item name produces a row
  flagged `needs_review`, not a wrong inventory write.

### 1.2 Intents

| Intent | Spoken examples | Action |
|---|---|---|
| `SET_STATE` | "milk is low", "we're out of olive oil", "rice is full", "butter's about half" | set bucket `full/half/low/out` on the item |
| `SET_COUNT` | "two eggs left", "there are three yogurts", "only one can" | set integer count (discrete items) |
| `REORDER` | "reorder milk", "add olive oil to the list", "we need more rice" | flag item for the cart (§6) |
| `DONT_REORDER` | "don't reorder the beans", "we're good on flour" | suppress reorder this cycle |
| `IDENTIFY` | "this is tahini", "that's the gluten-free flour" | bind an identity to an item vision couldn't ID |
| `EXPIRY` | "the spinach expires Friday", "use this first" | set/flag expiry or priority |
| `ZONE` | "now the freezer", "moving to the pantry" | switch storage-zone context for following items |
| `CORRECTION` | "no, scratch that", "I mean almond milk" | revoke/replace the previous action |

A single utterance may carry **two intents** — *"milk is low, reorder"* → `SET_STATE(low)`
+ `REORDER`. Parse all that match.

### 1.3 Grammar sketch (EBNF-ish, illustrative not exhaustive)

```ebnf
utterance   = { intent_phrase } ;
intent_phrase =
      set_state | set_count | reorder | dont_reorder
    | identify | expiry | zone | correction ;

set_state   = item , copula , [ "about" | "almost" ] , state ;
state       = "full" | "half" | "low" | "running low" | "out" | "empty" | "gone" ;
set_count   = ( number , [ "of" ] , item , [ "left" ] )
            | ( "only" , number , [ item ] ) ;
reorder     = ( "reorder" | "re-order" | "order" | "buy" | "add" | "we need"
              | "get more" ) , [ "more" ] , item , [ "to the list" ] ;
dont_reorder= ( "don't" | "do not" ) , ( "reorder" | "buy" | "order" ) , item
            | ( "we're good on" | "skip" ) , item ;
identify    = ( "this is" | "that's" | "that is" ) , item ;
expiry      = item , "expires" , date
            | ( "use" , ( "this" | item ) , "first" ) ;
zone        = ( "now" | "moving to" | "next" ) , [ "the" ] , zone_name ;
correction  = "scratch that" | "no" , [ "," ] , [ "I mean" , item ] ;

item        = deictic | noun_phrase ;          (* resolved per §1.5 *)
deictic     = "this" | "that" | "this one" | "that one" | "these" | "it" ;
zone_name   = "fridge" | "refrigerator" | "freezer" | "counter" | "pantry" ;
state, number, date  = (* normalized by the parser *)
```

### 1.4 Action object (parser output, one per matched phrase)

```jsonc
{
  "intent": "SET_STATE",
  "raw_text": "milk is low",
  "t_start": 41.2, "t_end": 42.6,        // seconds into the clip — for time-alignment
  "item_ref": {                           // before canonical resolution
    "kind": "noun_phrase",               // or "deictic"
    "text": "milk",
    "resolved_food_item_id": "fi_whole_milk",  // null if unresolved → needs_review
    "resolution_confidence": 0.93
  },
  "value": { "bucket": "low" },          // or { "count": 2 } / { "reorder": true } ...
  "asr_confidence": 0.88,
  "needs_review": false
}
```

### 1.5 Time-alignment: binding "this" to what's on screen

The step that makes "point and talk" work:

```
1. Vision runs per sampled frame → timeline of detected items with timestamps + bboxes.
2. Speech → timestamped transcript → parsed Action objects with [t_start, t_end].
3. For a deictic item_ref at time t: choose the most prominent / center-frame /
   most-recently-handled detected item in the window [t - 1.5s, t + 0.5s].
4. Resolve that detection to a food_item_id (resolution spec). Attach to the action.
5. If no confident on-screen item in the window → needs_review (don't guess).
```

So *"this one's almost empty"* at 0:42, while a tahini jar is center-frame, becomes
`SET_STATE(half/low)` on `fi_tahini` — no item name spoken.

### 1.6 Conflict & ordering rules

- **Narration outranks vision on amounts.** If you say "milk is low" but vision guessed
  "full," the spoken value wins (you can see the fill level; the camera can't). Vision
  still owns *identity* unless an `IDENTIFY` overrides it.
- **Last statement wins** within a walkthrough (a `CORRECTION` or a later `SET_STATE`
  supersedes an earlier one for the same item).
- **Reorder is additive** and independent of state — you can `REORDER` an item that's
  still half-full ("we'll need it for the party").

---

## Part 2 — Draft-Chart JSON

The artifact the video→chart pipeline emits. The review screen renders it; the human
edits it; on approval it updates inventory and feeds the resolution feedback loop. It is
a **proposal**, never an order (the §10 human gate).

### 2.1 Top-level shape

```jsonc
{
  "walkthrough_id": "wt_2026_06_24_a",
  "household_id": "hh_001",
  "created_at": "2026-06-24T14:03:00Z",
  "video_ref": "blob://walkthroughs/wt_2026_06_24_a.mp4",  // retained per retention policy (§14)
  "duration_s": 312,
  "zones_covered": ["refrigerated", "freezer"],
  "status": "pending_review",              // pending_review | confirmed
  "previous_walkthrough_id": "wt_2026_06_17_a",
  "zones": [ /* ZoneSection[] */ ],
  "unmatched": [ /* UnmatchedRow[] */ ],   // mentions resolution couldn't place
  "summary": { "rows": 23, "needs_review": 4, "reorder_flagged": 3 }
}
```

### 2.2 ZoneSection and Row

```jsonc
{
  "zone": "refrigerated",
  "rows": [
    {
      "row_id": "r_004",
      "food_item_id": "fi_whole_milk",
      "display_name": "Whole milk",
      "proposed": { "bucket": "low" },          // or { "count": 2 } for discrete items
      "confidence": 0.91,
      "sources": ["vision", "narration"],       // provenance badges 👁 / 🎙
      "evidence": {
        "vision": { "t": 38.0, "bbox": [0.4,0.3,0.1,0.2], "label_ocr": "Horizon Organic Whole" },
        "narration": { "t": 41.2, "text": "milk is low", "asr_confidence": 0.88 }
      },
      "reorder_suggested": true,                // from a REORDER intent or par logic (§6)
      "diff": { "vs_previous": "changed", "from": { "bucket": "full" }, "to": { "bucket": "low" } },
      "needs_review": false,
      "review": { "state": "pending", "edited": false }   // pending | confirmed | edited
    },
    {
      "row_id": "r_009",
      "food_item_id": "fi_butter",
      "display_name": "Butter",
      "proposed": { "bucket": "full" },
      "confidence": 0.62,                        // vision-only amount guess → low trust
      "sources": ["vision"],
      "evidence": { "vision": { "t": 55.1, "bbox": [0.2,0.5,0.08,0.1], "label_ocr": null } },
      "reorder_suggested": false,
      "diff": { "vs_previous": "unchanged" },
      "needs_review": true,                      // amount low-confidence, no narration
      "review": { "state": "pending", "edited": false }
    }
  ]
}
```

### 2.3 UnmatchedRow (the review queue, inline in the chart)

```jsonc
{
  "row_id": "r_u2",
  "raw_mention": "this is the seasonal squash thing",
  "source": "narration",
  "evidence": { "narration": { "t": 142.0, "text": "this is the seasonal squash thing", "asr_confidence": 0.71 } },
  "candidates": [
    { "food_item_id": "fi_butternut_squash", "display_name": "Butternut squash", "score": 0.44 },
    { "food_item_id": "fi_acorn_squash", "display_name": "Acorn squash", "score": 0.39 }
  ],
  "resolution": { "state": "pending" }           // pending | picked | create_new | ignore
}
```

### 2.4 Review actions (what the app sends back on approval)

The human's edits — this payload both updates inventory **and** trains resolution (§6 of
the resolution spec). Nothing here places an order.

```jsonc
{
  "walkthrough_id": "wt_2026_06_24_a",
  "approved_at": "2026-06-24T14:09:00Z",
  "row_decisions": [
    { "row_id": "r_004", "action": "confirm" },                       // accept as-is
    { "row_id": "r_009", "action": "edit", "to": { "bucket": "low" } }, // human fixed the amount
    { "row_id": "r_u2",  "action": "resolve", "food_item_id": "fi_butternut_squash" }, // teaches an alias
    { "row_id": "r_017", "action": "delete" }                          // vision misread, remove
  ],
  "reorder_overrides": [
    { "food_item_id": "fi_olive_oil", "reorder": true }               // add despite not flagged
  ]
}
```

### 2.5 Rendering contract (what the review screen guarantees)

- Rows with `needs_review: true` sort to the top; within them, **low-confidence amounts
  on high-confidence identities** first (the numbers that matter most — §4).
- Each `sources` badge is tappable → jumps to `evidence.*.t` in the video (frame + a few
  seconds of audio).
- `diff.vs_previous` drives a changed-only view so a re-walkthrough reviews deltas, not
  the whole kitchen.
- A 🎙-backed row shows the quote ("you said: 'milk is low'") and is pre-trusted.

---

## Part 3 — End-to-end worked example

Spoken at 0:41 over a fridge clip, tahini jar center-frame at 0:42:

> *"Milk is low, reorder. ... This one's about half. ... We're good on eggs."*

Parses to:

```jsonc
[
  { "intent": "SET_STATE", "item": "milk", "value": {"bucket":"low"}, "t":41.2 },
  { "intent": "REORDER",   "item": "milk", "value": {"reorder":true}, "t":42.0 },
  { "intent": "SET_STATE", "item": "<deictic→fi_tahini@0:42>", "value": {"bucket":"half"}, "t":58.3 },
  { "intent": "DONT_REORDER", "item": "eggs", "t":71.0 }
]
```

→ chart rows: milk `low` + reorder-suggested (👁🎙, high confidence); tahini `half`
(🎙 + vision identity); eggs unchanged, reorder suppressed. Butter (vision-only, no
narration) lands `needs_review`. The "seasonal squash thing" lands in `unmatched` with
two candidates. Human confirms milk/tahini, fixes butter to `low`, picks butternut for
the squash (teaching an alias), approves. Inventory updates; resolution gets smarter; the
reorder engine (§6) drafts a cart with milk in it; **you review and pay** (§7).

---

> One-line summary: **the grammar turns natural speech (including "this one") into typed
> actions with timestamps; the draft-chart JSON fuses those with vision into one
> reviewable, diff-aware, provenance-tagged proposal — that a human confirms before a
> single item is bought.**

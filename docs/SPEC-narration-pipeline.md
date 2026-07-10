# Spec — Tier-1 Narration Pipeline (video → inventory, narration-only)

**Status:** DRAFT for build · **Depends on:** the shipped capture feature (`media_capture`
queue, `src/captures.ts`) · **Reuses:** `parseIntent` + resolver + quick-add path
(`src/quickadd.ts`, `src/resolver.ts`) · **Runs on:** the NAS (CPU-only, no GPU).

> Companion to the existing `Spec - Narration Grammar and Draft-Chart JSON.md`. That spec
> covers the *full* narrated-video vision (deixis, frame/time alignment, vision fusion).
> **Tier-1 deliberately drops vision.** It transcribes speech and turns spoken item
> mentions into *proposed* inventory changes you review. Vision (item identity from
> frames) is Tier-2 and layers on later without rework.

---

## 1. Goal

Turn a recorded kitchen-pass video into a reviewed set of inventory updates using **only
the narration** — you walk the kitchen saying "milk's low, out of eggs, coffee getting
low, we restocked rice," and the app proposes those exact changes for one-tap confirmation.

**Why narration-first:** the guiding principle is *"narration outranks vision on
amounts; vision owns identity."* Most of the signal a household needs (what's low/out/
restocked) is in the words, not the pixels. This delivers the "film → inventory" loop on
hardware already owned, fully local, with no GPU.

## 2. Scope / non-goals

**In scope (Tier-1):**
- Speech-to-text of the uploaded clip (Whisper, on the NAS).
- Parse each spoken mention into `{item phrase, intent, level/qty}`.
- Resolve item phrases through the **existing alias resolver** (no fork, no silent-create).
- Produce a **draft** = a batch of proposed changes, surfaced for human review.
- Apply the confirmed subset through the **existing** `setBucket`/`setCount`/quick-add path.

**Explicitly NOT in Tier-1:**
- No vision / frame analysis / object detection (Tier-2, on a desktop machine).
- No real-time processing (async batch; "we'll process this soon").
- **No auto-apply.** Narration is a proposal engine; the human confirms. STT is
  error-prone and one video touches many items — batching + review is mandatory.
- No new item creation from narration (unknown phrase → the review queue, same as today).

## 3. Architecture (all on the NAS)

```
 Phone ──upload──> POST /api/capture ──> media_capture(status=queued) + ./media/*.mp4
                                             │
                          ┌──────────────────┘  (async worker drains the queue)
                          ▼
   [1] extract audio  (ffmpeg: mp4 → 16kHz mono wav)
                          ▼
   [2] transcribe     (whisper.cpp, ggml small.en — CPU)  → transcript + segments
                          ▼
   [3] segment        split transcript into per-item utterances (sentence/pause based)
                          ▼
   [4] parse          each utterance → parseIntent()  → { noun, level }  (+ qty lexicon)
                          ▼
   [5] resolve        resolve(noun) → food_item_id  OR  unmatched
                          ▼
   [6] draft          write capture_draft rows (proposed changes), status=processing→processed
                          ▼
 App ── GET /api/captures/:id/draft ──> "Review this kitchen pass" screen
        POST .../apply {confirmed changes} ──> existing setBucket/setCount (source='narration')
```

**Two processes:**
- The **web app** (existing Fastify container) serves the draft + apply endpoints.
- A **worker** drains the capture queue. Simplest v1: an in-process interval in the
  existing container (poll `media_capture WHERE status='queued'` every N seconds, process
  one at a time — a small NAS can’t parallelize heavy STT anyway). No new container
  needed for v1; a separate worker container is a later scaling option.

**External binaries in the image:** `ffmpeg` + `whisper.cpp` (or `whisper` CLI). Add to
the Dockerfile runtime stage (apt-get ffmpeg; build/copy whisper.cpp + a ggml model).
Model file (`ggml-small.en.bin`, ~465MB) ships in the image or mounts from a NAS volume.

## 4. Whisper choice & performance

- **whisper.cpp** (ggml, pure C++, CPU) — the right fit for a modest x86 CPU, no Python/torch.
- **Model:** `small.en` (English, ~465MB) is the sweet spot for kitchen narration —
  `base.en` is faster but drops accuracy on food words; `medium` is too slow on this CPU.
- **Expected latency:** whisper.cpp on a ~2.6GHz x86 core runs roughly 2–5× realtime on
  `small` → a 60–90s kitchen pass transcribes in ~30–90s. Fully acceptable for async batch.
- **Guardrail:** cap processed clip length (e.g. 3 min) so a stray long recording can't
  peg the CPU while other always-on services need it. Process one clip at a time; low process priority
  (`nice`) so co-resident services stay responsive.

## 5. Data model (new: migration v7)

```sql
-- One row per proposed change extracted from a capture. Reviewed, then applied or dropped.
CREATE TABLE capture_draft (
  id            TEXT PRIMARY KEY,
  capture_id    TEXT NOT NULL REFERENCES media_capture(id) ON DELETE CASCADE,
  household_id  TEXT NOT NULL REFERENCES household(id),
  utterance     TEXT NOT NULL,                 -- the raw spoken phrase, verbatim (for trust)
  food_item_id  TEXT REFERENCES food_item(id), -- null = unmatched (needs a pick)
  proposed      TEXT NOT NULL,                 -- JSON: {kind:'bucket',bucket} | {kind:'count',count} | {kind:'restock'}
  confidence    REAL,                          -- STT/segment confidence 0..1 (surface, don't gate)
  status        TEXT NOT NULL DEFAULT 'pending' -- pending | applied | dismissed
                CHECK (status IN ('pending','applied','dismissed'))
);
```

`media_capture.status` gains no new values (existing `queued→processing→processed→failed`
covers it). Store the full transcript on the capture row too (add `transcript TEXT` column
in v7) so the user can read what was heard.

**Event source:** applying a narration change logs an `event` with `source='narration'`.
That's a new enum value → the v7 migration must rebuild the `event` CHECK (same
noTx table-rebuild pattern used for `food_item` in v3). Alternatively reuse `'quickadd'`
to avoid the rebuild — **decision for the implementer**; new source is cleaner for metrics.

## 6. Narration grammar (Tier-1 subset)

Reuse `parseIntent()` as the core, extended with a small quantity/restock lexicon.

**Intents:**
| Spoken (examples) | Proposed change |
|---|---|
| "out of eggs", "no more milk", "used up the rice" | level → `out` (bucket) / `count 0` (discrete) |
| "low on coffee", "milk's getting low", "almost out of butter" | level → `low` |
| "restocked the flour", "filled up on rice", "got more eggs" | `restock` → bucket `full` / count `par` |
| "three eggs left", "about half the olive oil" | qty/level: `count 3` / bucket `half` |
| "skip the pantry", "nothing in the freezer changed" | no-op (segment ignored) |

**Segmentation:** split the transcript on sentence boundaries and pauses (whisper.cpp
emits per-segment timestamps — use segment breaks). Each segment → one candidate change.
Discard segments with no recognized item noun after `parseIntent` filler-stripping.

**Number words:** map "one…twelve", "a couple", "half", "quarter" → counts/buckets
(small lexicon; `parseIntent` already handles level words).

## 7. HITL review surface (app)

New screen reachable from a capture in the Add tab: **"Review this kitchen pass."**
- Shows the transcript (collapsible — builds trust: "here's what I heard").
- A list of proposed changes, each row:
  - the **verbatim utterance** ("milk's getting low"),
  - the **matched item** (or a **`(choose item)`** picker for unmatched — the
    no-silent-default rule from the review queue applies),
  - the **proposed state** (editable: full/half/low/out or a count),
  - **keep / drop** toggle (default keep for matched, default drop for unmatched-unpicked).
- One **"Apply N changes"** button → applies only kept+resolved rows via the existing
  `setBucket`/`setCount` path (`source='narration'`), marks drafts `applied`, unmatched
  picks learn the alias (same as the review queue).
- Unresolved/dropped rows can be sent to the existing unmatched queue or discarded.

**Principle preserved:** counts are estimates, never asserted. Narration *proposes*; the
weekly list and reorder engine treat the result exactly like any other manual update.

## 8. API additions

| Method & path | Purpose |
|---|---|
| (worker, internal) | drains `media_capture` queued → runs pipeline → writes `capture_draft` |
| POST `/api/captures/:id/process` | manual "process now" trigger (also lets the UI kick it) |
| GET `/api/captures/:id/draft` | `{ transcript, drafts:[{id, utterance, food_item_id, name, proposed, confidence, status}] }` |
| POST `/api/captures/:id/apply` | `{ changes:[{draft_id, food_item_id, proposed}] }` → applies, returns applied count |
| (existing) DELETE `/api/captures/:id` | already cascades to `capture_draft` |

## 9. Testing strategy (keep the injectable-seam pattern)

The whole pipeline must be testable without ffmpeg/Whisper/a GPU — same discipline as the
injected file-writer (captures) and fetcher (import):

- **Inject the transcriber.** `type Transcriber = (absPath) => Promise<{ text, segments }>`.
  Tests pass a stub returning fixture transcripts; production wires whisper.cpp. **Zero
  audio in tests.**
- Unit-test the **segment → parse → resolve → draft** chain on fixture transcripts:
  "we're out of eggs and milk is low and we restocked the rice" → 3 drafts with the right
  items + proposed states, unknown noun → unmatched draft.
- Test **apply**: kept+resolved rows change inventory (eggs→0, milk→low), unmatched pick
  learns the alias, dropped rows do nothing, event rows carry `source='narration'`.
- Test v7 migration on a populated-DB copy (rows preserved, event rebuild clean).

## 10. Failure modes & guardrails

- **Bad transcription** → surfaced verbatim in review; user drops wrong rows. Never
  auto-applied, so a misheard word can't silently corrupt inventory.
- **Ambiguous item** ("beans" when you track black + green) → unmatched draft, `(choose
  item)` picker. Same anti-fork rule as everywhere.
- **Over-order protection** → unchanged; narration feeds the same estimate-with-confidence
  model as every other source. A "restock → full/par" is a proposal, editable.
- **CPU contention with co-resident services** → one clip at a time, `nice`d, length-capped, off-peak
  worker interval configurable.
- **Whisper fails / no speech** → `media_capture.status='failed'` with a note; the clip
  stays for retry; the user still has the raw video.

## 11. Build phases within Tier-1

1. **P1 — Draft engine, no audio.** Migration v7 (`capture_draft` + transcript column),
   the segment→parse→resolve→draft chain behind an **injected transcriber**, the review
   screen + apply endpoint. Testable and demoable by pasting a transcript string. *Ships
   the whole UX and logic with zero Whisper dependency.*
2. **P2 — Wire Whisper.** ffmpeg + whisper.cpp + `small.en` in the image; the real
   transcriber; the queue-draining worker; `/process` trigger. Verify on a real phone clip.
3. **P3 — Polish.** Number/restock lexicon expansion, confidence display, off-peak
   scheduling, length caps, failure retry UX.

## 12. Effort estimate

- **P1:** ~1 focused session (migration + draft chain + review UI + apply + tests) — pure
  TypeScript, no new system deps, fully in the existing stack.
- **P2:** ~1 session + image/deploy work (adding ffmpeg/whisper to the Dockerfile is the
  main new surface; the model file bloats the image ~0.5GB or mounts from a volume).
- **P3:** incremental.

**Recommendation:** build **P1 first** — it proves the entire narration→review→apply UX
against pasted transcripts (so we validate the product before touching Whisper), and P2
becomes "swap the stub transcriber for the real one."

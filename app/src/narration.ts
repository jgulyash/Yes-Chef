import type { DB } from "./db.js";
import type { Bucket } from "./types.js";
import { parseIntent } from "./quickadd.js";
import { resolve, learnAlias, normalize } from "./resolver.js";
import { getFoodItem, setBucket, setCount, BUCKETS } from "./inventory.js";
import { id, nowIso } from "./util.js";

// Tier-1 narration pipeline (docs/SPEC-narration-pipeline.md), P1: transcript -> proposed
// changes -> human review -> apply. No vision, no audio in this module — the transcriber
// is injected so everything is testable on pasted transcript strings.

// Return shape carries the model's own segments/confidence when available (Whisper, P2);
// P1 only needs `text`. Widened now so wiring Whisper later is additive, not breaking.
export type Transcriber = (absPath: string) => Promise<{
  text: string;
  segments?: { text: string; confidence?: number }[];
} | null>;

// P1 default: Whisper isn't wired yet, so there's no automatic transcription. The paste-
// a-transcript path (process with a {transcript} body) is how P1 is used and demoed.
export const noTranscriber: Transcriber = async () => null;

// A spoken intent, before it's tied to a concrete item state.
export type Intent = "out" | "low" | "restock";

const RESTOCK_PAT =
  /\b(restocked|restock|refilled|refill|filled up|filled|topped up|topped off|bought more|got more|picked up more|replenished)\b/;

// Split a transcript into per-item utterances. Whisper emits sentence-ish segments; from
// a plain string we split on sentence punctuation AND common spoken conjunctions ("and",
// "then", "also") so one run-on sentence still yields one change per item.
const SENTINEL = ""; // stands in for a protected " and " during splitting

// `protect` = item names that themselves contain "and" ("mac and cheese"): their internal
// " and " is shielded so the splitter doesn't tear the item in half.
export function segmentTranscript(text: string, protect: string[] = []): string[] {
  let t = text;
  for (const phrase of protect) {
    const shielded = phrase.replace(/ and /gi, ` ${SENTINEL} `);
    t = t.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), shielded);
  }
  return t
    .split(/[.!?;,\n]+|\b(?:and then|and also|then also| and | then | also )\b/i)
    .map((s) => s.replace(new RegExp(SENTINEL, "g"), "and").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 1);
}

const MAX_SEGMENTS = 200; // a kitchen pass, not a novel — bound the work per request

// Conversational glue quick-add never sees ("milk IS low", "we're GETTING low") but
// narration does. Strip it so the noun the resolver receives is just the item.
const COPULA_PAT = /\b(is|are|was|were|be|been|getting|got|gonna|about|pretty|really|kinda|sorta|so|just|now|left|remaining|there'?s|we'?ve|i'?ve|um|uh|er|hmm|okay|ok|lets|let'?s|see|like|maybe)\b/g;
// Drop punctuation, then conversational glue; a noun with no real letters is nothing.
const cleanNoun = (n: string) =>
  n.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(COPULA_PAT, " ").replace(/\s+/g, " ").trim();

// Pull the intent + item noun out of one utterance. Reuses parseIntent (low/out + filler
// stripping); adds restock detection + conversational cleanup on top.
export function readUtterance(utterance: string): { noun: string; intent: Intent } | null {
  if (RESTOCK_PAT.test(utterance.toLowerCase())) {
    const stripped = utterance.toLowerCase().replace(RESTOCK_PAT, " ");
    const noun = cleanNoun(parseIntent(stripped).noun);
    return noun ? { noun, intent: "restock" } : null;
  }
  const { noun, level } = parseIntent(utterance);
  const clean = cleanNoun(noun);
  if (!/[a-z]/.test(clean)) return null; // nothing but filler/punctuation left
  return { noun: clean, intent: level ?? "out" }; // a bare "eggs" mention defaults to out (you named it because it's gone)
}

export type Proposed =
  | { kind: "bucket"; bucket: Bucket }
  | { kind: "count"; count: number }
  | { kind: "intent"; intent: Intent }; // unmatched: concrete state resolved once an item is picked

// Concrete proposed state for a KNOWN item given the spoken intent.
export function proposedFor(intent: Intent, isDiscrete: boolean, par: number, reorderPoint: number): Proposed {
  if (isDiscrete) {
    const count = intent === "out" ? 0 : intent === "low" ? reorderPoint : par;
    return { kind: "count", count };
  }
  const bucket: Bucket = intent === "out" ? "out" : intent === "low" ? "low" : "full";
  return { kind: "bucket", bucket };
}

export interface DraftRow {
  id: string;
  capture_id: string;
  household_id: string;
  utterance: string;
  noun: string;
  food_item_id: string | null;
  proposed: string; // JSON
  confidence: number | null;
  status: "pending" | "applied" | "dismissed";
}

// Transcript -> draft rows. Each recognizable utterance becomes one proposed change,
// resolved through the SAME alias table as every other source (unknown noun -> null item,
// never a silent create).
export function buildDrafts(db: DB, household_id: string, capture_id: string, transcript: string): DraftRow[] {
  db.prepare(`UPDATE media_capture SET transcript = ?, status = 'processing' WHERE id = ? AND household_id = ?`)
    .run(transcript, capture_id, household_id);
  try {
    // Re-processing replaces any earlier pending drafts for this capture.
    db.prepare(`DELETE FROM capture_draft WHERE capture_id = ? AND status = 'pending'`).run(capture_id);

    // Shield multi-word item names containing "and" from the conjunction splitter.
    const protect = (
      db.prepare(`SELECT name FROM food_item WHERE household_id = ? AND active = 1 AND lower(name) LIKE '% and %'`).all(household_id) as { name: string }[]
    ).map((r) => r.name);

    const ins = db.prepare(
      `INSERT INTO capture_draft (id, capture_id, household_id, utterance, noun, food_item_id, proposed, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    for (const utterance of segmentTranscript(transcript, protect).slice(0, MAX_SEGMENTS)) {
      const read = readUtterance(utterance);
      if (!read) continue;
      const r = resolve(db, household_id, read.noun, "quickadd");
      const item = r.food_item_id ? getFoodItem(db, household_id, r.food_item_id) : null;
      const proposed: Proposed = item
        ? proposedFor(read.intent, item.is_discrete, item.par, item.reorder_point)
        : { kind: "intent", intent: read.intent };
      ins.run(id("cd"), capture_id, household_id, utterance.trim(), normalize(read.noun), item?.id ?? null, JSON.stringify(proposed), r.confidence ?? null);
    }
    db.prepare(`UPDATE media_capture SET status = 'processed' WHERE id = ? AND household_id = ?`).run(capture_id, household_id);
    return listDrafts(db, household_id, capture_id);
  } catch (e) {
    // buildDrafts owns its failure: a capture must never strand in 'processing'. The
    // queue worker isn't guaranteed to exist (STT-off deployments), so recovery can't
    // live there.
    const reason = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE media_capture SET status = 'failed', note = ? WHERE id = ? AND household_id = ?`)
      .run(reason.slice(0, 500), capture_id, household_id);
    throw e;
  }
}

export function listDrafts(db: DB, household_id: string, capture_id: string): DraftRow[] {
  return db
    .prepare(`SELECT * FROM capture_draft WHERE capture_id = ? AND household_id = ? ORDER BY rowid`)
    .all(capture_id, household_id) as unknown as DraftRow[];
}

// Apply the reviewed changes. Each change names its draft, the final item, and the final
// concrete state (the client may have edited it). Unknown-then-picked drafts learn the
// alias, exactly like the receipt review queue. Nothing auto-applies — this is only ever
// called from an explicit "Apply" tap.
export interface ApplyChange {
  draft_id: string;
  food_item_id: string;
  proposed: { kind: "bucket"; bucket: Bucket } | { kind: "count"; count: number };
}

export function applyDrafts(
  db: DB,
  household_id: string,
  capture_id: string,
  changes: ApplyChange[]
): { applied: number } {
  let applied = 0;
  for (const c of changes) {
    const draft = db
      .prepare(`SELECT * FROM capture_draft WHERE id = ? AND capture_id = ? AND household_id = ? AND status = 'pending'`)
      .get(c.draft_id, capture_id, household_id) as DraftRow | undefined;
    if (!draft) continue;
    const item = getFoodItem(db, household_id, c.food_item_id);
    if (!item) continue;

    // Derive the state mode from the ITEM, never the client's label — a discrete item
    // always takes a count, a bulk item always a bucket. This is the same guard the
    // /items/:id/state route enforces; a mismatched or malformed proposed is skipped,
    // not written (a bucket on a discrete item, or a NaN count, would corrupt the row).
    const meta = { via: "narration", capture_id, utterance: draft.utterance };
    if (item.is_discrete) {
      const count = (c.proposed as { count?: unknown }).count;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
      if (!draft.food_item_id) learnAlias(db, household_id, draft.noun, item.id, "any");
      setCount(db, household_id, item.id, count, "narration", meta);
    } else {
      const bucket = (c.proposed as { bucket?: Bucket }).bucket;
      if (!bucket || !BUCKETS.includes(bucket)) continue;
      if (!draft.food_item_id) learnAlias(db, household_id, draft.noun, item.id, "any");
      setBucket(db, household_id, item.id, bucket, "narration", meta);
    }
    db.prepare(`UPDATE capture_draft SET status = 'applied', food_item_id = ? WHERE id = ?`).run(item.id, draft.id);
    applied++;
  }
  return { applied };
}

// Process a capture: use a provided transcript (paste path) or the injected transcriber.
export async function processCapture(
  db: DB,
  household_id: string,
  capture_id: string,
  opts: { transcript?: string; transcriber?: Transcriber; mediaPath?: string }
): Promise<{ ok: true; drafts: DraftRow[] } | { ok: false; status: number; error: string }> {
  let transcript = opts.transcript?.trim();
  let transcribed = false;
  if (!transcript && opts.transcriber && opts.mediaPath) {
    transcribed = true;
    const t = await opts.transcriber(opts.mediaPath);
    transcript = t?.text?.trim();
  }
  if (!transcript) {
    // Two different truths share this branch — tell the right one: STT ran and heard
    // nothing vs. no STT exists here at all.
    return {
      ok: false,
      status: 422,
      error: transcribed
        ? "no speech was recognized in this clip — re-record with narration, or paste what you said"
        : "automatic transcription isn't available yet — paste what you said and I'll read it",
    };
  }
  return { ok: true, drafts: buildDrafts(db, household_id, capture_id, transcript) };
}

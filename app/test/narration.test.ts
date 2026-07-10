import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db.js";
import { buildServer } from "../src/server.js";
import { storeCapture } from "../src/captures.js";
import { segmentTranscript, readUtterance, buildDrafts, listDrafts } from "../src/narration.js";
import { freshDb, itemId, HH } from "./helpers.js";
import { getInventory } from "../src/inventory.js";
import { computeMetrics } from "../src/metrics.js";

const stubWriter = () => async () => 1000;
const capId = async (db: DatabaseSync) => {
  const r = await storeCapture(db, HH, { mimetype: "video/mp4", source: {}, writer: stubWriter() }, join(tmpdir(), "yc-narr"));
  return r.ok ? r.capture.id : "";
};

describe("narration segmentation + parsing", () => {
  it("splits a run-on transcript into per-item utterances", () => {
    const segs = segmentTranscript("milk's getting low and we're out of eggs. restocked the rice, coffee's low");
    expect(segs.length).toBeGreaterThanOrEqual(4);
  });

  it("reads intent from each utterance", () => {
    expect(readUtterance("we're out of eggs")).toMatchObject({ intent: "out" });
    expect(readUtterance("milk is getting low")).toMatchObject({ intent: "low" });
    expect(readUtterance("restocked the rice")).toMatchObject({ intent: "restock" });
    expect(readUtterance("um, so, the")).toBeNull(); // no item noun
  });
});

describe("v7 migration + buildDrafts", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it("v8 is latest and capture_draft exists", () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(8);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("capture_draft");
  });

  it("builds one draft per recognized mention, resolving to items", async () => {
    const cid = await capId(db);
    const drafts = buildDrafts(db, HH, cid, "we're out of eggs and milk is low and restocked the white rice and out of dragonfruit");
    const eggs = drafts.find((d) => d.food_item_id === itemId(db, "Eggs"))!;
    expect(JSON.parse(eggs.proposed)).toEqual({ kind: "count", count: 0 }); // discrete out
    const milk = drafts.find((d) => d.food_item_id === itemId(db, "Whole milk"))!;
    expect(JSON.parse(milk.proposed)).toEqual({ kind: "bucket", bucket: "low" }); // bulk low
    const rice = drafts.find((d) => d.food_item_id === itemId(db, "White rice"))!;
    expect(JSON.parse(rice.proposed)).toEqual({ kind: "bucket", bucket: "full" }); // restock -> full
    const unmatched = drafts.find((d) => d.food_item_id === null)!;
    expect(unmatched).toBeTruthy(); // dragonfruit -> unmatched, no silent create
    expect(JSON.parse(unmatched.proposed).kind).toBe("intent");
    // media_capture recorded transcript + processed status
    const cap = db.prepare(`SELECT transcript, status FROM media_capture WHERE id = ?`).get(cid) as { transcript: string; status: string };
    expect(cap.status).toBe("processed");
    expect(cap.transcript).toContain("dragonfruit");
  });

  it("re-processing replaces pending drafts", async () => {
    const cid = await capId(db);
    buildDrafts(db, HH, cid, "out of eggs");
    buildDrafts(db, HH, cid, "milk is low and out of eggs");
    expect(listDrafts(db, HH, cid).length).toBe(2); // not 3
  });
});

describe("process + apply routes", () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  beforeEach(async () => { db = freshDb(); app = await buildServer(db); });
  afterEach(async () => { await app.close(); });

  it("process 422s without a transcript (no transcriber wired in P1)", async () => {
    const cid = await capId(db);
    const res = await app.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it("process without a transcript REQUEUES for the worker when STT is available (trigger semantics)", async () => {
    const stub = async () => ({ text: "we're out of eggs and milk is low" });
    const sttApp = await buildServer(db, { transcriber: stub });
    try {
      const cid = await capId(db);
      db.prepare(`UPDATE media_capture SET status = 'failed', note = 'old failure' WHERE id = ?`).run(cid);
      const res = await sttApp.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: {} });
      expect(res.statusCode).toBe(202);
      expect(res.json().queued).toBe(true);
      const cap = db.prepare(`SELECT status FROM media_capture WHERE id = ?`).get(cid) as { status: string };
      expect(cap.status).toBe("queued"); // the worker picks it up; the route never transcribes
    } finally {
      await sttApp.close();
    }
  });

  it("process 409s while a capture is mid-transcription", async () => {
    const cid = await capId(db);
    db.prepare(`UPDATE media_capture SET status = 'processing' WHERE id = ?`).run(cid);
    const res = await app.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: { transcript: "out of eggs" } });
    expect(res.statusCode).toBe(409);
  });

  it("process with pasted transcript, then apply changes inventory", async () => {
    const cid = await capId(db);
    const eggs = itemId(db, "Eggs");
    const milk = itemId(db, "Whole milk");
    const proc = await app.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: { transcript: "we're out of eggs and milk is low" } });
    expect(proc.statusCode).toBe(200);
    const drafts = proc.json().drafts;
    const eggDraft = drafts.find((d: { food_item_id: string }) => d.food_item_id === eggs);
    const milkDraft = drafts.find((d: { food_item_id: string }) => d.food_item_id === milk);

    const apply = await app.inject({
      method: "POST",
      url: `/api/captures/${cid}/apply`,
      payload: { changes: [
        { draft_id: eggDraft.id, food_item_id: eggs, proposed: { kind: "count", count: 0 } },
        { draft_id: milkDraft.id, food_item_id: milk, proposed: { kind: "bucket", bucket: "low" } },
      ] },
    });
    expect(apply.json().applied).toBe(2);
    expect(getInventory(db, HH, eggs)!.state).toEqual({ kind: "count", count: 0 });
    expect(getInventory(db, HH, milk)!.state).toEqual({ kind: "bucket", bucket: "low" });
    // applied events carry the first-class narration source (v8) + the meta tag
    const ev = db.prepare(`SELECT source, meta FROM event WHERE food_item_id = ? ORDER BY rowid DESC LIMIT 1`).get(eggs) as { source: string; meta: string };
    expect(ev.source).toBe("narration");
    expect(JSON.parse(ev.meta).via).toBe("narration");
    // drafts marked applied
    expect(listDrafts(db, HH, cid).every((d) => d.status === "applied")).toBe(true);
    // narration applies count as human upkeep in the weekly metric (the alpha's gate)
    const m = computeMetrics(db, HH);
    expect(m.weekly_upkeep.events_last_7d).toBeGreaterThanOrEqual(2);
  });

  it("apply derives state mode from the item and rejects malformed proposed", async () => {
    const cid = await capId(db);
    const eggs = itemId(db, "Eggs"); // discrete
    const milk = itemId(db, "Whole milk"); // bulk
    await app.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: { transcript: "out of eggs and milk is low" } });
    const drafts = listDrafts(db, HH, cid);
    const eggDraft = drafts.find((d) => d.food_item_id === eggs)!;
    const milkDraft = drafts.find((d) => d.food_item_id === milk)!;

    // A bucket sent for a discrete item, and a NaN count, are both skipped (not written).
    const bad = await app.inject({
      method: "POST",
      url: `/api/captures/${cid}/apply`,
      payload: { changes: [
        { draft_id: eggDraft.id, food_item_id: eggs, proposed: { kind: "bucket", bucket: "low" } }, // wrong mode for discrete
        { draft_id: milkDraft.id, food_item_id: milk, proposed: { kind: "count", count: "fast" } }, // wrong mode + NaN for bulk
      ] },
    });
    expect(bad.json().applied).toBe(0);
    // Eggs stays a valid count (not corrupted to a null-count/null-bucket row)
    expect(getInventory(db, HH, eggs)!.state.kind).toBe("count");
    expect(getInventory(db, HH, milk)!.state.kind).toBe("bucket");

    // A negative count is rejected too
    const neg = await app.inject({
      method: "POST",
      url: `/api/captures/${cid}/apply`,
      payload: { changes: [{ draft_id: eggDraft.id, food_item_id: eggs, proposed: { kind: "count", count: -3 } }] },
    });
    expect(neg.json().applied).toBe(0);
  });

  it("does not split item names that contain 'and'", async () => {
    const cid = await capId(db);
    // add a 'salt and pepper' item, then narrate it
    await app.inject({ method: "POST", url: "/api/items", payload: { name: "Salt and pepper", zone: "pantry", is_discrete: false, par: 1, reorder_point: 0, init: "full" } });
    buildDrafts(db, HH, cid, "we're low on salt and pepper");
    const drafts = listDrafts(db, HH, cid);
    expect(drafts.length).toBe(1); // one draft, not two fragments
    expect(drafts[0].food_item_id).toBe(itemId(db, "Salt and pepper"));
  });

  it("applying an unmatched draft with a chosen item learns the alias", async () => {
    const cid = await capId(db);
    await app.inject({ method: "POST", url: `/api/captures/${cid}/process`, payload: { transcript: "out of dragonfruit" } });
    const draft = listDrafts(db, HH, cid)[0];
    expect(draft.food_item_id).toBeNull();
    const eggs = itemId(db, "Eggs");
    await app.inject({
      method: "POST",
      url: `/api/captures/${cid}/apply`,
      payload: { changes: [{ draft_id: draft.id, food_item_id: eggs, proposed: { kind: "count", count: 0 } }] },
    });
    // "dragonfruit" now resolves to Eggs via the learned alias
    const qa = await app.inject({ method: "POST", url: "/api/quickadd", payload: { text: "dragonfruit", level: "low" } });
    expect(qa.json().food_item_id).toBe(eggs);
  });
});

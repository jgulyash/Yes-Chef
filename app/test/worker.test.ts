import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { startCaptureWorker, type CaptureWorker } from "../src/worker.js";
import type { Transcriber } from "../src/narration.js";
import { listDrafts } from "../src/narration.js";
import { freshDb, HH } from "./helpers.js";
import { id, nowIso } from "../src/util.js";

// The worker owns the 'failed' status and the drain loop; the transcriber is always a
// stub here (no binaries, no audio — that's transcribe.test.ts's job, with fakes).

const insertCapture = (db: DatabaseSync, capturedAt: string): string => {
  const cid = id("cap");
  db.prepare(
    `INSERT INTO media_capture (id, household_id, path, filename, bytes, captured_at, kind, status)
     VALUES (?, ?, ?, ?, 1000, ?, 'video', 'queued')`
  ).run(cid, HH, `${cid}.mp4`, `${cid}.mp4`, capturedAt);
  return cid;
};

const status = (db: DatabaseSync, cid: string) =>
  db.prepare(`SELECT status, note FROM media_capture WHERE id = ?`).get(cid) as { status: string; note: string | null };

const stub = (text: string | null): Transcriber => async () => (text === null ? null : { text });

let db: DatabaseSync;
let worker: CaptureWorker | undefined;

beforeEach(() => {
  db = freshDb();
  worker?.stop();
});

describe("capture queue worker", () => {
  it("drains a queued capture into processed drafts", async () => {
    const cid = insertCapture(db, nowIso());
    worker = startCaptureWorker(db, { transcriber: stub("we're out of eggs and milk is low"), intervalMs: 60_000, mediaRoot: tmpdir() });
    await worker.tick();
    expect(status(db, cid).status).toBe("processed");
    expect(listDrafts(db, HH, cid).length).toBeGreaterThanOrEqual(2);
  });

  it("marks a throwing transcription failed with the reason, and keeps draining", async () => {
    const cid1 = insertCapture(db, "2026-01-01T10:00:00Z");
    const cid2 = insertCapture(db, "2026-01-01T11:00:00Z");
    let calls = 0;
    const flaky: Transcriber = async () => {
      calls++;
      if (calls === 1) throw new Error("whisper failed: boom");
      return { text: "out of eggs" };
    };
    worker = startCaptureWorker(db, { transcriber: flaky, intervalMs: 60_000, mediaRoot: tmpdir() });
    await worker.tick(); // oldest fails
    expect(status(db, cid1)).toMatchObject({ status: "failed" });
    expect(status(db, cid1).note).toContain("boom");
    await worker.tick(); // loop survived; next capture processes
    expect(status(db, cid2).status).toBe("processed");
  });

  it("marks a silent clip (null transcript) failed with the paste hint", async () => {
    const cid = insertCapture(db, nowIso());
    worker = startCaptureWorker(db, { transcriber: stub(null), intervalMs: 60_000, mediaRoot: tmpdir() });
    await worker.tick();
    const s = status(db, cid);
    expect(s.status).toBe("failed");
    expect(s.note).toMatch(/paste/i);
  });

  it("processes exactly one capture per tick, oldest first", async () => {
    const older = insertCapture(db, "2026-01-01T10:00:00Z");
    const newer = insertCapture(db, "2026-01-01T11:00:00Z");
    const seen: string[] = [];
    const recording: Transcriber = async (p) => {
      seen.push(p);
      return { text: "out of eggs" };
    };
    worker = startCaptureWorker(db, { transcriber: recording, intervalMs: 60_000, mediaRoot: tmpdir() });
    await worker.tick();
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain(older);
    expect(status(db, newer).status).toBe("queued");
  });

  it("claims the capture ('processing') for the whole transcription, so the paste path can see it's in flight", async () => {
    const cid = insertCapture(db, nowIso());
    let statusDuringSTT = "";
    const observing: Transcriber = async () => {
      statusDuringSTT = status(db, cid).status; // what the /process route would see mid-run
      return { text: "out of eggs" };
    };
    worker = startCaptureWorker(db, { transcriber: observing, intervalMs: 60_000, mediaRoot: tmpdir() });
    await worker.tick();
    expect(statusDuringSTT).toBe("processing"); // claimed BEFORE the long await, not after
    expect(status(db, cid).status).toBe("processed");
  });

  it("requeues captures stuck in 'processing' on startup (crash recovery)", () => {
    const cid = insertCapture(db, nowIso());
    db.prepare(`UPDATE media_capture SET status = 'processing' WHERE id = ?`).run(cid);
    worker = startCaptureWorker(db, { transcriber: stub("x"), intervalMs: 60_000, mediaRoot: tmpdir() });
    expect(status(db, cid).status).toBe("queued");
  });
});

import { join } from "node:path";
import type { DB } from "./db.js";
import { processCapture, type Transcriber } from "./narration.js";
import { MEDIA_ROOT } from "./captures.js";

// Drains the kitchen-pass queue: oldest 'queued' capture -> transcribe -> drafts.
// One capture at a time, on an interval — a small host CPU can’t parallelize STT, and
// other containers may share it. The worker CLAIMS a row ('queued' -> 'processing')
// before the long transcription await, so the /process route and any concurrent
// processor can see it's in flight; it also owns the 'failed' status for transcription
// errors (buildDrafts owns failures past that point).

const DEFAULT_INTERVAL_MS = 15_000;

export interface WorkerOptions {
  transcriber: Transcriber;
  intervalMs?: number;
  mediaRoot?: string;
}

export interface CaptureWorker {
  tick(): Promise<void>; // exposed so tests drive the queue deterministically, no timers
  stop(): void;
}

export function startCaptureWorker(db: DB, opts: WorkerOptions): CaptureWorker {
  // A malformed env value (e.g. "15s") must fall back, not become NaN — setInterval
  // clamps NaN to 1ms, which would turn a 15s poll into a ~1000/sec hot loop.
  const envInterval = Number(process.env.YESCHEF_WORKER_INTERVAL_MS);
  const intervalMs =
    opts.intervalMs ?? (Number.isFinite(envInterval) && envInterval >= 1_000 ? envInterval : DEFAULT_INTERVAL_MS);
  const mediaRoot = opts.mediaRoot ?? MEDIA_ROOT;

  // Crash recovery: a capture stuck in 'processing' means a previous run died mid-way
  // (buildDrafts replaces pending drafts on re-run, so requeueing is safe).
  db.prepare(`UPDATE media_capture SET status = 'queued' WHERE status = 'processing'`).run();

  const nextQueued = db.prepare(
    `SELECT id, household_id, filename FROM media_capture WHERE status = 'queued' ORDER BY captured_at, id LIMIT 1`
  );
  const claim = db.prepare(`UPDATE media_capture SET status = 'processing' WHERE id = ? AND status = 'queued'`);
  const fail = db.prepare(`UPDATE media_capture SET status = 'failed', note = ? WHERE id = ?`);
  const markFailed = (id: string, reason: string) => fail.run(reason.slice(0, 500), id);

  let busy = false;
  async function tick(): Promise<void> {
    if (busy) return; // a long transcription may outlive the interval — never overlap
    busy = true;
    try {
      const row = nextQueued.get() as { id: string; household_id: string; filename: string } | undefined;
      if (!row) return;
      if (claim.run(row.id).changes !== 1) return; // someone else took it — skip this tick
      try {
        const result = await processCapture(db, row.household_id, row.id, {
          transcriber: opts.transcriber,
          mediaPath: join(mediaRoot, row.filename),
        });
        if (!result.ok) markFailed(row.id, result.error);
      } catch (e) {
        // Transcription failed — keep the media file so the clip can be retried or
        // pasted manually; the reason is stored on the capture row (UI surfacing of
        // the note is P3 polish).
        markFailed(row.id, e instanceof Error ? e.message : String(e));
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref(); // never hold the process open just to poll an empty queue

  return { tick, stop: () => clearInterval(timer) };
}

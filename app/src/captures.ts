import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { DB } from "./db.js";
import type { MediaCapture } from "./types.js";
import { id, nowIso } from "./util.js";

// Recorded kitchen-pass videos: stored raw on a dedicated media volume, one row per
// clip, status 'queued' until the future vision/narration pipeline processes them.
// The store WRITER is injected so tests never touch the real filesystem.

const __dirname = dirname(fileURLToPath(import.meta.url));

// Media lives on its own volume (big files, kept off the DB backup path). Override with
// YESCHEF_MEDIA. Kept separate from YESCHEF_DB deliberately.
export const MEDIA_ROOT = process.env.YESCHEF_MEDIA ?? resolve(__dirname, "..", "media");

export const MAX_VIDEO_BYTES = 500_000_000; // 500MB — a kitchen pass, not a movie
const VIDEO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
};

export function ensureMediaRoot(root = MEDIA_ROOT): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

export interface StoredFile {
  path: string; // relative to media root
  filename: string;
  bytes: number;
}

// Writer signature: given an absolute path + the request's file stream, persist it and
// report the byte count. Production uses fs streaming; tests pass a stub.
export type FileWriter = (absPath: string, source: unknown) => Promise<number>;

export function isAcceptedVideo(mimetype: string): boolean {
  return mimetype in VIDEO_EXT;
}

export async function storeCapture(
  db: DB,
  household_id: string,
  input: { mimetype: string; source: unknown; writer: FileWriter; note?: string | null },
  root = MEDIA_ROOT
): Promise<{ ok: true; capture: MediaCapture } | { ok: false; status: number; error: string }> {
  if (!isAcceptedVideo(input.mimetype)) {
    return { ok: false, status: 415, error: "please upload a video (mp4, mov, webm)" };
  }
  ensureMediaRoot(root);
  const cid = id("mc");
  const ext = VIDEO_EXT[input.mimetype];
  const filename = `${cid}.${ext}`;
  const absPath = join(root, filename);

  let bytes: number;
  try {
    bytes = await input.writer(absPath, input.source);
  } catch {
    return { ok: false, status: 500, error: "couldn't save that video" };
  }
  if (bytes > MAX_VIDEO_BYTES) {
    return { ok: false, status: 413, error: "that video is too large (max 500MB)" };
  }

  db.prepare(
    `INSERT INTO media_capture (id, household_id, path, filename, bytes, captured_at, kind, status, note)
     VALUES (?, ?, ?, ?, ?, ?, 'video', 'queued', ?)`
  ).run(cid, household_id, filename, filename, bytes, nowIso(), input.note ?? null);

  return { ok: true, capture: getCapture(db, household_id, cid)! };
}

interface CaptureRow extends Omit<MediaCapture, "kind" | "status"> {
  kind: string;
  status: string;
}

export function getCapture(db: DB, household_id: string, capture_id: string): MediaCapture | null {
  const r = db
    .prepare(`SELECT * FROM media_capture WHERE household_id = ? AND id = ?`)
    .get(household_id, capture_id) as CaptureRow | undefined;
  return r ? (r as MediaCapture) : null;
}

export function listCaptures(db: DB, household_id: string): MediaCapture[] {
  return db
    .prepare(`SELECT * FROM media_capture WHERE household_id = ? ORDER BY captured_at DESC`)
    .all(household_id) as unknown as MediaCapture[];
}

// Delete removes the row and the file (via injected remover; defaults to fs unlink).
export async function deleteCapture(
  db: DB,
  household_id: string,
  capture_id: string,
  remove: (absPath: string) => Promise<void>,
  root = MEDIA_ROOT
): Promise<boolean> {
  const cap = getCapture(db, household_id, capture_id);
  if (!cap) return false;
  await remove(join(root, cap.filename)).catch(() => {}); // file may already be gone
  // Explicit draft delete as well as the ON DELETE CASCADE — the cascade only fires when
  // the per-connection foreign_keys pragma is on, so don't rely on it alone.
  db.prepare(`DELETE FROM capture_draft WHERE capture_id = ?`).run(capture_id);
  db.prepare(`DELETE FROM media_capture WHERE household_id = ? AND id = ?`).run(household_id, capture_id);
  return true;
}

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/db.js";
import {
  storeCapture,
  listCaptures,
  deleteCapture,
  isAcceptedVideo,
  type FileWriter,
} from "../src/captures.js";
import { DEFAULT_HOUSEHOLD as HH } from "../src/seed.js";

// media_capture + capture store logic. The file WRITER/remover are injected, so these
// never touch the real filesystem — the writer just reports a byte count.
function db0() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  db.prepare(`INSERT INTO household (id, name) VALUES (?, 'Home')`).run(HH);
  return db;
}
const stubWriter = (bytes: number): FileWriter => async () => bytes;
const root = join(tmpdir(), "yc-test-media"); // never actually written (writer is stubbed)

describe("media_capture migration + store", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = db0(); });

  it("migration v6 creates media_capture", () => {
    expect(MIGRATIONS.some((m) => m.version === 6)).toBe(true);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("media_capture");
  });

  it("stores an accepted video, queued, and lists it", async () => {
    const r = await storeCapture(db, HH, { mimetype: "video/mp4", source: {}, writer: stubWriter(1_500_000) }, root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capture.status).toBe("queued");
      expect(r.capture.kind).toBe("video");
      expect(r.capture.bytes).toBe(1_500_000);
      expect(r.capture.filename).toMatch(/^mc_.*\.mp4$/);
    }
    expect(listCaptures(db, HH).length).toBe(1);
  });

  it("accepts mov/webm, rejects non-video", async () => {
    expect(isAcceptedVideo("video/quicktime")).toBe(true);
    expect(isAcceptedVideo("video/webm")).toBe(true);
    expect(isAcceptedVideo("image/png")).toBe(false);
    const bad = await storeCapture(db, HH, { mimetype: "image/png", source: {}, writer: stubWriter(10) }, root);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(415);
    expect(listCaptures(db, HH).length).toBe(0); // nothing recorded on reject
  });

  it("rejects an oversize file after it's written (size known post-stream)", async () => {
    const big = await storeCapture(db, HH, { mimetype: "video/mp4", source: {}, writer: stubWriter(600_000_000) }, root);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.status).toBe(413);
  });

  it("delete removes the row and calls the remover once", async () => {
    const r = await storeCapture(db, HH, { mimetype: "video/webm", source: {}, writer: stubWriter(2_000_000) }, root);
    const id = r.ok ? r.capture.id : "";
    let removed = "";
    const ok = await deleteCapture(db, HH, id, async (p) => { removed = p; }, root);
    expect(ok).toBe(true);
    expect(removed).toContain(id);
    expect(listCaptures(db, HH).length).toBe(0);
    expect(await deleteCapture(db, HH, id, async () => {}, root)).toBe(false); // already gone
  });

  it("lists newest first", async () => {
    await storeCapture(db, HH, { mimetype: "video/mp4", source: {}, writer: stubWriter(1) }, root);
    await new Promise((r) => setTimeout(r, 5));
    await storeCapture(db, HH, { mimetype: "video/mp4", source: {}, writer: stubWriter(2) }, root);
    const list = listCaptures(db, HH);
    expect(list.length).toBe(2);
    expect(list[0].bytes).toBe(2); // most recent first
  });
});

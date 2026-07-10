import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { storeCapture, listCaptures, deleteCapture, getCapture, ensureMediaRoot, MEDIA_ROOT, MAX_VIDEO_BYTES, type FileWriter } from "./captures.js";
import { processCapture, listDrafts, applyDrafts, noTranscriber, type Transcriber, type ApplyChange } from "./narration.js";
import { getDb, migrate, type DB } from "./db.js";
import { resolveModelPath } from "./transcribe.js"; // side-effect-free config helper only
import { DEFAULT_HOUSEHOLD } from "./seed.js";
import { computeShortfall } from "./engine.js";
import {
  getInventory,
  listFoodItems,
  setBucket,
  setCount,
  getFoodItem,
  updateFoodItem,
  createFoodItem,
  removeFoodItem,
  restoreFoodItem,
  findFoodItemByName,
  type FoodItemPatch,
} from "./inventory.js";
import { listStores, getStore, createStore, updateStore, deactivateStore, storeNameExists, type StoreInput, type StorePatch } from "./stores.js";
import { listRecipes, getRecipe, createRecipe, cookRecipe, deleteRecipe, type RecipeInput } from "./recipes.js";
import { fetchRecipeFromUrl } from "./importRecipe.js";
import { ZONES, STORE_KINDS, ORDER_METHODS } from "./types.js";
import { predictShortfall } from "./prediction.js";
import { quickAdd } from "./quickadd.js";
import { ingestReceipt, listUnmatched, resolveUnmatched, ignoreUnmatched } from "./receipt.js";
import { recordFeedback, computeMetrics } from "./metrics.js";
import type { Bucket } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Single household for Stage 1, but resolved from request so multi-household drops in later.
function hh(req: { headers: Record<string, unknown>; query: unknown }): string {
  const h = req.headers["x-household-id"];
  if (typeof h === "string" && h) return h;
  const q = (req.query as { household_id?: string } | undefined)?.household_id;
  return q || DEFAULT_HOUSEHOLD;
}

// App factory: takes the db so tests can inject a fresh in-memory database and drive
// routes with app.inject() — no port, no singleton. Production passes the real one.
export async function buildServer(
  db: DB,
  opts: { transcriber?: Transcriber } = {}
): Promise<FastifyInstance> {
  const transcriber = opts.transcriber ?? noTranscriber; // P1: no auto-transcription; paste path
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: resolve(__dirname, "..", "public"),
    prefix: "/",
  });
  // Video uploads (kitchen-pass captures). Cap at the module's max; a per-file limit
  // rejects oversize streams instead of buffering them.
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });

  // --- Kitchen-pass video captures (capture+upload; processing later) --
  app.post("/api/capture", async (req, reply) => {
    const household = hh(req);
    const file = await (req as unknown as { file: () => Promise<{ mimetype: string; file: NodeJS.ReadableStream } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: "no video received" });
    // Stream the upload straight to disk — never buffer the whole clip in memory.
    const writer: FileWriter = async (absPath, source) => {
      const stream = source as NodeJS.ReadableStream;
      const out = createWriteStream(absPath);
      await pipeline(stream, out);
      return out.bytesWritten;
    };
    const r = await storeCapture(db, household, { mimetype: file.mimetype, source: file.file, writer });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.capture;
  });

  app.get("/api/captures", async (req) => listCaptures(db, hh(req)));

  app.delete("/api/captures/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteCapture(db, hh(req), id, (p) => unlink(p));
    if (!ok) return reply.code(404).send({ error: "unknown capture" });
    return { ok: true };
  });

  // Narration: turn a capture into proposed changes for review. With a pasted
  // transcript this parses synchronously (fast, pure CPU). Without one, this route is
  // a TRIGGER (spec §8): it requeues the capture for the background worker rather
  // than transcribing on the request path — a 60s+ whisper run must never block an
  // HTTP response or race the worker on the same clip.
  app.post("/api/captures/:id/process", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    const cap = getCapture(db, household, id);
    if (!cap) return reply.code(404).send({ error: "unknown capture" });
    if (cap.status === "processing") {
      return reply.code(409).send({ error: "this capture is being transcribed right now — check back shortly" });
    }
    const { transcript } = (req.body ?? {}) as { transcript?: string };
    if (!transcript?.trim() && transcriber !== noTranscriber) {
      db.prepare(`UPDATE media_capture SET status = 'queued' WHERE id = ? AND household_id = ?`).run(id, household);
      return reply.code(202).send({ queued: true });
    }
    try {
      const r = await processCapture(db, household, id, { transcript, mediaPath: join(MEDIA_ROOT, cap.filename) });
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return { drafts: r.drafts };
    } catch {
      // buildDrafts already marked the capture failed; never leak internals to the client.
      return reply.code(500).send({ error: "processing failed — try again or paste the transcript" });
    }
  });

  app.get("/api/captures/:id/draft", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    const cap = getCapture(db, household, id);
    if (!cap) return reply.code(404).send({ error: "unknown capture" });
    // Decorate drafts with the matched item name so the UI needn't re-look-up.
    const drafts = listDrafts(db, household, id).map((d) => ({
      ...d,
      proposed: JSON.parse(d.proposed),
      name: d.food_item_id ? (getFoodItem(db, household, d.food_item_id)?.name ?? null) : null,
    }));
    return { transcript: cap.transcript ?? null, drafts };
  });

  app.post("/api/captures/:id/apply", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    if (!getCapture(db, household, id)) return reply.code(404).send({ error: "unknown capture" });
    const { changes } = (req.body ?? {}) as { changes?: ApplyChange[] };
    if (!Array.isArray(changes)) return reply.code(400).send({ error: "changes required" });
    return applyDrafts(db, household, id, changes);
  });

  // --- Items + inventory --------------------------------------------------------
  app.get("/api/items", async (req) => {
    const household = hh(req);
    return listFoodItems(db, household).map((item) => ({
      ...item,
      inventory: getInventory(db, household, item.id)?.state ?? null,
    }));
  });

  // Manual state entry (the periodic reconcile / "keep it honest" path).
  app.post("/api/items/:id/state", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    const body = req.body as { bucket?: Bucket; count?: number };
    const item = getFoodItem(db, household, id);
    if (!item) return reply.code(404).send({ error: "unknown food item" });

    if (item.is_discrete) {
      if (typeof body.count !== "number")
        return reply.code(400).send({ error: "discrete item requires { count }" });
      setCount(db, household, id, body.count, "manual");
    } else {
      if (!body.bucket) return reply.code(400).send({ error: "bulk item requires { bucket }" });
      setBucket(db, household, id, body.bucket, "manual");
    }
    return { ok: true, inventory: getInventory(db, household, id)?.state };
  });

  // Add an item from the app. If the name matches a REMOVED item, bring it back
  // instead — history (events, learned aliases, recipe links) picks up where it
  // left off. That doubles as the undo path for "Remove".
  app.post("/api/items", async (req, reply) => {
    const household = hh(req);
    const body = (req.body ?? {}) as {
      name?: string;
      zone?: (typeof ZONES)[number];
      is_discrete?: boolean;
      par?: number;
      reorder_point?: number;
      init?: number | string;
    };
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: "name required" });

    const existing = findFoodItemByName(db, household, name);
    if (existing?.active) return reply.code(400).send({ error: "that item is already in your kitchen" });
    if (existing) {
      return { ...restoreFoodItem(db, household, existing.id)!, restored: true };
    }

    if (!body.zone || !ZONES.includes(body.zone)) {
      return reply.code(400).send({ error: `zone must be one of: ${ZONES.join(", ")}` });
    }
    if (typeof body.is_discrete !== "boolean") {
      return reply.code(400).send({ error: "is_discrete (true = you count it) required" });
    }
    for (const numeric of ["par", "reorder_point"] as const) {
      const v = body[numeric];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return reply.code(400).send({ error: `${numeric} must be a non-negative number` });
      }
    }
    const init = body.is_discrete
      ? typeof body.init === "number" && body.init >= 0
        ? body.init
        : body.par!
      : ["full", "half", "low", "out"].includes(body.init as string)
        ? (body.init as Bucket)
        : "full";
    return createFoodItem(db, household, {
      name,
      zone: body.zone,
      is_discrete: body.is_discrete,
      par: body.par!,
      reorder_point: body.reorder_point!,
      init,
    });
  });

  // "Remove from kitchen" — soft underneath (history kept), plain words on top.
  app.delete("/api/items/:id", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    if (!removeFoodItem(db, household, id)) {
      return reply.code(404).send({ error: "unknown food item" });
    }
    return { ok: true };
  });

  // Item detail edits (UX-REDESIGN §5.5): store/brand/url/size + the tuning numbers.
  app.patch("/api/items/:id", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    if (!getFoodItem(db, household, id)) return reply.code(404).send({ error: "unknown food item" });

    const body = (req.body ?? {}) as FoodItemPatch;
    if ("zone" in body && !ZONES.includes(body.zone!)) {
      return reply.code(400).send({ error: `zone must be one of: ${ZONES.join(", ")}` });
    }
    if ("store_id" in body && body.store_id != null) {
      const store = getStore(db, household, body.store_id);
      // Soft-deleted stores are invisible in every picker — assigning to one would
      // group the item under a store the user can't see.
      if (!store || !store.active) return reply.code(400).send({ error: "unknown store" });
    }
    // Every number that feeds the reorder/prediction math must be a real, non-negative
    // number: typeof NaN === "number", and a negative reorder_point silently disables
    // reordering (count <= -1 is never true). consumption_rate may be null (unknown).
    for (const numeric of ["par", "reorder_point", "consumption_rate"] as const) {
      if (!(numeric in body)) continue;
      const v = body[numeric];
      if (numeric === "consumption_rate" && v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return reply.code(400).send({ error: `${numeric} must be a non-negative number` });
      }
    }
    return updateFoodItem(db, household, id, body);
  });

  // --- Stores (user-managed; UX-REDESIGN §6) --------------------------------------
  app.get("/api/stores", async (req) =>
    listStores(db, hh(req), (req.query as { all?: string }).all === "1")
  );

  // Mirror the store table's CHECK constraints and UNIQUE guard here so bad input gets
  // a friendly 400 instead of crashing into a SQLite constraint as a 500.
  function storeValidationError(household: string, body: StoreInput | StorePatch, excludeId?: string): string | null {
    if ("name" in body) {
      if (typeof body.name !== "string" || !body.name.trim()) return "name required";
      if (storeNameExists(db, household, body.name, excludeId)) return "a store with that name exists";
    }
    if (body.kind != null && !STORE_KINDS.includes(body.kind)) {
      return `kind must be one of: ${STORE_KINDS.join(", ")}`;
    }
    if (body.order_method != null && !ORDER_METHODS.includes(body.order_method)) {
      return `order_method must be one of: ${ORDER_METHODS.join(", ")}`;
    }
    return null;
  }

  app.post("/api/stores", async (req, reply) => {
    const household = hh(req);
    const body = (req.body ?? {}) as StoreInput;
    if (!body.name?.trim()) return reply.code(400).send({ error: "name required" });
    const err = storeValidationError(household, body);
    if (err) return reply.code(400).send({ error: err });
    return createStore(db, household, body);
  });

  app.patch("/api/stores/:id", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    if (!getStore(db, household, id)) return reply.code(404).send({ error: "unknown store" });
    const err = storeValidationError(household, (req.body ?? {}) as StorePatch, id);
    if (err) return reply.code(400).send({ error: err });
    return updateStore(db, household, id, req.body as StorePatch);
  });

  // Soft delete — items keep their history; the store just stops appearing.
  app.delete("/api/stores/:id", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    if (!getStore(db, household, id)) return reply.code(404).send({ error: "unknown store" });
    return deactivateStore(db, household, id);
  });

  // --- Recipes (UX-REDESIGN §5.3) ---------------------------------------------------
  app.get("/api/recipes", async (req) => listRecipes(db, hh(req)));

  // Paste-a-link import: extract name + raw ingredient strings from a page's
  // schema.org JSON-LD. The client maps strings to items — nothing auto-creates.
  app.post("/api/recipes/import", async (req, reply) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url?.trim()) return reply.code(400).send({ error: "url required" });
    const r = await fetchRecipeFromUrl(url.trim());
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.recipe;
  });

  app.post("/api/recipes", async (req, reply) => {
    const r = createRecipe(db, hh(req), req.body as RecipeInput);
    if (!r.ok) return reply.code(400).send(r);
    return r.recipe;
  });

  // "I made this" — cook-deplete every linked ingredient via the event log.
  app.post("/api/recipes/:id/made", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = cookRecipe(db, hh(req), id);
    if (!r.ok) return reply.code(404).send(r);
    return r;
  });

  app.delete("/api/recipes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = deleteRecipe(db, hh(req), id);
    if (!r.ok) return reply.code(404).send({ error: "unknown recipe" });
    return r;
  });

  app.get("/api/recipes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = getRecipe(db, hh(req), id);
    if (!r) return reply.code(404).send({ error: "unknown recipe" });
    return r;
  });

  // --- Shortfall list -----------------------------------------------------------
  app.get("/api/shortfall", async (req) => {
    const household = hh(req);
    const includePredicted = (req.query as { predicted?: string }).predicted !== "0"; // default ON
    return computeShortfall(db, household, { includePredicted, predictor: predictShortfall });
  });

  // --- Quick-add (step 3) -------------------------------------------------------
  app.post("/api/quickadd", async (req, reply) => {
    const household = hh(req);
    const { text, level } = req.body as { text: string; level?: "low" | "out" };
    if (!text) return reply.code(400).send({ error: "text required" });
    const result = quickAdd(db, household, text, level ?? "out");
    return reply.code(result.needs_review ? 202 : 200).send(result);
  });

  // --- Receipt ingestion + resolver (step 4) ------------------------------------
  app.post("/api/receipt", async (req, reply) => {
    const household = hh(req);
    const body = req.body as {
      lines: { raw_text: string; qty?: number; status?: string }[];
      receipt_id?: string;
    };
    if (!body?.lines?.length) return reply.code(400).send({ error: "lines required" });
    return ingestReceipt(db, household, body.lines, body.receipt_id);
  });

  app.get("/api/unmatched", async (req) => listUnmatched(db, hh(req)));

  app.post("/api/unmatched/:id/resolve", async (req, reply) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    const { food_item_id } = req.body as { food_item_id: string };
    if (!food_item_id) return reply.code(400).send({ error: "food_item_id required" });
    const r = resolveUnmatched(db, household, id, food_item_id);
    if (!r.ok) return reply.code(400).send(r);
    return r;
  });

  app.post("/api/unmatched/:id/ignore", async (req) => {
    const household = hh(req);
    const { id } = req.params as { id: string };
    return ignoreUnmatched(db, household, id);
  });

  // --- Metrics (step 6) ---------------------------------------------------------
  app.post("/api/shortfall/feedback", async (req, reply) => {
    const household = hh(req);
    const { food_item_id, predicted, verdict } = req.body as {
      food_item_id: string;
      predicted?: boolean;
      verdict: "confirmed_needed" | "false_positive" | "missed_runout";
    };
    if (!food_item_id || !verdict)
      return reply.code(400).send({ error: "food_item_id and verdict required" });
    recordFeedback(db, household, food_item_id, !!predicted, verdict);
    return { ok: true };
  });

  app.get("/api/metrics", async (req) => computeMetrics(db, hh(req)));

  return app;
}

// Run directly (dev: tsx src/server.ts · prod: node dist/server.js): use the real
// database and listen. Importing buildServer (tests) never starts a listener.
// pathToFileURL handles percent-encoding, so paths with spaces compare correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = getDb();
  migrate(db);
  ensureMediaRoot();

  // Narration P2: real STT turns on only when the model file actually exists —
  // enabling on the binary alone would burn every queued capture to 'failed' instead
  // of leaving it for the paste path. Without the model the app runs exactly as P1.
  // Dynamic imports keep transcribe/worker out of the module graph everywhere else
  // (tests inject stubs).
  const modelPath = resolveModelPath();
  const sttEnabled = existsSync(modelPath);
  if (!sttEnabled && process.env.YESCHEF_WHISPER) {
    console.warn(`YESCHEF_WHISPER is set but no model file at ${modelPath} — narration STT stays OFF (paste path only)`);
  }
  let transcriber: Transcriber | undefined;
  if (sttEnabled) {
    const { makeWhisperTranscriber } = await import("./transcribe.js");
    transcriber = makeWhisperTranscriber();
  }

  const app = await buildServer(db, transcriber ? { transcriber } : {});
  if (transcriber) {
    const { startCaptureWorker } = await import("./worker.js");
    startCaptureWorker(db, { transcriber });
  }

  const port = Number(process.env.PORT ?? 3000);
  app
    .listen({ port, host: "0.0.0.0" })
    .then(() => {
      console.log(`Yes Chef! Stage-1 running at http://localhost:${port}`);
      console.log(sttEnabled ? `narration STT enabled (model: ${modelPath})` : "narration STT off (no whisper model found) — paste-transcript path only");
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

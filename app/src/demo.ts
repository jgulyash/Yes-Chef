import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "./db.js";
import { seed, loadStaples, DEFAULT_HOUSEHOLD as HH } from "./seed.js";
import { computeShortfall } from "./engine.js";
import { predictShortfall } from "./prediction.js";
import { quickAdd } from "./quickadd.js";
import { ingestReceipt, listUnmatched, resolveUnmatched } from "./receipt.js";
import { recordFeedback, computeMetrics } from "./metrics.js";
import { listFoodItems } from "./inventory.js";
import type { ShortfallItem } from "./types.js";

// Self-contained demonstration of the cheap loop — no UI, no server. Seeds the frozen
// SAMPLE staples (not your personal data/staples.json — the narration below references
// sample names like Onions), runs all four flows, and prints the weekly shortfall list.
const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
migrate(db);
seed(db, HH, loadStaples(resolve(__dirname, "..", "data", "staples.sample.json")));

const idOf = (name: string) => listFoodItems(db, HH).find((i) => i.name === name)!.id;
const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(64));

function printShortfall(rows: ShortfallItem[]): void {
  if (!rows.length) return line("  (nothing — fully stocked)");
  for (const r of rows) {
    const flag = r.predicted ? "  confirm? " : "  LOW      ";
    const state = r.state.kind === "count" ? `count ${r.state.count}` : r.state.bucket;
    line(`${flag}${r.name.padEnd(20)} ${r.zone.padEnd(13)} ${state.padEnd(10)} need: ${r.need}`);
    line(`            ↳ ${r.reason}`);
  }
}

line();
line("🧑‍🍳  Yes Chef! — Stage-1 cheap-loop demo");
rule();
line("Seeded 30 staples at par. Initial shortfall list:");
printShortfall(computeShortfall(db, HH));

line();
line("① Quick-add (resolved through the alias table):");
for (const text of ["we're out of olive oil", "low on eggs", "out of dragon fruit"]) {
  const r = quickAdd(db, HH, text, "out");
  line(`   "${text}"  →  ${r.message}`);
}

line();
line("② Receipt ingestion (post-delivery: subs/refunds):");
const receipt = ingestReceipt(db, HH, [
  { raw_text: "whl milk", qty: 1, status: "delivered" },
  { raw_text: "large eggs", qty: 12, status: "delivered" },
  { raw_text: "fresh basil", qty: 1, status: "refunded" }, // not credited
  { raw_text: "TJ's seasonal squash blend", qty: 1, status: "delivered" }, // unknown → queue
]);
line(`   credited: ${receipt.applied.map((a) => `${a.name} +${a.qty}`).join(", ")}`);
line(`   refunded (not credited): ${receipt.refunded.map((r) => r.raw_text).join(", ")}`);
line(`   unmatched → review: ${receipt.unmatched.map((u) => u.raw_text).join(", ")}`);

line();
line("③ Review queue — teach the resolver once (feedback loop):");
for (const m of listUnmatched(db, HH)) line(`   pending: "${m.raw_text}" (${m.source_type})`);
// The human maps the squash blend to a staple; the alias is learned for next time.
const squash = listUnmatched(db, HH).find((m) => m.raw_text.includes("squash"));
if (squash) {
  resolveUnmatched(db, HH, squash.id, idOf("Onions"));
  line(`   resolved "${squash.raw_text}" → Onions (alias learned; won't ask again)`);
}

line();
line("④ Predicted depletion — fast-forward 6 days at usual consumption rates:");
const future = new Date(Date.now() + 6 * 86400_000).toISOString();
const predicted = predictShortfall(db, HH, future).map((r) => r.name);
line(`   newly predicted to cross reorder point: ${predicted.join(", ") || "(none)"}`);

line();
rule();
line("📋  WEEKLY SHORTFALL LIST  (hard triggers + predicted 'confirm?')");
rule();
printShortfall(computeShortfall(db, HH, { includePredicted: true, predictor: predictShortfall, asOfIso: future }));

line();
line("Metrics (after logging one confirmed need):");
recordFeedback(db, HH, idOf("Olive oil"), false, "confirmed_needed");
const m = computeMetrics(db, HH);
const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
line(
  `   precision ${pct(m.precision)} · recall ${pct(m.recall)} · ` +
    `${m.weekly_upkeep.events_last_7d} touches/7d · ${m.weekly_upkeep.pending_unmatched} in review`
);
line();

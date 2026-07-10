// Yes Chef! — product UI (Phase C). A thin vanilla SPA over the existing HTTP API.
// IA: List / Kitchen / Add / Stats. Binding design decisions:
// list rows keep ✓/✗ verdicts, Stats keeps missed-runout logging, Add keeps the
// unmatched review queue, first-run onboarding, self-hosted fonts, no video.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// --- Icon system: one hand-drawn stroke set, same 2px weight as the toque logo. ----
const ICON_PATHS = {
  list: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 3.5h6v3H9z"/><path d="M9 13l2 2 4-4.5"/>',
  kitchen: '<path d="M3 11l9-7.5L21 11"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  stats: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  pantry: '<rect x="6.5" y="8" width="11" height="12" rx="2"/><path d="M8.5 4.5h7V8h-7z"/><path d="M6.5 13h11"/>',
  refrigerated: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M6 10.5h12"/><path d="M9 6v2M9 13.5v3"/>',
  frozen: '<path d="M12 3v18M6 6.5l12 11M18 6.5l-12 11"/>',
  deep_freezer: '<rect x="4" y="9" width="16" height="10" rx="2"/><path d="M4 13h16M10.5 11h3"/><path d="M12 2.5v4M10 3.5l4 2M14 3.5l-4 2"/>',
  counter: '<path d="M4 11.5h16"/><path d="M5 11.5a7 7 0 0 0 14 0"/><path d="M9 20h6"/>',
  recipes: '<path d="M12 6c-2-1.6-4.8-1.6-8-.5v13c3.2-1.1 6-1.1 8 .5 2-1.6 4.8-1.6 8-.5v-13c-3.2-1.1-6-1.1-8 .5z"/><path d="M12 6v13.5"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  next: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
};
const icon = (name, size = 22, cls = "") =>
  `<svg class="ic-svg ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;

// Light haptic tick where the platform offers it (Android Chrome; harmless elsewhere).
const vib = () => navigator.vibrate?.(8);

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  let res;
  try {
    // Only claim a JSON body when there is one — Fastify 400s an EMPTY body that
    // arrives with a JSON content-type (bit the unmatched "ignore" action).
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    res = await fetch(path, { headers, ...opts });
  } catch {
    throw new Error("Couldn't reach the kitchen — check the app is running.");
  }
  if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 202) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch {}
    throw new Error(msg);
  }
  if (res.status >= 500) throw new Error("Something went wrong on the kitchen side.");
  return res.json();
}

// --- Toasts, busy-states, deferred-undo posts (carried from the UX pass) -----------
function toast(message, { kind = "info", undo = null, ttl = 3200 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (undo) {
    const btn = document.createElement("button");
    btn.className = "undo-btn";
    btn.textContent = "Undo";
    btn.addEventListener("click", () => { undo(); el.remove(); });
    el.appendChild(btn);
    ttl = 5200;
  }
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    toast(e.message || "That didn't save — try again.", { kind: "error" });
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

const pendingPosts = new Set();
function deferredPost(desc, path, body, onDone) {
  const entry = { path, body };
  pendingPosts.add(entry);
  const timer = setTimeout(async () => {
    pendingPosts.delete(entry);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      onDone?.();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }, 5000);
  toast(desc, { undo: () => { clearTimeout(timer); pendingPosts.delete(entry); } });
}
window.addEventListener("pagehide", () => {
  for (const { path, body } of pendingPosts) {
    navigator.sendBeacon(path, new Blob([JSON.stringify(body)], { type: "application/json" }));
  }
  pendingPosts.clear();
});

// --- State --------------------------------------------------------------------------
const S = {
  tab: "kitchen", // home = the kitchen (drawer navigates elsewhere)
  groupBy: localStorage.getItem("yc_groupby") || "store",
  zone: null, // Kitchen: null = hub, "recipes", or a zone key
  items: [],
  stores: [],
  recipes: [],
  shortfall: [],
  metrics: null,
  unmatched: [],
  captures: [],
  addingRecipe: false,
  addingItem: false,
};

const ZONES = [
  { key: "pantry", label: "Pantry" },
  { key: "refrigerated", label: "Fridge" },
  { key: "frozen", label: "Freezer" },
  { key: "deep_freezer", label: "Deep Freezer" },
  { key: "counter", label: "Counter" },
];
const zoneLabel = (z) => ZONES.find((x) => x.key === z)?.label ?? z;

// Weekly "got it" check-offs are local UI state (you're marking your own cart progress,
// not kitchen truth). Keyed by ISO week so the list resets each week.
function weekKey() {
  const d = new Date();
  const jan = new Date(d.getFullYear(), 0, 1);
  const wk = Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7);
  return `yc_done_${d.getFullYear()}w${wk}`;
}
const doneSet = () => new Set(JSON.parse(localStorage.getItem(weekKey()) || "[]"));
const saveDone = (set) => localStorage.setItem(weekKey(), JSON.stringify([...set]));

const itemById = (id) => S.items.find((i) => i.id === id);
const stateLabel = (inv) => (!inv ? "—" : inv.kind === "count" ? `${inv.count}` : inv.bucket);

// One option-builder for EVERY item dropdown, so pickers can't drift apart.
// A placeholder forces an explicit choice — silent first-item defaults already caused
// one wrong-match bug class; never build item <option>s any other way.
const itemOptions = (preselectId = null, placeholder = null) =>
  (placeholder ? `<option value="" selected>${esc(placeholder)}</option>` : "") +
  S.items
    .map((i) => `<option value="${esc(i.id)}" ${i.id === preselectId ? "selected" : ""}>${esc(i.name)}</option>`)
    .join("");

// --- Data loading ---------------------------------------------------------------------
async function loadAll() {
  [S.items, S.stores, S.recipes, S.shortfall, S.metrics, S.unmatched, S.captures] = await Promise.all([
    api("/api/items"),
    api("/api/stores"),
    api("/api/recipes"),
    api("/api/shortfall"),
    api("/api/metrics"),
    api("/api/unmatched"),
    api("/api/captures"),
  ]);
}
async function refresh() {
  try {
    await loadAll();
    render();
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

// --- Render dispatch --------------------------------------------------------------------
// `navigate: true` = a screen change (tab/place) — animate it with a view transition.
// State mutations render WITHOUT one: snapshots would add latency to the taps we've
// just made instant.
function render(opts = {}) {
  const paint = () => {
    const day = new Date().toLocaleDateString(undefined, { weekday: "long" });
    $("#brand-sub").textContent = `Your kitchen · ${day}`;
    $$(".drawer-item").forEach((t) => t.classList.toggle("on", t.dataset.tab === S.tab));
    const badge = $("#add-badge");
    badge.hidden = !S.unmatched.length;
    badge.textContent = S.unmatched.length;
    $("#menu-dot").hidden = !S.unmatched.length; // review-queue nudge on the hamburger
    const views = { list: renderList, kitchen: renderKitchen, add: renderAdd, stats: renderStats };
    $("#panel").innerHTML = views[S.tab]();
    if (opts.navigate) $("#panel").scrollTop = 0;
  };
  if (opts.navigate && document.startViewTransition && !reducedMotion && document.visibilityState === "visible") {
    // Overlapping or hidden-tab transitions abort — that's fine, just don't let the
    // rejection surface as an unhandled exception.
    const vt = document.startViewTransition(paint);
    vt.finished.catch(() => {});
    vt.ready.catch(() => {});
  } else {
    paint();
  }
}

function renderSkeleton() {
  $("#panel").innerHTML = `
    <div class="skel skel-title"></div>
    <div class="skel skel-sub"></div>
    <div class="stat-tiles">${'<div class="skel skel-tile"></div>'.repeat(3)}</div>
    ${'<div class="skel skel-row"></div>'.repeat(5)}`;
}

// --- List tab ------------------------------------------------------------------------------
function renderList() {
  const done = doneSet();
  const out = S.shortfall.filter((s) => (s.state?.kind === "count" ? s.state.count === 0 : s.state?.bucket === "out")).length;
  const rows = S.shortfall;
  const groups = new Map();
  for (const s of rows) {
    const key = S.groupBy === "store" ? (s.store_name ?? "Unassigned") : zoneLabel(s.zone);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const groupHtml = rows.length
    ? [...groups.entries()]
        .map(
          ([label, list]) => `
      <div class="group-head"><span class="dot" style="background:var(--z-${esc(list[0].zone)}, var(--basil))"></span>${esc(label)} · ${list.length}</div>
      ${list.map((s) => listRow(s, done)).join("")}`
        )
        .join("")
    : `<div class="empty-state">${icon("check", 34)}<p>Nothing needed this week.<br>Fully stocked.</p></div>`;

  const remaining = rows.filter((s) => !done.has(s.food_item_id)).length;
  return `
    <h2 class="screen-title">This week</h2>
    <p class="screen-sub"><span class="ticker" id="remaining-count">${remaining}</span> to go · tap the circle as you shop · ✓/✗ teaches the list.</p>
    <div class="stat-tiles">
      <div class="tile t-out"><span class="big">${out}</span><span class="lbl">out</span></div>
      <div class="tile t-low"><span class="big">${rows.length - out}</span><span class="lbl">low / predicted</span></div>
      <div class="tile"><span class="big">${S.items.length}</span><span class="lbl">tracked</span></div>
    </div>
    <div class="seg">
      <button data-action="groupby" data-v="store" class="${S.groupBy === "store" ? "on" : ""}">By store</button>
      <button data-action="groupby" data-v="zone" class="${S.groupBy === "zone" ? "on" : ""}">By zone</button>
    </div>
    ${groupHtml}`;
}

function listRow(s, done) {
  const isDone = done.has(s.food_item_id);
  return `
  <div class="lrow ${isDone ? "done" : ""}" data-id="${esc(s.food_item_id)}">
    <button class="checkoff" data-action="checkoff" data-id="${esc(s.food_item_id)}" aria-label="Mark ${esc(s.name)} handled"><span class="ring">${icon("check", 15)}</span></button>
    <div class="body">
      <div class="nm">${esc(s.name)} ${s.predicted ? '<span class="pill confirm">confirm?</span>' : '<span class="pill low">low</span>'}</div>
      <div class="meta">now: ${esc(stateLabel(s.state))} · get: ${esc(String(s.need))}</div>
    </div>
    <div class="verdicts">
      <button data-action="verdict" data-v="confirmed_needed" data-id="${esc(s.food_item_id)}" data-pred="${s.predicted}" data-name="${esc(s.name)}" aria-label="${esc(s.name)}: needed">✓</button>
      <button data-action="verdict" data-v="false_positive" data-id="${esc(s.food_item_id)}" data-pred="${s.predicted}" data-name="${esc(s.name)}" aria-label="${esc(s.name)}: not really">✗</button>
    </div>
    <button class="open-detail" data-action="detail" data-id="${esc(s.food_item_id)}" aria-label="Details for ${esc(s.name)}">${icon("next", 18)}</button>
  </div>`;
}

// --- Kitchen tab ------------------------------------------------------------------------------
function renderKitchen() {
  if (S.zone === "recipes") return renderRecipes();
  if (S.zone) return renderPlace(S.zone);

  const lowByZone = {};
  for (const s of S.shortfall) lowByZone[s.zone] = (lowByZone[s.zone] || 0) + 1;

  const ring = (frac, color) => {
    const r = 15.9155; // circumference 100 for easy dasharray math
    return `<svg class="ring-svg" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--hair)" stroke-width="3.5"/>
      <circle cx="18" cy="18" r="${r}" fill="none" stroke="${color}" stroke-width="3.5"
        stroke-linecap="round" stroke-dasharray="${Math.round(frac * 100)} 100"
        transform="rotate(-90 18 18)"/>
    </svg>`;
  };

  const lowNamesByZone = {};
  for (const s of S.shortfall) (lowNamesByZone[s.zone] ??= []).push(s.name);

  const cards = ZONES.map((z) => {
    const items = S.items.filter((i) => i.zone === z.key);
    const low = (lowNamesByZone[z.key] ?? []).length;
    const stocked = items.length ? (items.length - low) / items.length : 0;
    const meta = items.length
      ? `${items.length} items${low ? ` · <span class="warn">${low} to reorder</span>` : " · stocked"}`
      : "Empty · tap to set up";
    const names = lowNamesByZone[z.key] ?? [];
    const preview = names.length
      ? `<div class="pc-low">Low: ${esc(names.slice(0, 2).join(", "))}${names.length > 2 ? ` +${names.length - 2}` : ""}</div>`
      : items.length
        ? `<div class="pc-low ok">All stocked</div>`
        : "";
    return `
    <button class="place-card" data-action="place" data-zone="${z.key}" style="--zc:var(--z-${z.key})">
      <div class="pc-top">
        <span class="ic-chip" style="color:var(--zc)">${icon(z.key, 20)}</span>
        ${items.length ? ring(stocked, `var(--zc)`) : ""}
      </div>
      <div class="pn">${z.label}</div>
      <div class="pm">${meta}</div>
      ${preview}
    </button>`;
  }).join("");

  const readyRecipes = S.recipes.filter((r) => r.ready);
  const attention = S.shortfall.slice(0, 4); // hard shortfalls sort first

  return `
    <h2 class="screen-title">Kitchen</h2>
    <p class="screen-sub">Go to a place and look — just like real life.</p>

    <button class="week-tile" data-action="goto" data-tab="list">
      <div>
        <span class="wt-num">${S.shortfall.length}</span>
        <span class="wt-label">to buy this week</span>
      </div>
      ${icon("next", 20)}
    </button>

    <div class="places">
      ${cards}
      <button class="place-card" data-action="place" data-zone="recipes" style="--zc:var(--z-recipes)">
        <div class="pc-top"><span class="ic-chip" style="color:var(--zc)">${icon("recipes", 20)}</span></div>
        <div class="pn">Recipes</div>
        <div class="pm">${S.recipes.length ? `${S.recipes.length} saved · ${readyRecipes.length} ready` : "None yet · add one"}</div>
      </button>
    </div>

    ${attention.length ? `
    <div class="group-head" style="margin-top:20px">Needs attention</div>
    ${attention
      .map(
        (s) => `
      <button class="attn-row" data-action="detail" data-id="${esc(s.food_item_id)}">
        <span class="dot" style="background:var(--z-${esc(s.zone)})"></span>
        <span class="attn-name">${esc(s.name)}</span>
        <span class="attn-meta">${esc(zoneLabel(s.zone))} · now ${esc(stateLabel(s.state))}</span>
        ${icon("next", 16)}
      </button>`
      )
      .join("")}` : ""}

    ${readyRecipes.length ? `
    <div class="group-head" style="margin-top:20px">Ready tonight</div>
    <div class="ready-strip">
      ${readyRecipes
        .slice(0, 6)
        .map(
          (r) => `<button class="ready-chip" data-action="place" data-zone="recipes">${icon("recipes", 15)} ${esc(r.name)}</button>`
        )
        .join("")}
    </div>` : ""}`;
}

function renderPlace(zone) {
  const items = S.items
    .filter((i) => i.zone === zone)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const body = items.length
    ? items.map(placeRow).join("") +
      `<button class="linecheck-btn" data-action="linecheck" data-zone="${zone}">${icon("check", 18)} Line Check — walk ${esc(zoneLabel(zone))}, confirm every item</button>`
    : `<div class="empty-state">${icon(zone, 34)}<p>Nothing in your ${esc(zoneLabel(zone))} yet —<br>add the first thing below.</p></div>`;

  return `
    <button class="back-btn" data-action="place" data-zone="">${icon("back", 18)} Kitchen</button>
    <div class="place-head" style="--zc:var(--z-${zone})">
      <span class="ic-chip big" style="color:var(--zc)">${icon(zone, 26)}</span>
      <div>
        <h2 class="screen-title">${esc(zoneLabel(zone))}</h2>
        <p class="screen-sub">${items.length} items, lowest first. Changes save instantly.</p>
      </div>
    </div>
    ${body}
    ${S.addingItem ? addItemForm(zone) : `<button class="linecheck-btn" data-action="item-new">＋ Add an item to ${esc(zoneLabel(zone))}</button>`}`;
}

const BUCKET_LEVELS = { full: 100, half: 55, low: 20, out: 0 };
function levelBar(bucket) {
  const w = BUCKET_LEVELS[bucket] ?? 0;
  return `<div class="level-bar" aria-hidden="true"><span style="width:${w}%"></span></div>`;
}

function addItemForm(zone) {
  return `
  <div class="card" id="item-editor">
    <strong>New item in ${esc(zoneLabel(zone))}</strong>
    <div class="field"><label for="ni-name">What is it?</label><input id="ni-name" placeholder="e.g. Hot sauce" autocomplete="off" /></div>
    <div class="field">
      <label for="ni-kind">How do you track it?</label>
      <select id="ni-kind">
        <option value="bulk">I eyeball the level (jars, bags, bottles)</option>
        <option value="discrete">I count them (eggs, cans, pouches)</option>
      </select>
    </div>
    <div class="field-row" id="ni-bulk-fields">
      <div class="field"><label for="ni-level">Right now it's…</label>
        <select id="ni-level"><option>full</option><option>half</option><option>low</option><option>out</option></select>
      </div>
    </div>
    <div class="field-row" id="ni-count-fields" hidden>
      <div class="field"><label for="ni-count">How many now?</label><input id="ni-count" type="number" min="0" value="1" /></div>
      <div class="field"><label for="ni-par">Keep on hand</label><input id="ni-par" type="number" min="0" value="2" /></div>
      <div class="field"><label for="ni-rp">Reorder at</label><input id="ni-rp" type="number" min="0" value="1" /></div>
    </div>
    <div class="field-row" style="margin-top:8px">
      <button class="primary" data-action="item-create" data-zone="${zone}" style="flex:1">Add it</button>
      <button class="ghost" data-action="item-cancel">Cancel</button>
    </div>
  </div>`;
}

function rank(i) {
  const inv = i.inventory;
  if (!inv) return 2;
  if (inv.kind === "count") return inv.count <= i.reorder_point ? 0 : 1 + inv.count / (i.par || 1);
  return { out: 0, low: 0.5, half: 1.5, full: 3 }[inv.bucket];
}

function placeRow(i) {
  const inv = i.inventory;
  const low = inv && (inv.kind === "count" ? inv.count <= i.reorder_point : inv.bucket === "low" || inv.bucket === "out");
  return `
  <div class="prow" data-id="${esc(i.id)}">
    <div class="top">
      <span class="nm">${esc(i.name)} ${low ? '<span class="pill low">low</span>' : ""}</span>
      <button class="open-detail" data-action="detail" data-id="${esc(i.id)}" aria-label="Details for ${esc(i.name)}">${icon("next", 18)}</button>
    </div>
    ${!i.is_discrete && inv?.kind === "bucket" ? levelBar(inv.bucket) : ""}
    <div class="controls">${stateControls(i, inv)}</div>
  </div>`;
}

function stateControls(i, inv) {
  if (i.is_discrete) {
    const c = inv?.kind === "count" ? inv.count : 0;
    return `
      <div class="stepper">
        <button data-action="step" data-id="${esc(i.id)}" data-d="-1" aria-label="One less ${esc(i.name)}">−</button>
        <span class="cnt">${c}</span>
        <button data-action="step" data-id="${esc(i.id)}" data-d="1" aria-label="One more ${esc(i.name)}">+</button>
      </div>
      <button class="ghost" data-action="setcount" data-id="${esc(i.id)}" data-v="0">Out</button>`;
  }
  const b = inv?.kind === "bucket" ? inv.bucket : null;
  return `<div class="chips">${["full", "half", "low", "out"]
    .map((v) => `<button data-action="setbucket" data-id="${esc(i.id)}" data-v="${v}" class="${b === v ? "on" : ""}">${v}</button>`)
    .join("")}</div>`;
}

// --- Recipes (a place inside Kitchen) ----------------------------------------------------------
function renderRecipes() {
  const list = S.recipes.length
    ? S.recipes.map(recipeRow).join("")
    : `<p class="empty">No recipes yet. Save one and "I made this" updates your kitchen for you.</p>`;
  return `
    <button class="back-btn" data-action="place" data-zone="">${icon("back", 18)} Kitchen</button>
    <h2 class="screen-title">Recipes</h2>
    <p class="screen-sub">Tap "I made this" and the ingredients deplete themselves.</p>
    ${list}
    ${S.addingRecipe ? recipeEditor() : `<button class="linecheck-btn" data-action="recipe-new">＋ Add a recipe</button>`}`;
}

function recipeRow(r) {
  const ing = r.ingredients.map((x) => esc(x.name) + (x.optional ? "*" : "")).join(" · ");
  return `
  <div class="rrow" data-id="${esc(r.id)}">
    <div class="top">
      <span class="nm">${esc(r.name)}</span>
      ${r.ready ? '<span class="pill ready">ready</span>' : `<span class="pill missing">missing ${r.missing_count}</span>`}
    </div>
    <div class="ing">${ing}</div>
    <div class="actions">
      <button class="primary" data-action="cook" data-id="${esc(r.id)}" data-name="${esc(r.name)}">I made this</button>
      <button class="ghost" data-action="recipe-del" data-id="${esc(r.id)}" data-name="${esc(r.name)}">Remove</button>
    </div>
  </div>`;
}

function recipeEditor() {
  const opts = itemOptions();
  return `
  <div class="card" id="recipe-editor">
    <div class="field"><label for="rc-url">Have a link? Paste it and I'll read the recipe</label>
      <div class="field-row">
        <input id="rc-url" placeholder="https://…" inputmode="url" autocomplete="off" style="flex:1" />
        <button class="ghost" data-action="rc-import">Import</button>
      </div>
    </div>
    <div class="field"><label for="rc-name">Recipe name</label><input id="rc-name" placeholder="e.g. Taco night" /></div>
    <div class="ing-editor" id="rc-ings">
      <div class="ing-wrap"><div class="ing-line">
        <label class="sr-only">Ingredient</label><select class="rc-item">${opts}</select>
        <label class="sr-only">Quantity</label><input class="rc-qty" type="number" min="1" value="1" />
        <label class="opt"><input type="checkbox" class="rc-opt" />optional</label>
        <button class="rm" data-action="rc-rm" aria-label="Remove ingredient">✕</button>
      </div></div>
    </div>
    <button class="ghost" data-action="rc-add-line">＋ ingredient</button>
    <div class="field-row" style="margin-top:10px">
      <button class="primary" data-action="rc-save" style="flex:1">Save recipe</button>
      <button class="ghost" data-action="rc-cancel">Cancel</button>
    </div>
  </div>`;
}

const ING_LINE = (preselectId = null, qty = 1, rawText = null) => {
  // Imported-but-unmatched lines get a forced "(choose item)" placeholder — a wrong
  // silent default would quietly deplete the wrong thing on "I made this".
  const opts = itemOptions(preselectId, rawText && !preselectId ? "(choose item)" : null);
  const div = document.createElement("div");
  div.className = "ing-wrap";
  div.innerHTML = `<div class="ing-line">
    <label class="sr-only">Ingredient</label><select class="rc-item">${opts}</select>
    <label class="sr-only">Quantity</label><input class="rc-qty" type="number" min="1" value="${qty}" />
    <label class="opt"><input type="checkbox" class="rc-opt" />optional</label>
    <button class="rm" data-action="rc-rm" aria-label="Remove ingredient">✕</button>
  </div>${rawText ? `<div class="ing-raw">from recipe: “${esc(rawText)}”${preselectId ? " — best guess, check me" : " — pick the matching item or remove"}</div>` : ""}`;
  return div;
};

// Best-guess matching for imported ingredient lines: an item matches when its name
// appears in the raw string (or every word of a multi-word name does). Client-side
// convenience only — the user confirms in the picker; nothing is auto-created.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matchItemToRaw(raw) {
  const r = raw.toLowerCase();
  let best = null;
  for (const i of S.items) {
    const name = i.name.toLowerCase();
    // Whole-word matches only ("Rice" no longer matches "riced cauliflower"), every
    // word of multi-word names required. Still a best GUESS the user confirms — the
    // hint under the line says so.
    const whole = new RegExp(`\\b${escRe(name)}\\b`).test(r);
    const words = name.split(/\s+/).filter((w) => w.length > 2);
    const hit = whole || (words.length > 1 && words.every((w) => new RegExp(`\\b${escRe(w)}\\b`).test(r)));
    if (hit && (!best || name.length > best.name.toLowerCase().length)) best = i;
  }
  return best;
}

// --- Add tab --------------------------------------------------------------------------------------
function renderAdd() {
  return `
    <h2 class="screen-title">Add groceries</h2>
    <p class="screen-sub">Bought something? Ran out? Tell the kitchen here.</p>

    <div class="card">
      <strong>Quick update</strong>
      <p class="hint">Noticed something's low or gone? Just type it.</p>
      <div class="field-row">
        <div class="field" style="flex:2"><label for="qa-text">Item</label><input id="qa-text" placeholder="e.g. olive oil" autocomplete="off" /></div>
        <div class="field"><label for="qa-level">It's…</label><select id="qa-level"><option value="out">all gone</option><option value="low">running low</option></select></div>
      </div>
      <button class="primary" data-action="quickadd">Update</button>
    </div>

    <div class="card">
      <strong>Paste your order or receipt</strong>
      <p class="hint">One item per line — a count first if more than one. <code>#refunded</code> / <code>#substituted</code> if the store changed something.</p>
      <div class="field"><label for="rc-text">Receipt lines</label><textarea id="rc-text" rows="5" placeholder="2 large eggs&#10;1 milk&#10;1 fresh basil #refunded"></textarea></div>
      <div id="rc-preview" class="preview" hidden></div>
      <button class="primary" data-action="receipt">Add to kitchen</button>
    </div>

    <div class="card">
      <strong>Record a kitchen pass</strong>
      <p class="hint">Walk through the kitchen filming — narrate what's low as you go ("milk's low, out of eggs"). It saves here; automatic reading from the video comes in a later update.</p>
      <label class="capture-btn" for="cap-file">${icon("recipes", 18)} Record or choose a video
        <input id="cap-file" type="file" accept="video/*" capture="environment" hidden />
      </label>
      <div id="cap-status" class="hint" style="margin-top:8px"></div>
      ${
        S.captures.length
          ? `<div class="captures">${S.captures
              .map(
                (c) => `
        <div class="caprow" data-id="${esc(c.id)}">
          <span class="cap-ic">${icon("recipes", 16)}</span>
          <div class="cap-body">
            <div class="cap-name">${esc(new Date(c.captured_at).toLocaleString())}</div>
            <div class="cap-meta">${(c.bytes / 1e6).toFixed(1)} MB · <span class="pill low">${esc(c.status)}</span></div>
          </div>
          <button class="ghost cap-del" data-action="cap-review" data-id="${esc(c.id)}">Review</button>
          <button class="ghost cap-del" data-action="capture-del" data-id="${esc(c.id)}" aria-label="Remove this video">✕</button>
        </div>`
              )
              .join("")}</div>`
          : `<div class="empty-state small">${icon("recipes", 26)}<p>No kitchen passes yet.</p></div>`
      }
    </div>

    <div class="card">
      <strong>Needs a look ${S.unmatched.length ? `<span class="pill low">${S.unmatched.length}</span>` : ""}</strong>
      <p class="hint">Things I couldn't match to your items. Tell me once — I'll remember.</p>
      ${
        S.unmatched.length
          ? S.unmatched
              .map(
                (u) => `
        <div class="urow" data-id="${esc(u.id)}">
          <span class="q">"${esc(u.raw_text)}" <span class="pill low">${esc(u.source_type)}</span></span>
          <div class="acts">
            <label class="sr-only" for="pick-${esc(u.id)}">Match to item</label>
            <select id="pick-${esc(u.id)}">${itemOptions(null, "(choose item)")}</select>
          </div>
          <div class="acts">
            <button class="primary" data-action="resolve" data-id="${esc(u.id)}" style="flex:1">This is that item</button>
            <button class="ghost" data-action="ignore" data-id="${esc(u.id)}">Not mine</button>
          </div>
        </div>`
              )
              .join("")
          : `<div class="empty-state small">${icon("check", 26)}<p>All matched.</p></div>`
      }
    </div>`;
}

function parseReceipt(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      let status = "delivered";
      const m = line.match(/#(\w+)\s*$/);
      let body = line;
      if (m) { status = m[1]; body = line.slice(0, m.index).trim(); }
      const q = body.match(/^(\d+)\s+(.*)$/);
      return { raw_text: q ? q[2] : body, qty: q ? Number(q[1]) : 1, status };
    });
}

function renderReceiptPreview() {
  const el = $("#rc-preview");
  if (!el) return;
  const lines = parseReceipt($("#rc-text").value);
  el.hidden = !lines.length;
  el.innerHTML = lines.length
    ? `<div class="preview-title">I read that as:</div>` +
      lines
        .map((l) => {
          const flag =
            l.status === "refunded"
              ? ' <span class="pill out">refunded — won\'t be added</span>'
              : l.status === "substituted"
                ? ' <span class="pill low">substituted</span>'
                : "";
          return `<div>${l.qty} × ${esc(l.raw_text)}${flag}</div>`;
        })
        .join("")
    : "";
}

// --- Stats tab ---------------------------------------------------------------------------------------
function renderStats() {
  const m = S.metrics;
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  return `
    <h2 class="screen-title">Report card</h2>
    <p class="screen-sub">How the list is doing — graded by you.</p>
    <div class="metric-tiles">
      <div class="mtile"><span class="big">${pct(m.precision)}</span><div><div class="lbl">right when it listed something</div><div class="sub">${m.counts.confirmed_needed} needed · ${m.counts.false_positive} not really</div></div></div>
      <div class="mtile"><span class="big">${pct(m.recall)}</span><div><div class="lbl">caught before you ran out</div><div class="sub">${m.counts.missed_runout} missed</div></div></div>
      <div class="mtile"><span class="big">${m.weekly_upkeep.events_last_7d}</span><div><div class="lbl">updates this week</div><div class="sub">${m.weekly_upkeep.pending_unmatched} waiting for a look</div></div></div>
    </div>
    <div class="card">
      <strong>The list missed one?</strong>
      <p class="hint">Ran out of something it never flagged? Log it — that's how it learns.</p>
      <div class="field"><label for="missed-item">Item</label><select id="missed-item">${itemOptions(null, "(choose item)")}</select></div>
      <button class="ghost" data-action="missed">We ran out — the list missed it</button>
    </div>`;
}

// --- Item detail sheet ----------------------------------------------------------------------------------
function openSheet(itemId) {
  const i = itemById(itemId);
  if (!i) return;
  const storeOpts =
    `<option value="">Unassigned</option>` +
    S.stores.map((s) => `<option value="${esc(s.id)}" ${i.store_id === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("") +
    `<option value="__new">＋ Add new store…</option>`;
  const zoneOpts = ZONES.map((z) => `<option value="${z.key}" ${i.zone === z.key ? "selected" : ""}>${z.label}</option>`).join("");
  $("#sheet-root").innerHTML = `
    <div class="sheet-backdrop" data-action="sheet-close"></div>
    <div class="sheet" role="dialog" aria-label="${esc(i.name)} details" data-item="${esc(i.id)}">
      <div class="grab"></div>
      <h3>${esc(i.name)}</h3>
      <div class="zline">${esc(zoneLabel(i.zone))} · keep ${i.par} · flag at ${i.reorder_point}</div>
      <div class="controls">${stateControls(i, i.inventory)}</div>

      <div class="sheet-section">
        <div class="st">Where you buy it</div>
        <div class="field"><label for="sh-store">Store</label><select id="sh-store" data-action="sheet-store">${storeOpts}</select></div>
        <div id="sh-newstore" hidden class="field-row">
          <div class="field" style="flex:1"><label for="sh-newname">New store name</label><input id="sh-newname" placeholder="e.g. Target" /></div>
          <button class="primary" data-action="store-create" style="align-self:flex-end">Add</button>
        </div>
        <div class="field-row">
          <div class="field"><label for="sh-brand">Brand</label><input id="sh-brand" value="${esc(i.brand ?? "")}" placeholder="e.g. Brand name" /></div>
          <div class="field"><label for="sh-size">Package size</label><input id="sh-size" value="${esc(i.package_size ?? "")}" placeholder="e.g. 40 ct" /></div>
        </div>
        <div class="field"><label for="sh-url">Order link (optional)</label><input id="sh-url" value="${esc(i.order_url ?? "")}" placeholder="https://…" /></div>
      </div>

      <div class="sheet-section">
        <div class="st">Tuning</div>
        <div class="field-row">
          <div class="field"><label for="sh-zone">Zone</label><select id="sh-zone">${zoneOpts}</select></div>
          <div class="field"><label for="sh-par">Keep (par)</label><input id="sh-par" type="number" min="0" value="${i.par}" /></div>
          <div class="field"><label for="sh-rp">Flag at</label><input id="sh-rp" type="number" min="0" value="${i.reorder_point}" /></div>
        </div>
        <button class="primary" data-action="sheet-save" style="width:100%">Save details</button>
      </div>

      <div class="sheet-section">
        <button class="danger-link" data-action="item-remove" data-id="${esc(i.id)}" data-name="${esc(i.name)}">Remove from kitchen</button>
        <p class="hint" style="margin:6px 0 0">It comes off every list. Add it again any time — it remembers everything.</p>
      </div>
    </div>`;
}
const closeSheet = () => ($("#sheet-root").innerHTML = "");

// --- Line Check overlay -----------------------------------------------------------------------------------
const LC = { zone: null, idx: 0, items: [], touched: 0 };

function startLineCheck(zone) {
  LC.zone = zone;
  LC.idx = 0;
  LC.touched = 0;
  LC.items = S.items.filter((i) => i.zone === zone);
  renderLineCheck();
}

function renderLineCheck() {
  const total = LC.items.length;
  if (LC.idx >= total) {
    $("#overlay-root").innerHTML = `
      <div class="overlay"><div class="sheet-card lc-done" style="text-align:center;--zc:var(--z-${esc(LC.zone)})">
        <svg class="draw-check" viewBox="0 0 52 52" aria-hidden="true">
          <circle cx="26" cy="26" r="24" fill="none"/>
          <path d="M14 27l8 8 16-17" fill="none"/>
        </svg>
        <h3 style="font-family:var(--serif);margin:10px 0 2px">${esc(zoneLabel(LC.zone))} — done</h3>
        <p class="hint">${total} items reviewed · ${LC.touched} updated.</p>
        <button class="primary" data-action="lc-close" style="width:100%">Nice</button>
      </div></div>`;
    return;
  }
  const i = LC.items[LC.idx];
  $("#overlay-root").innerHTML = `
    <div class="overlay"><div class="sheet-card" data-item="${esc(i.id)}">
      <div class="hint">${esc(zoneLabel(LC.zone))} · ${LC.idx + 1} of ${total}</div>
      <div class="lc-progress"><span style="width:${(LC.idx / total) * 100}%"></span></div>
      <div class="lc-item-name">${esc(i.name)}</div>
      <div class="hint">recorded: ${esc(stateLabel(i.inventory))}${i.is_discrete ? "" : " · tap the real level"}</div>
      <div class="controls">${stateControls(i, i.inventory)}</div>
      <div class="lc-actions">
        <button class="ghost" data-action="lc-skip">Looks right</button>
        <button class="primary" data-action="lc-next">Next ›</button>
      </div>
    </div></div>`;
}
const closeLineCheck = () => ($("#overlay-root").innerHTML = "");

// --- Review a kitchen pass (narration P1) --------------------------------------------------------------------
const REVIEW = { captureId: null, transcript: null, drafts: [] };

// Concrete state a spoken intent implies for a given item (mirrors server proposedFor).
function proposedForClient(intent, item) {
  if (item.is_discrete) {
    const count = intent === "out" ? 0 : intent === "low" ? item.reorder_point : item.par;
    return { kind: "count", count };
  }
  return { kind: "bucket", bucket: intent === "out" ? "out" : intent === "low" ? "low" : "full" };
}

async function openCaptureReview(captureId) {
  try {
    const d = await api(`/api/captures/${captureId}/draft`);
    REVIEW.captureId = captureId;
    REVIEW.transcript = d.transcript;
    REVIEW.drafts = d.drafts;
    renderCaptureReview();
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

function renderCaptureReview() {
  const root = $("#overlay-root");
  // Not processed yet -> paste-a-transcript path (Whisper comes in P2).
  if (!REVIEW.transcript && !REVIEW.drafts.length) {
    root.innerHTML = `
    <div class="overlay"><div class="sheet-card">
      <h3 style="font-family:var(--display)">Review this kitchen pass</h3>
      <p class="hint">Automatic reading from the video is coming. For now, type what you said as you walked — I'll turn it into changes.</p>
      <textarea id="rv-transcript" rows="5" placeholder="milk's getting low, we're out of eggs, restocked the rice, coffee's low"></textarea>
      <div class="lc-actions">
        <button class="ghost" data-action="review-close">Cancel</button>
        <button class="primary" data-action="review-process" style="flex:1">Read what I said</button>
      </div>
    </div></div>`;
    return;
  }
  // Only pending drafts are reviewable — already-applied ones from a re-process would
  // otherwise show as fresh checked rows and inflate the "Applied N" count.
  const pending = REVIEW.drafts.filter((d) => d.status !== "applied");
  const rows = pending.length
    ? pending.map(draftRow).join("")
    : `<p class="empty">Nothing new to review from that pass.</p>`;
  root.innerHTML = `
  <div class="overlay"><div class="sheet-card">
    <h3 style="font-family:var(--display)">Review this kitchen pass</h3>
    ${REVIEW.transcript ? `<details class="rv-transcript"><summary>What I heard</summary><p>${esc(REVIEW.transcript)}</p></details>` : ""}
    <p class="hint">Keep, fix, or drop each change. Nothing is applied until you tap Apply.</p>
    <div id="rv-drafts">${rows}</div>
    <div class="lc-actions">
      <button class="ghost" data-action="review-close">Close</button>
      <button class="primary" data-action="review-apply" style="flex:1">Apply kept changes</button>
    </div>
  </div></div>`;
}

function draftRow(d) {
  const item = d.food_item_id ? itemById(d.food_item_id) : null;
  const stateControl = item
    ? item.is_discrete
      ? `<input class="rv-count" type="number" min="0" value="${d.proposed.kind === "count" ? d.proposed.count : item.reorder_point}" />`
      : `<select class="rv-bucket">${["full", "half", "low", "out"]
          .map((b) => `<option ${d.proposed.kind === "bucket" && d.proposed.bucket === b ? "selected" : ""}>${b}</option>`)
          .join("")}</select>`
    : `<span class="rv-intent">heard: ${esc(d.proposed.kind === "intent" ? d.proposed.intent : "")}</span>`;
  return `
  <div class="rvrow" data-draft="${esc(d.id)}" data-discrete="${item ? item.is_discrete : ""}">
    <label class="rv-keep"><input type="checkbox" class="rv-check" ${item ? "checked" : ""} /></label>
    <div class="rv-body">
      <div class="rv-utt">"${esc(d.utterance)}"</div>
      <div class="rv-controls">
        ${item ? `<span class="rv-name">${esc(item.name)}</span>` : `<select class="rv-pick">${itemOptions(null, "(choose item)")}</select>`}
        ${stateControl}
      </div>
    </div>
  </div>`;
}

// --- Onboarding ---------------------------------------------------------------------------------------------
function maybeIntro() {
  if (localStorage.getItem("yc_intro2_dismissed")) return;
  $("#overlay-root").innerHTML = `
    <div class="overlay"><div class="sheet-card">
      <h3 style="font-family:var(--serif);margin:0 0 4px">Welcome to Yes Chef!</h3>
      <ol class="intro-steps">
        <li><strong>List</strong> is your week — what's running low, grouped by store. Tap the circle as you shop; ✓/✗ teaches it.</li>
        <li><strong>Kitchen</strong> mirrors your real one — go to a place, tap what changed. Try a Line Check while putting groceries away.</li>
        <li><strong>Add</strong> — type a quick update or paste a receipt; anything unrecognized waits there for one tap.</li>
        <li><strong>Report card</strong> grades the list — your taps are the teacher.</li>
      </ol>
      <p class="hint">About 5 minutes a week. Your items live in <code>data/staples.json</code> to start — edit anything from an item's detail screen.</p>
      <button class="primary" data-action="intro-done" style="width:100%">Let's cook</button>
    </div></div>`;
}

// --- Mutations: optimistic ---------------------------------------------------------------------------------
// The UI changes the moment you tap — the POST happens in the background, a failure
// rolls the change back with an error toast, and shortfall/metrics re-sync quietly.
let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      [S.shortfall, S.metrics] = await Promise.all([api("/api/shortfall"), api("/api/metrics")]);
      if (S.tab === "list" || S.tab === "stats") render();
    } catch {} // next interaction retries; nothing user-facing to do
  }, 900);
}

function repaintSurfaces(id) {
  if ($(".sheet")?.dataset.item === id) openSheet(id);
  if (LC.zone && $("#overlay-root .overlay")) renderLineCheck();
  render();
}

function mutateState(id, body) {
  const item = itemById(id);
  if (!item) return;
  // Per-item mutation token: a failed POST only rolls back if NO later mutation has
  // touched this item — otherwise the rollback would clobber a newer successful state.
  item._mut = (item._mut ?? 0) + 1;
  const myMut = item._mut;
  const prev = item.inventory ? JSON.parse(JSON.stringify(item.inventory)) : null;
  item.inventory =
    body.count !== undefined ? { kind: "count", count: body.count } : { kind: "bucket", bucket: body.bucket };
  vib();
  repaintSurfaces(id); // instant — no network on the critical path

  api(`/api/items/${id}/state`, { method: "POST", body: JSON.stringify(body) })
    .then(scheduleSync)
    .catch((e) => {
      if (item._mut === myMut) { // stale failure? a newer mutation owns the state now
        item.inventory = prev;
        repaintSurfaces(id);
      }
      toast(e.message || "That didn't save — try again.", { kind: "error" });
    });
}

// --- Event delegation ------------------------------------------------------------------------------------------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action], .drawer-item");
  if (!t) return;

  if (t.classList.contains("drawer-item")) {
    S.tab = t.dataset.tab;
    S.zone = null;
    S.addingRecipe = false;
    S.addingItem = false;
    closeDrawer();
    render({ navigate: true });
    return;
  }

  const a = t.dataset.action;
  const id = t.dataset.id;

  const actions = {
    goto() {
      S.tab = t.dataset.tab;
      S.zone = null;
      render({ navigate: true });
    },
    groupby() {
      S.groupBy = t.dataset.v;
      localStorage.setItem("yc_groupby", S.groupBy);
      render();
    },
    checkoff() {
      const d = doneSet();
      d.has(id) ? d.delete(id) : d.add(id);
      saveDone(d);
      vib();
      render();
    },
    verdict() {
      const row = t.closest(".lrow");
      row.classList.add("logged");
      const label = t.dataset.v === "confirmed_needed" ? "needed" : "not really";
      deferredPost(
        `${t.dataset.name}: marked "${label}"`,
        "/api/shortfall/feedback",
        { food_item_id: id, predicted: t.dataset.pred === "true", verdict: t.dataset.v },
        () => api("/api/metrics").then((m) => { S.metrics = m; })
      );
    },
    detail: () => openSheet(id),
    "sheet-close": closeSheet,
    place() {
      S.zone = t.dataset.zone || null;
      S.addingRecipe = false;
      S.addingItem = false;
      render({ navigate: true });
    },
    step() {
      const i = itemById(id);
      const cur = i?.inventory?.kind === "count" ? i.inventory.count : 0;
      mutateState(id, { count: Math.max(0, cur + Number(t.dataset.d)) });
    },
    setcount: () => mutateState(id, { count: Number(t.dataset.v) }),
    setbucket() {
      LC.zone && LC.items[LC.idx]?.id === id && LC.touched++;
      mutateState(id, { bucket: t.dataset.v });
    },
    linecheck: () => startLineCheck(t.dataset.zone),
    "lc-skip"() { LC.idx++; renderLineCheck(); },
    "lc-next"() { LC.idx++; renderLineCheck(); },
    "lc-close": closeLineCheck,
    "intro-done"() {
      localStorage.setItem("yc_intro2_dismissed", "1");
      closeLineCheck();
    },
    quickadd() {
      withBusy(t, async () => {
        const text = $("#qa-text").value.trim();
        if (!text) return;
        const r = await api("/api/quickadd", {
          method: "POST",
          body: JSON.stringify({ text, level: $("#qa-level").value }),
        });
        toast(r.message);
        $("#qa-text").value = "";
        await loadAll();
        render();
      });
    },
    receipt() {
      withBusy(t, async () => {
        const lines = parseReceipt($("#rc-text").value);
        if (!lines.length) return;
        const r = await api("/api/receipt", { method: "POST", body: JSON.stringify({ lines }) });
        const parts = [];
        if (r.applied.length) parts.push(`${r.applied.length} added`);
        if (r.refunded.length) parts.push(`${r.refunded.length} refunded (skipped)`);
        if (r.unmatched.length) parts.push(`${r.unmatched.length} need a look`);
        toast(parts.join(" · ") || "Nothing to add");
        await loadAll();
        render();
      });
    },
    resolve() {
      withBusy(t, async () => {
        const food_item_id = $(`#pick-${CSS.escape(id)}`).value;
        if (!food_item_id) { toast("Pick which item this is first.", { kind: "error" }); return; }
        await api(`/api/unmatched/${id}/resolve`, { method: "POST", body: JSON.stringify({ food_item_id }) });
        toast("Got it — I'll remember that name.");
        await loadAll();
        render();
      });
    },
    ignore() {
      withBusy(t, async () => {
        await api(`/api/unmatched/${id}/ignore`, { method: "POST" });
        await loadAll();
        render();
      });
    },
    missed() {
      const food_item_id = $("#missed-item").value;
      if (!food_item_id) { toast("Pick which item ran out first.", { kind: "error" }); return; }
      const name = itemById(food_item_id)?.name ?? "item";
      deferredPost(
        `Logged: ${name} ran out without warning`,
        "/api/shortfall/feedback",
        { food_item_id, predicted: false, verdict: "missed_runout" },
        () => refresh()
      );
    },
    cook() {
      // A brief success beat on the button itself, then the undo-able deferred post.
      const original = t.innerHTML;
      t.classList.add("cooked");
      t.innerHTML = `${icon("check", 16)} Chef!`;
      setTimeout(() => { t.classList.remove("cooked"); t.innerHTML = original; }, 1400);
      vib();
      deferredPost(
        `Cooked "${t.dataset.name}" — ingredients depleting`,
        `/api/recipes/${id}/made`,
        {},
        () => refresh()
      );
    },
    "recipe-del"() {
      withBusy(t, async () => {
        await api(`/api/recipes/${id}`, { method: "DELETE" });
        toast(`Removed "${t.dataset.name}"`);
        await loadAll();
        render();
      });
    },
    "capture-del"() {
      withBusy(t, async () => {
        await api(`/api/captures/${id}`, { method: "DELETE" });
        toast("Video removed");
        await loadAll();
        render();
      });
    },
    "cap-review": () => openCaptureReview(id),
    "review-close": () => { $("#overlay-root").innerHTML = ""; },
    "review-process"() {
      withBusy(t, async () => {
        const transcript = $("#rv-transcript").value.trim();
        if (!transcript) return;
        const r = await api(`/api/captures/${REVIEW.captureId}/process`, { method: "POST", body: JSON.stringify({ transcript }) });
        REVIEW.transcript = transcript;
        REVIEW.drafts = r.drafts.map((d) => ({ ...d, proposed: typeof d.proposed === "string" ? JSON.parse(d.proposed) : d.proposed }));
        renderCaptureReview();
      });
    },
    "review-apply"() {
      withBusy(t, async () => {
        const changes = [];
        for (const row of $$("#rv-drafts .rvrow")) {
          if (!$(".rv-check", row).checked) continue;
          const draft_id = row.dataset.draft;
          const draft = REVIEW.drafts.find((d) => d.id === draft_id);
          // Resolve the final item: matched, or the (choose item) pick.
          const picked = $(".rv-pick", row);
          const food_item_id = draft.food_item_id || (picked ? picked.value : "");
          if (!food_item_id) continue; // kept but no item chosen -> skip
          const item = itemById(food_item_id);
          let proposed;
          if (item.is_discrete) {
            const countEl = $(".rv-count", row);
            // A blank/invalid count falls back to the proposed count — never silently 0
            // ("clear the field" must not read as "we're out").
            const fallback = draft.proposed.kind === "count" ? draft.proposed.count : proposedForClient(draft.proposed.intent, item).count;
            const typed = countEl && countEl.value.trim() !== "" ? Number(countEl.value) : NaN;
            proposed = { kind: "count", count: Number.isFinite(typed) && typed >= 0 ? Math.round(typed) : fallback };
          } else {
            const bucketEl = $(".rv-bucket", row);
            proposed = { kind: "bucket", bucket: bucketEl ? bucketEl.value : proposedForClient(draft.proposed.intent, item).bucket };
          }
          changes.push({ draft_id, food_item_id, proposed });
        }
        if (!changes.length) { toast("Nothing to apply — keep at least one change and pick its item.", { kind: "error" }); return; }
        const r = await api(`/api/captures/${REVIEW.captureId}/apply`, { method: "POST", body: JSON.stringify({ changes }) });
        toast(`Applied ${r.applied} change${r.applied === 1 ? "" : "s"} from your kitchen pass`);
        vib();
        $("#overlay-root").innerHTML = "";
        await loadAll();
        render();
      });
    },
    "recipe-new"() {
      S.addingRecipe = true;
      render();
    },
    "rc-cancel"() {
      S.addingRecipe = false;
      render();
    },
    "rc-add-line": () => $("#rc-ings").appendChild(ING_LINE()),
    "rc-import"() {
      withBusy(t, async () => {
        const url = $("#rc-url").value.trim();
        if (!url) return;
        const r = await api("/api/recipes/import", { method: "POST", body: JSON.stringify({ url }) });
        $("#rc-name").value = r.name;
        const box = $("#rc-ings");
        box.innerHTML = "";
        let matched = 0;
        for (const ing of r.ingredients) {
          const item = matchItemToRaw(ing.raw);
          if (item) matched++;
          // Server parses qty (fractions included); recipe qty means UNITS of the
          // tracked item, so round up and floor at 1 — bulk items ignore qty anyway.
          const qty = Math.max(1, Math.round(ing.qty ?? 1));
          box.appendChild(ING_LINE(item?.id ?? null, qty, ing.raw));
        }
        toast(`Read "${r.name}" — matched ${matched} of ${r.ingredients.length} ingredients to your items`);
      });
    },
    "rc-rm"() {
      const wraps = $$("#rc-ings .ing-wrap");
      if (wraps.length > 1) t.closest(".ing-wrap").remove();
    },
    "rc-save"() {
      withBusy(t, async () => {
        const name = $("#rc-name").value.trim();
        const ingredients = $$("#rc-ings .ing-line").map((l) => ({
          food_item_id: $(".rc-item", l).value,
          qty: Number($(".rc-qty", l).value) || 1,
          optional: $(".rc-opt", l).checked,
        }));
        if (ingredients.some((i) => !i.food_item_id)) {
          toast("Some imported lines still say (choose item) — pick or remove them.", { kind: "error" });
          return;
        }
        const r = await api("/api/recipes", { method: "POST", body: JSON.stringify({ name, ingredients }) });
        toast(`Saved "${r.name}"`);
        S.addingRecipe = false;
        await loadAll();
        render();
      });
    },
    "item-remove"() {
      const name = t.dataset.name;
      withBusy(t, async () => {
        await api(`/api/items/${id}`, { method: "DELETE" });
        closeSheet();
        await loadAll();
        render();
        // Undo = re-add by name: the server recognizes a removed item and brings it
        // back with all its history.
        toast(`Removed ${name} from your kitchen`, {
          undo: async () => {
            try {
              await api("/api/items", { method: "POST", body: JSON.stringify({ name }) });
              toast(`${name} is back — it remembered everything`);
              await loadAll();
              render();
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        });
      });
    },
    "item-new"() {
      S.addingItem = true;
      render();
    },
    "item-cancel"() {
      S.addingItem = false;
      render();
    },
    "item-create"() {
      withBusy(t, async () => {
        const name = $("#ni-name").value.trim();
        if (!name) return;
        const discrete = $("#ni-kind").value === "discrete";
        const body = discrete
          ? {
              name,
              zone: t.dataset.zone,
              is_discrete: true,
              par: Number($("#ni-par").value) || 1,
              reorder_point: Number($("#ni-rp").value) || 0,
              init: Number($("#ni-count").value) || 0,
            }
          : { name, zone: t.dataset.zone, is_discrete: false, par: 1, reorder_point: 0, init: $("#ni-level").value };
        const r = await api("/api/items", { method: "POST", body: JSON.stringify(body) });
        toast(r.restored ? `${r.name} is back — it remembered everything` : `${r.name} added`);
        S.addingItem = false;
        await loadAll();
        render();
      });
    },
    "store-create"() {
      withBusy(t, async () => {
        const name = $("#sh-newname").value.trim();
        if (!name) return;
        const s = await api("/api/stores", { method: "POST", body: JSON.stringify({ name }) });
        S.stores = await api("/api/stores");
        toast(`Added ${s.name}`);
        const itemId = $(".sheet").dataset.item;
        await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ store_id: s.id }) });
        await loadAll();
        openSheet(itemId);
      });
    },
    "sheet-save"() {
      withBusy(t, async () => {
        const itemId = $(".sheet").dataset.item;
        const storeSel = $("#sh-store").value;
        const patch = {
          brand: $("#sh-brand").value.trim() || null,
          package_size: $("#sh-size").value.trim() || null,
          order_url: $("#sh-url").value.trim() || null,
          zone: $("#sh-zone").value,
          par: Number($("#sh-par").value),
          reorder_point: Number($("#sh-rp").value),
        };
        if (storeSel !== "__new") patch.store_id = storeSel || null;
        await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) });
        toast("Details saved");
        await loadAll();
        closeSheet();
        render();
      });
    },
  };
  actions[a]?.();
});

// Store picker: reveal the inline "new store" row when "+ Add new store…" is chosen.
document.addEventListener("change", (e) => {
  if (e.target.id === "sh-store") {
    $("#sh-newstore").hidden = e.target.value !== "__new";
  }
  // New-item form: counted items need count/par/reorder; eyeballed ones need a level.
  if (e.target.id === "ni-kind") {
    const discrete = e.target.value === "discrete";
    $("#ni-count-fields").hidden = !discrete;
    $("#ni-bulk-fields").hidden = discrete;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "rc-text") renderReceiptPreview();
});

// Video capture upload: FormData (not the JSON api() helper), with progress. Big files,
// so XHR gives us an upload progress bar the fetch API can't.
document.addEventListener("change", (e) => {
  if (e.target.id !== "cap-file") return;
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $("#cap-status");
  const fd = new FormData();
  fd.append("video", file, file.name);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/capture");
  xhr.upload.addEventListener("progress", (ev) => {
    if (ev.lengthComputable) status.textContent = `Uploading… ${Math.round((ev.loaded / ev.total) * 100)}%`;
  });
  xhr.addEventListener("load", async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      status.textContent = "";
      toast("Kitchen pass saved");
      vib();
      await loadAll();
      render();
    } else {
      let msg = "Upload failed";
      try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch {}
      status.textContent = "";
      toast(msg, { kind: "error" });
    }
  });
  xhr.addEventListener("error", () => { status.textContent = ""; toast("Upload failed — check the connection.", { kind: "error" }); });
  status.textContent = "Uploading… 0%";
  xhr.send(fd);
});

// --- Drawer (top-left hamburger navigation) --------------------------------------------------------------------
// The .open class sets the drawer's TRUE static position (no CSS transitions — a
// frozen transition can wedge the element's style above all overrides). The slide-in
// is a self-cancelling Web Animation: if it dies, the static style is still correct.
function openDrawer() {
  const d = $("#drawer");
  d.classList.add("open");
  $("#drawer-backdrop").hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
  if (!reducedMotion) {
    try {
      const a = d.animate(
        [{ transform: "translateX(-24px)", opacity: 0.5 }, { transform: "none", opacity: 1 }],
        { duration: 200, easing: "cubic-bezier(0.34, 1.4, 0.5, 1)" }
      );
      a.finished.catch(() => {}).finally(() => a.cancel());
      setTimeout(() => a.cancel(), 400); // occluded windows freeze animation frames — force convergence to the static style
    } catch {}
  }
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-backdrop").hidden = true;
  $("#menu-btn").setAttribute("aria-expanded", "false");
}
$("#menu-btn").addEventListener("click", () =>
  $("#drawer").classList.contains("open") ? closeDrawer() : openDrawer()
);
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").classList.contains("open")) closeDrawer();
});

// --- Boot ------------------------------------------------------------------------------------------------------
renderSkeleton();
refresh().then(maybeIntro);

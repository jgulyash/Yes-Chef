// Recipe URL import (UX-REDESIGN §5.3 "paste a URL"): fetch a page, extract the
// schema.org/Recipe JSON-LD most sites embed, return name + raw ingredient strings.
// The CLIENT maps raw strings to food items (best-guess picker prefill) — the server
// never invents items (no-silent-create, as everywhere else).
//
// The fetcher is injectable so tests run on fixtures with zero live network.

export interface ImportedIngredient {
  raw: string; // e.g. "1 1/2 cups all-purpose flour"
  qty: number | null; // parsed leading quantity (fractions + unicode handled); null = none found
}

export interface ImportedRecipe {
  name: string;
  source_url: string;
  ingredients: ImportedIngredient[];
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal; redirect?: "follow" }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

const MAX_BYTES = 2_000_000; // 2MB cap — recipe pages, not archives
const TIMEOUT_MS = 8000;

export async function fetchRecipeFromUrl(
  rawUrl: string,
  fetcher: Fetcher = fetch as unknown as Fetcher
): Promise<{ ok: true; recipe: ImportedRecipe } | { ok: false; status: number; error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, error: "that doesn't look like a link" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: 400, error: "only http(s) links are supported" };
  }
  // SSRF guard, first layer: refuse obvious local/private targets before any request.
  // (DNS-rebinding + per-redirect-hop validation is Phase E hardening, tracked.)
  if (isPrivateHost(url.hostname)) {
    return { ok: false, status: 400, error: "links to local network addresses aren't supported" };
  }

  let html: string;
  try {
    const res = await fetcher(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) return { ok: false, status: 422, error: `the site answered ${res.status}` };
    html = await readCapped(res, MAX_BYTES);
  } catch {
    return { ok: false, status: 422, error: "couldn't reach that site" };
  }

  const recipe = extractRecipe(html, url.href);
  if (!recipe) return { ok: false, status: 422, error: "no recipe found on that page" };
  return { ok: true, recipe };
}

// The cap must stop READING at MAX_BYTES — a slice after text() would buffer an
// arbitrarily large body first and protect nothing. Stub fetchers without .body
// fall back to text() (tests, tiny fixtures).
async function readCapped(res: { text: () => Promise<string>; body?: ReadableStream<Uint8Array> | null }, cap: number): Promise<string> {
  if (!res.body?.getReader) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(concatBytes(chunks)).slice(0, cap);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// Literal private/loopback/link-local hosts (v4, v6, localhost, mDNS .local).
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// Leading-quantity parse: "3", "1/2", "1 1/2", unicode fractions. null when absent.
const UNICODE_FRACTIONS: Record<string, number> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅛": 0.125 };
export function parseQty(raw: string): number | null {
  const t = raw.trim();
  const uni = t.match(/^(\d+)?\s*([½⅓⅔¼¾⅛])/);
  if (uni) return (uni[1] ? Number(uni[1]) : 0) + UNICODE_FRACTIONS[uni[2]];
  const frac = t.match(/^(\d+)\s+(\d+)\/(\d+)/) || null;
  if (frac) return Number(frac[1]) + Number(frac[2]) / Number(frac[3]);
  const bare = t.match(/^(\d+)\/(\d+)/);
  if (bare) return Number(bare[1]) / Number(bare[2]);
  const int = t.match(/^(\d+(?:\.\d+)?)/);
  return int ? Number(int[1]) : null;
}

// Exported for direct unit testing against HTML fixtures.
export function extractRecipe(html: string, source_url: string): ImportedRecipe | null {
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, body] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue; // malformed block — try the next one
    }
    const node = findRecipeNode(parsed);
    if (!node) continue;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    const ingredients = Array.isArray(node.recipeIngredient)
      ? node.recipeIngredient
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((raw) => ({ raw, qty: parseQty(raw) }))
      : [];
    if (name && ingredients.length) return { name, source_url, ingredients };
  }
  return null;
}

interface RecipeNode {
  name?: unknown;
  recipeIngredient?: unknown[];
}

// JSON-LD shapes in the wild: a bare Recipe object, an array of nodes, @graph wrappers,
// and @type as string OR array ("Recipe" possibly among others).
function findRecipeNode(node: unknown): RecipeNode | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findRecipeNode(n);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isRecipe =
    type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
  if (isRecipe) return obj as RecipeNode;
  if (obj["@graph"]) return findRecipeNode(obj["@graph"]);
  return null;
}

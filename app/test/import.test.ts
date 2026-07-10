import { describe, it, expect } from "vitest";
import { extractRecipe, fetchRecipeFromUrl, parseQty, isPrivateHost, type Fetcher } from "../src/importRecipe.js";

const page = (ld: object | string) =>
  `<html><head><script type="application/ld+json">${typeof ld === "string" ? ld : JSON.stringify(ld)}</script></head><body>hi</body></html>`;

const stubFetcher = (html: string, ok = true, status = 200): Fetcher =>
  async () => ({ ok, status, text: async () => html });

describe("recipe URL import", () => {
  it("extracts name + ingredients from a bare Recipe node", () => {
    const html = page({ "@type": "Recipe", name: "Veggie Stew", recipeIngredient: ["2 lb potatoes", "6 carrots"] });
    const r = extractRecipe(html, "https://x.test/stew");
    expect(r?.name).toBe("Veggie Stew");
    expect(r?.ingredients.map((i) => i.raw)).toEqual(["2 lb potatoes", "6 carrots"]);
    expect(r?.ingredients[0].qty).toBe(2);
  });

  it("finds Recipe inside @graph and array @type", () => {
    const html = page({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "ignore me" },
        { "@type": ["Article", "Recipe"], name: "Taco Night", recipeIngredient: ["12 tortillas", "1 lb ground beef"] },
      ],
    });
    expect(extractRecipe(html, "u")?.name).toBe("Taco Night");
  });

  it("skips malformed JSON-LD blocks and uses the next valid one", () => {
    const html =
      `<script type="application/ld+json">{not json</script>` +
      page({ "@type": "Recipe", name: "Soup", recipeIngredient: ["1 onion"] });
    expect(extractRecipe(html, "u")?.name).toBe("Soup");
  });

  it("returns null when no Recipe exists", () => {
    expect(extractRecipe(page({ "@type": "Article", name: "News" }), "u")).toBeNull();
  });

  it("rejects non-http(s) schemes without calling the fetcher", async () => {
    let called = false;
    const f: Fetcher = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
    const r = await fetchRecipeFromUrl("file:///etc/passwd", f);
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(400);
    expect(called).toBe(false);
  });

  it("maps site errors and recipe-less pages to 422", async () => {
    const bad = await fetchRecipeFromUrl("https://x.test/a", stubFetcher("", false, 500));
    expect((bad as { status: number }).status).toBe(422);
    const empty = await fetchRecipeFromUrl("https://x.test/b", stubFetcher("<html></html>"));
    expect((empty as { status: number }).status).toBe(422);
  });

  it("parses fractional and unicode quantities", () => {
    expect(parseQty("1 1/2 cups flour")).toBeCloseTo(1.5);
    expect(parseQty("1/2 cup sugar")).toBeCloseTo(0.5);
    expect(parseQty("\u00bd cup butter")).toBeCloseTo(0.5);
    expect(parseQty("2\u00bd cups milk")).toBeCloseTo(2.5);
    expect(parseQty("a pinch of salt")).toBeNull();
  });

  it("refuses private/local hosts before fetching", async () => {
    for (const u of ["http://192.168.1.1/admin", "http://10.0.0.5/", "http://127.0.0.1:5000/", "http://nas.local/", "http://[::1]/"]) {
      let called = false;
      const f: Fetcher = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
      const r = await fetchRecipeFromUrl(u, f);
      expect(r.ok).toBe(false);
      expect(called).toBe(false);
    }
    expect(isPrivateHost("172.20.1.9")).toBe(true);
    expect(isPrivateHost("172.32.1.9")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  it("succeeds end-to-end with a stub fetcher", async () => {
    const html = page({ "@type": "Recipe", name: "Beef Chili", recipeIngredient: ["2 lb beef", "1 can beans"] });
    const r = await fetchRecipeFromUrl("https://x.test/chili", stubFetcher(html));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.ingredients.length).toBe(2);
  });
});

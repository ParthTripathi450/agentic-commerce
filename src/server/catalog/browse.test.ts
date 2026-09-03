import { beforeAll, describe, expect, it } from "vitest";
import { browseCatalog, browseMerchants } from "./browse";
import { PAGE_SIZE } from "@/lib/browse";

/**
 * Browse's contract is arithmetic, not relevance.
 *
 * The agent's search is judged on whether it found the right thing; browse is
 * judged on whether its own numbers are true. A facet count that does not match
 * what ticking it returns, or a page 2 that repeats page 1, is a bug the
 * shopper can see immediately — so those are what these assert, rather than
 * naming a product that other suites can legitimately sell out from under them.
 */
describe("browseCatalog", () => {
  let baseline: Awaited<ReturnType<typeof browseCatalog>>;

  beforeAll(async () => {
    baseline = await browseCatalog({});
  });

  it("returns a full page and an honest page count", () => {
    expect(baseline.total).toBeGreaterThan(0);
    expect(baseline.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(baseline.pageCount).toBe(Math.max(1, Math.ceil(baseline.total / PAGE_SIZE)));
  });

  it("counts every result exactly once across the category facet", () => {
    // Each product has exactly one category, so the facet must partition the
    // result set. A mismatch means the facet query and the result query
    // disagree about what matches — which is how a facet starts lying.
    const summed = baseline.categories.reduce((sum, c) => sum + c.count, 0);
    expect(summed).toBe(baseline.total);
  });

  it("delivers exactly the count a category facet promised", async () => {
    const facet = baseline.categories[0];
    const filtered = await browseCatalog({ categories: [facet.value] });

    expect(filtered.total).toBe(facet.count);
    expect(filtered.items.every((i) => i.category === facet.value)).toBe(true);
  });

  it("delivers exactly the count a price band promised", async () => {
    const band = baseline.priceBands[0];
    if (!band) return; // a single-price catalogue has no bands to check

    const filtered = await browseCatalog({
      minPriceMinor: band.minMinor,
      maxPriceMinor: band.maxMinor ?? undefined,
    });

    expect(filtered.total).toBe(band.count);
  });

  it("partitions the whole result set across price bands", () => {
    if (baseline.priceBands.length === 0) return;
    const summed = baseline.priceBands.reduce((sum, b) => sum + b.count, 0);
    expect(summed).toBe(baseline.total);
  });

  it("paginates without repeating or dropping a product", async () => {
    if (baseline.pageCount < 2) return;
    const first = await browseCatalog({ sort: "price_asc" });
    const second = await browseCatalog({ sort: "price_asc", page: 2 });

    const overlap = second.items.filter((i) => first.items.some((f) => f.productId === i.productId));
    expect(overlap).toEqual([]);

    // Stable ordering: page 2 must continue where page 1 stopped, or the same
    // product could appear on both pages depending on when each was fetched.
    const lastOfFirst = first.items[first.items.length - 1].priceMinor;
    expect(second.items[0].priceMinor).toBeGreaterThanOrEqual(lastOfFirst);
  });

  it("filters on the price actually shown, not on any variant's price", async () => {
    // "Under ₹X" that surfaces a product whose cheapest buyable variant costs
    // more is the classic version of this bug: technically it has a cheap
    // variant, but not one anybody can put in a basket.
    const cap = baseline.priceBands[0]?.maxMinor ?? 500000;
    const filtered = await browseCatalog({ maxPriceMinor: cap });

    expect(filtered.items.every((i) => i.priceMinor <= cap)).toBe(true);
  });

  it("honours a minimum rating", async () => {
    const filtered = await browseCatalog({ minRatingBp: 4000 });
    expect(filtered.items.every((i) => (i.ratingBp ?? 0) >= 4000)).toBe(true);
  });

  it("shows only in-stock products by default and more when asked", async () => {
    expect(baseline.items.every((i) => i.inStock)).toBe(true);

    const everything = await browseCatalog({ inStockOnly: false });
    expect(everything.total).toBeGreaterThanOrEqual(baseline.total);
  });

  it("matches a partial word the way a search box is actually typed into", async () => {
    // Full-text stemming alone gets "shoes" to "shoe" but never "runn" to
    // "running", and a browse box is typed into a character at a time.
    const full = await browseCatalog({ q: "running" });
    const partial = await browseCatalog({ q: "runnin" });

    expect(full.total).toBeGreaterThan(0);
    expect(partial.total).toBeGreaterThan(0);
  });

  it("returns nothing for a query the catalogue cannot answer", async () => {
    // Browse never claims a match, so it needs no relevance gate — an empty
    // result is the honest answer, not a prompt to widen the search.
    const nonsense = await browseCatalog({ q: "zzzqqqxyzzy" });
    expect(nonsense.total).toBe(0);
    expect(nonsense.items).toEqual([]);
  });

  it("sorts by price in both directions", async () => {
    const cheap = await browseCatalog({ sort: "price_asc" });
    const dear = await browseCatalog({ sort: "price_desc" });

    expect(cheap.items[0].priceMinor).toBeLessThanOrEqual(dear.items[0].priceMinor);
    const prices = cheap.items.map((i) => i.priceMinor);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("lists only merchants that have something to browse", async () => {
    const merchants = await browseMerchants();
    expect(merchants.length).toBeGreaterThan(0);

    const scoped = await browseCatalog({ merchant: merchants[0].id });
    expect(scoped.total).toBeGreaterThan(0);
    expect(scoped.items.every((i) => i.merchantName === merchants[0].name)).toBe(true);
  });
});

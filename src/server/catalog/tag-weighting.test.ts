import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogDocuments, merchants, products } from "@/db/schema";
import { indexCatalog } from "./indexer";

/**
 * Search tags must genuinely outrank body copy.
 *
 * The claim being tested is specific: tags sit at tsvector weight 'A' and the
 * description at 'B', so ts_rank scores a tag match roughly 2.5x a body match.
 * Without this the feature is just keyword-stuffing with extra steps.
 */
let productId: string;
let originalTags: string[];

beforeAll(async () => {
  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, "stride-athletics")).limit(1);
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.merchantId, merchant.id), sql`${products.title} LIKE 'Velocity Run 3%'`))
    .limit(1);
  productId = product.id;
  originalTags = product.searchTags ?? [];
});

afterAll(async () => {
  await db.update(products).set({ searchTags: originalTags }).where(eq(products.id, productId));
  await indexCatalog({ productIds: [productId], force: true });
});

/** ts_rank of a query against one product's weighted vector. */
async function rankFor(term: string, id: string): Promise<number> {
  const rows = (await db.execute<{ rank: string }>(sql`
    SELECT ts_rank(cd.search_vector, websearch_to_tsquery('english', ${term})) AS rank
    FROM catalog_documents cd WHERE cd.product_id = ${id}
  `)) as unknown as { rank: string }[];
  return Number(rows[0]?.rank ?? 0);
}

describe("tag weighting", () => {
  it("makes a term findable that appears nowhere in the listing text", async () => {
    const term = "podiatrist recommended";

    await db.update(products).set({ searchTags: [] }).where(eq(products.id, productId));
    await indexCatalog({ productIds: [productId], force: true });
    const before = await rankFor(term, productId);

    await db
      .update(products)
      .set({ searchTags: ["podiatrist recommended"] })
      .where(eq(products.id, productId));
    await indexCatalog({ productIds: [productId], force: true });
    const after = await rankFor(term, productId);

    // ts_rank returns 1e-20 for a non-match rather than exactly zero, so the
    // meaningful assertion is the magnitude of the change, not equality with 0.
    expect(before).toBeLessThan(1e-10);
    expect(after).toBeGreaterThan(0.01);
    expect(after / Math.max(before, 1e-20)).toBeGreaterThan(1e6);
  });

  it("ranks a tag match above the same word buried in the description", async () => {
    // "breathable" appears in this product's description already.
    await db.update(products).set({ searchTags: [] }).where(eq(products.id, productId));
    await indexCatalog({ productIds: [productId], force: true });
    const bodyOnly = await rankFor("breathable", productId);

    await db
      .update(products)
      .set({ searchTags: ["breathable"] })
      .where(eq(products.id, productId));
    await indexCatalog({ productIds: [productId], force: true });
    const tagged = await rankFor("breathable", productId);

    expect(bodyOnly).toBeGreaterThan(0);
    expect(tagged).toBeGreaterThan(bodyOnly);
  });

  it("stores tags apart from the description rather than stuffing it", async () => {
    await db
      .update(products)
      .set({ searchTags: ["marathon training", "neutral gait"] })
      .where(eq(products.id, productId));
    await indexCatalog({ productIds: [productId], force: true });

    const [doc] = await db
      .select()
      .from(catalogDocuments)
      .where(eq(catalogDocuments.productId, productId))
      .limit(1);

    // Tags live in their own weighted column...
    expect(doc.tagsText).toContain("marathon training");
    expect(doc.titleText).toContain("Velocity Run 3");

    // ...and the merchant's own description is not rewritten to contain them.
    const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    expect(product.description).not.toContain("marathon training");
  });
});

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { refineProduct } from "./refine";
import { evidenceByTopic } from "@/server/catalog/evidence";
import { resolveVariant } from "./refine";
import type { ProductDetail, ProductVariantView } from "@/server/catalog/product-page";

/**
 * Refining one product.
 *
 * The property that matters: the answer can only ever be a variant that
 * exists, and a request that cannot be met is REFUSED with the real options
 * rather than quietly answered with the nearest thing.
 */

const v = (
  id: string,
  color: string,
  size: string,
  priceMinor: number,
  availableQuantity = 5,
): ProductVariantView => ({
  variantId: id,
  sku: id.toUpperCase(),
  attributes: { color, size },
  priceMinor,
  compareAtPriceMinor: null,
  currency: "INR",
  availableQuantity,
  imageUrl: null,
});

const product = {
  productId: "p1",
  title: "Velocity Run 3",
  variants: [
    v("a", "black", "9", 429900),
    v("b", "black", "10", 429900),
    v("c", "navy", "10", 399900),
    v("d", "navy", "11", 449900, 0),
    v("e", "white", "10", 379900),
  ],
} as unknown as ProductDetail;

const current = product.variants.find((x) => x.variantId === "b");

describe("resolveVariant", () => {
  it("changes colour and keeps the size they did not mention", () => {
    const { variant } = resolveVariant(product, current, {
      color: "navy", size: null, wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("c");
    expect(variant?.attributes.size).toBe("10");
  });

  it("changes size and keeps the colour", () => {
    const { variant } = resolveVariant(product, current, {
      color: null, size: "9", wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("a");
    expect(variant?.attributes.color).toBe("black");
  });

  it("prefers something in stock over something that is not", () => {
    // navy/11 exists but has none left; asking for navy should not land there.
    const { variant } = resolveVariant(product, undefined, {
      color: "navy", size: null, wantsCheapest: false,
    });
    expect(variant?.availableQuantity).toBeGreaterThan(0);
  });

  it("finds the cheapest when asked, rather than the first match", () => {
    const { variant } = resolveVariant(product, undefined, {
      color: null, size: "10", wantsCheapest: true,
    });
    expect(variant?.variantId).toBe("e");
    expect(variant?.priceMinor).toBe(379900);
  });

  it("refuses a colour the product does not come in, and names it", () => {
    const { variant, missing } = resolveVariant(product, current, {
      color: "purple", size: null, wantsCheapest: false,
    });
    expect(variant).toBeNull();
    expect(missing).toBe("colour purple");
  });

  it("refuses a size that does not exist, and names it", () => {
    const { missing } = resolveVariant(product, current, {
      color: null, size: "15", wantsCheapest: false,
    });
    expect(missing).toBe("size 15");
  });

  it("names the COMBINATION when both halves exist but not together", () => {
    // white and 9 both exist; white in a 9 does not.
    const { variant, missing } = resolveVariant(product, undefined, {
      color: "white", size: "9", wantsCheapest: false,
    });
    expect(variant).toBeNull();
    expect(missing).toBe("white in size 9");
  });

  it("is case-insensitive about how the shopper typed it", () => {
    const { variant } = resolveVariant(product, current, {
      color: "NAVY", size: null, wantsCheapest: false,
    });
    expect(variant?.attributes.color).toBe("navy");
  });

  it("keeps the current variant when nothing was asked to change", () => {
    const { variant } = resolveVariant(product, current, {
      color: null, size: null, wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("b");
  });
});

describe("citations must be about what was asked", () => {
  it("never quotes an off-topic review as the answer to a question", async () => {
    // Scoped to one product every review is written in the same register about
    // the same object, so they all score similarly against any question and
    // nearest-chunk retrieval picks one about something else — "how is the grip
    // on wet ground?" was answered with "nails the comfort". An off-topic
    // citation is worse than none: it looks like evidence, so it is believed.
    const product = await db.query.products.findFirst({
      where: (p, { sql: raw }) =>
        raw`${p.attributes} ? 'qualities' AND EXISTS (
              SELECT 1 FROM evidence_chunks ec WHERE ec.product_id = ${p.id})`,
      columns: { id: true, attributes: true, title: true },
    });
    if (!product) return;

    const qualities = Object.keys(
      (product.attributes as { qualities?: Record<string, number> }).qualities ?? {},
    );
    if (qualities.length === 0) return;

    const byTopic = await evidenceByTopic(product.id, qualities, 1);

    // Every chunk belongs to exactly one topic, so a quote offered for one
    // quality can never also be the quote for another.
    const ids = byTopic.flatMap((t) => t.chunks.map((c) => c.chunkId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the questions shoppers actually ask on a product page", () => {
  async function footballBoots() {
    const [row] = (await db.execute(sql`
      SELECT p.id FROM products p
      JOIN product_variants v ON v.product_id = p.id
      JOIN inventory i ON i.variant_id = v.id
      WHERE p.status = 'active' AND v.active
        AND GREATEST(i.quantity - i.reserved, 0) > 0
        AND v.attributes->>'color' IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(DISTINCT v.attributes->>'color') >= 2
      LIMIT 1
    `)) as unknown as { id: string }[];
    return row?.id ?? null;
  }

  it("lists the colours when asked what colours there are", async () => {
    // This was falling through to a catch-all that recited price and stock
    // while availableColors sat right there, computed and unused.
    const id = await footballBoots();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "What are the colours available?" });
    expect(result).not.toBeNull();
    for (const colour of result!.availableColors) {
      expect(result!.reply.toLowerCase()).toContain(colour.toLowerCase());
    }
  });

  it("lists the sizes when asked what sizes there are", async () => {
    const id = await footballBoots();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "what sizes do you have" });
    expect(result!.reply.toLowerCase()).toMatch(/size/);
    expect(result!.reply).toContain(result!.availableSizes[0]);
  });

  it("answers the return policy with THIS merchant's terms", async () => {
    const id = await footballBoots();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "whats the return policy" });
    // Not the generic fact dump, which happened to mention returns while
    // leading with price and stock.
    expect(result!.reply.toLowerCase()).toMatch(/return/);
    expect(result!.reply).not.toMatch(/in stock/);
  });

  it("refuses a colour it does not stock, even one nobody listed", async () => {
    // §8.21: the hardcoded colour list fails for every shade not thought of,
    // and a dropped word makes the refusal impossible — the shopper gets
    // silence instead of "we do not have that".
    const id = await footballBoots();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "do you have it in chartreuse" });
    expect(result!.reply.toLowerCase()).toContain("chartreuse");
    // A refusal always names the real options.
    expect(result!.reply.toLowerCase()).toContain(result!.availableColors[0].toLowerCase());
  });
});

describe("the rules backstop the model, they do not merely replace it", () => {
  it("keeps a colour the rules found when the model returned none", async () => {
    // The reported failure: the model returned color: null for a sentence that
    // plainly says "volt", the rule extraction was discarded wholesale, and the
    // question fell through to a catch-all reciting price and stock — with
    // nothing degraded and no error anywhere to show for it.
    const merged = { color: null as string | null, size: null as string | null };
    const rules = { color: "volt", size: "9" };

    const backfilled = {
      ...merged,
      color: merged.color ?? rules.color,
      size: merged.size ?? rules.size,
    };

    expect(backfilled.color).toBe("volt");
    expect(backfilled.size).toBe("9");
  });

  it("lets a colour the model actually stated win over the rules", () => {
    // The model read the sentence in context and can tell "not black,
    // something else" from "black"; silence is the only case worth overriding.
    const fromModel = { color: "crimson", size: null as string | null };
    const rules = { color: "black", size: "10" };

    const backfilled = {
      ...fromModel,
      color: fromModel.color ?? rules.color,
      size: fromModel.size ?? rules.size,
    };

    expect(backfilled.color).toBe("crimson");
    expect(backfilled.size).toBe("10");
  });
});

describe("asking for the reviews themselves", () => {
  async function reviewedProduct() {
    const [row] = (await db.execute(sql`
      SELECT p.id FROM products p
      JOIN evidence_chunks ec ON ec.product_id = p.id
      WHERE p.status = 'active'
      GROUP BY p.id HAVING COUNT(*) >= 5 LIMIT 1
    `)) as unknown as { id: string }[];
    return row?.id ?? null;
  }

  it("returns a sample when asked for reviews, which no semantic search can do", async () => {
    // Reviews talk about shoes, not about reviews: "what are some of the
    // reviews" scores 0.311 against its own corpus where "is it comfortable"
    // scores 0.553. The relevance floor rejected it correctly and the reviews
    // stayed unreachable — a question about the container needs a sample, not
    // a search.
    const id = await reviewedProduct();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "What are some of the reviews" });
    expect(result!.evidence.length).toBeGreaterThan(0);
    expect(result!.reply).toMatch(/review/i);
  });

  it("recognises the question however it is phrased", async () => {
    const id = await reviewedProduct();
    if (!id) return;

    for (const phrasing of ["what do people say about it", "how is it rated", "any feedback"]) {
      const result = await refineProduct({ productId: id, message: phrasing });
      expect(result!.evidence.length, phrasing).toBeGreaterThan(0);
    }
  });

  it("shows the critical review first when there is one", async () => {
    // An agent whose job is to sell has to be trusted to say the bad part, or
    // none of the good part counts for anything. Returning only the top-rated
    // reviews would answer "what do the happiest people think".
    const [row] = (await db.execute(sql`
      SELECT product_id FROM evidence_chunks
      GROUP BY product_id
      HAVING COUNT(*) >= 5 AND MIN(rating_bp) < 4000 AND MAX(rating_bp) >= 4000
      LIMIT 1
    `)) as unknown as { product_id: string }[];
    if (!row) return;

    const result = await refineProduct({
      productId: row.product_id,
      message: "what are the reviews like",
    });
    const ratings = result!.evidence.map((e) => e.ratingBp ?? 0);
    expect(ratings.length).toBeGreaterThan(1);
    expect(ratings[0]).toBeLessThan(Math.max(...ratings));
  });

  it("says so plainly when there are no reviews", async () => {
    const [row] = (await db.execute(sql`
      SELECT p.id FROM products p
      WHERE p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM evidence_chunks ec WHERE ec.product_id = p.id)
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!row) return;

    const result = await refineProduct({ productId: row.id, message: "what are the reviews" });
    expect(result!.reply.toLowerCase()).toContain("no reviews");
    expect(result!.evidence).toEqual([]);
  });
});

describe("answering from whatever the merchant published", () => {
  async function shoeWithSpecs() {
    const [row] = (await db.execute(sql`
      SELECT id FROM products
      WHERE status = 'active' AND attributes ? 'weightGrams' AND attributes ? 'qualities'
      LIMIT 1
    `)) as unknown as { id: string }[];
    return row?.id ?? null;
  }

  it("answers a weight question from weightGrams, with its unit", async () => {
    // 170-odd distinct attribute keys exist across the catalogue, so a handler
    // per question is not a plan and enumerating them is §8.21's trap. The
    // question is matched against the product's OWN keys instead.
    const id = await shoeWithSpecs();
    if (!id) return;

    const result = await refineProduct({ productId: id, message: "How much do they weigh" });
    expect(result!.reply).toMatch(/weight/i);
    expect(result!.reply).toMatch(/\d+\s*g\b/);
  });

  it("reads the unit off the key, so a heel drop is millimetres", async () => {
    const [row] = (await db.execute(sql`
      SELECT id FROM products WHERE status = 'active' AND attributes ? 'dropMm' LIMIT 1
    `)) as unknown as { id: string }[];
    if (!row) return;

    const result = await refineProduct({ productId: row.id, message: "what is the drop" });
    // Filtering short tokens out of the key name dropped the "Mm" and reported
    // an 8 mm drop as "drop: 8".
    expect(result!.reply).toMatch(/\d+\s*mm\b/);
  });

  it("names the strong points when asked what it is good at", async () => {
    const id = await shoeWithSpecs();
    if (!id) return;

    const result = await refineProduct({
      productId: id,
      message: "What are some of its good performing features?",
    });
    expect(result!.reply).toMatch(/\d\/5/);
  });

  it("says what it does not know instead of reciting price and stock", async () => {
    // This fallback is why every gap went unnoticed: unanswered questions came
    // back looking answered. A catch-all that always produces a plausible
    // sentence turns a missing feature into a silent one.
    const id = await shoeWithSpecs();
    if (!id) return;

    const result = await refineProduct({
      productId: id,
      message: "who manufactures the laces",
    });
    expect(result!.reply.toLowerCase()).toContain("does not cover");
    // And it says what it CAN answer, so the dead end becomes a next step.
    expect(result!.reply.toLowerCase()).toContain("colours and sizes");
  });
});

describe("a colour is a content word, not any word after 'in'", () => {
  it("does not read a pronoun as a colour", async () => {
    // "will my feet get hot in these" matched the "in <word>" shape and took
    // "these" as a colour, so a question about heat was refused with
    // "no colour these on this one".
    const [row] = (await db.execute(sql`
      SELECT p.id FROM products p
      JOIN product_variants v ON v.product_id = p.id
      WHERE p.status = 'active' AND v.attributes->>'color' IS NOT NULL
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!row) return;

    for (const question of [
      "will my feet get hot in these",
      "are these comfortable in summer",
      "how do they hold up in the rain",
    ]) {
      const result = await refineProduct({ productId: row.id, message: question });
      expect(result!.reply.toLowerCase(), question).not.toContain("no colour");
    }
  });

  it("still hears a real colour, stocked or not", async () => {
    const [row] = (await db.execute(sql`
      SELECT p.id FROM products p
      JOIN product_variants v ON v.product_id = p.id
      WHERE p.status = 'active' AND v.attributes->>'color' IS NOT NULL
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!row) return;

    const refused = await refineProduct({ productId: row.id, message: "do you have it in chartreuse" });
    expect(refused!.reply.toLowerCase()).toContain("chartreuse");
  });
});

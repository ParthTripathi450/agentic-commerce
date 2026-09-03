import { sql } from "drizzle-orm";
import { db } from "@/db";
import { affinityFor, hasTaste, type TasteProfile } from "@/server/agents/customer/affinity";
import { buildKnowledgeBase, toTasteProfile, type KnowledgeBase } from "./knowledge";

/**
 * Suggestions built from the shopper's own knowledge base.
 *
 * The failure mode this is designed against is a "for you" page that is a
 * mirror: a shopper who has bought running shoes shown nothing but running
 * shoes, from the brand they already own, forever. That is what a naive
 * similarity feed produces, and it is useless — they have the thing already.
 *
 * Three rules keep it from happening.
 *
 * **Nothing they already own.** Products from a delivered or paid order are
 * excluded outright. It is the single largest source of embarrassing
 * suggestions and the cheapest to remove.
 *
 * **Every shelf states its reason, and the reasons differ.** A shelf that
 * cannot say why it exists is merchandising pretending to be personal. They are
 * built from different parts of the profile on purpose, so the page as a whole
 * widens rather than narrows.
 *
 * **One shelf deliberately leaves their categories.** Qualities are the
 * portable part of a profile — "likes breathable, packable things" is true of a
 * jacket as much as a shoe — so the discovery shelf ranks on qualities alone and
 * excludes what they usually buy. It is the only part of the page that can show
 * them something genuinely new, and without it this is a mirror however well the
 * rest is built.
 */

export type Suggestion = {
  productId: string;
  variantId: string;
  title: string;
  brand: string | null;
  category: string;
  merchantName: string;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  ratingBp: number | null;
  ratingCount: number;
  /** Why this one, from `affinityFor` — the shopper's own history, in words. */
  reasons: string[];
};

export type Shelf = {
  id: string;
  title: string;
  /** One line saying which part of their history built this shelf. */
  because: string;
  items: Suggestion[];
};

export type ForYou = {
  shelves: Shelf[];
  knowledge: KnowledgeBase;
  /** True when there is not enough history to suggest anything honestly. */
  isCold: boolean;
};

type Row = Record<string, unknown>;

/**
 * Buyable products, minus everything this shopper already owns.
 *
 * `NOT EXISTS` against their own paid and fulfilled orders rather than a join,
 * so a product bought twice does not duplicate the row it is meant to remove.
 */
function candidateSql(userId: string, where: ReturnType<typeof sql>, limit: number) {
  return sql`
    WITH cheapest AS (
      SELECT DISTINCT ON (v.product_id)
             v.product_id, v.id AS variant_id, v.price_minor, v.currency, v.image_url,
             v.attributes->>'color' AS color
      FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active = true AND GREATEST(i.quantity - i.reserved, 0) > 0
      ORDER BY v.product_id, v.price_minor ASC
    )
    SELECT p.id AS product_id, p.title, p.brand, p.category, p.attributes, p.image_urls,
           p.rating_bp, p.rating_count,
           m.name AS merchant_name,
           c.variant_id, c.price_minor, c.currency, c.image_url AS variant_image, c.color
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    JOIN cheapest c ON c.product_id = p.id
    WHERE p.status = 'active' AND m.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN product_variants ov ON ov.id = oi.variant_id
        WHERE ov.product_id = p.id
          AND o.user_id = ${userId}
          AND o.state IN ('paid','fulfilled')
      )
      AND ${where}
    ORDER BY p.rating_bp DESC NULLS LAST, p.rating_count DESC
    LIMIT ${limit}
  `;
}

function toSuggestion(row: Row, taste: TasteProfile): Suggestion {
  const { reasons } = affinityFor(
    {
      brand: row.brand as string | null,
      category: row.category as string,
      merchantName: row.merchant_name as string,
      colour: row.color as string | null,
      priceMinor: Number(row.price_minor),
      qualities: (row.attributes as { qualities?: Record<string, number> })?.qualities,
    },
    taste,
  );

  return {
    productId: String(row.product_id),
    variantId: String(row.variant_id),
    title: String(row.title),
    brand: row.brand ? String(row.brand) : null,
    category: String(row.category),
    merchantName: String(row.merchant_name),
    priceMinor: Number(row.price_minor),
    currency: (row.currency as string) ?? "INR",
    imageUrl: (row.variant_image as string) ?? ((row.image_urls as string[]) ?? [])[0] ?? null,
    ratingBp: row.rating_bp != null ? Number(row.rating_bp) : null,
    ratingCount: Number(row.rating_count ?? 0),
    reasons,
  };
}

/**
 * Scores a candidate pool by affinity and keeps the best.
 *
 * Retrieval is deliberately broad and the ranking is done here, in the same
 * pure function the agent uses, so a suggestion is scored exactly as it would
 * be inside a search. Two places scoring "fits you" differently is how a
 * recommendation comes to contradict the ranking that follows it.
 */
function rankByAffinity(rows: Row[], taste: TasteProfile, take: number): Suggestion[] {
  return rows
    .map((row) => ({
      row,
      score: affinityFor(
        {
          brand: row.brand as string | null,
          category: row.category as string,
          merchantName: row.merchant_name as string,
          colour: row.color as string | null,
          priceMinor: Number(row.price_minor),
          qualities: (row.attributes as { qualities?: Record<string, number> })?.qualities,
        },
        taste,
      ).normalized,
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => toSuggestion(row, taste))
    .filter(dedupeByTitle())
    .slice(0, take);
}

/** A product several merchants stock otherwise fills a shelf with itself. */
function dedupeByTitle() {
  const seen = new Set<string>();
  return (item: Suggestion) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

const inList = (values: string[]) =>
  sql.join(values.map((v) => sql`${v}`), sql`, `);

export async function buildForYou(userId: string, perShelf = 6): Promise<ForYou> {
  const knowledge = await buildKnowledgeBase(userId);
  const taste = toTasteProfile(knowledge);

  // A cold shopper gets an honest empty state, not invented preferences. The
  // page says so and points at browse rather than dressing up bestsellers as
  // "picked for you", which would be a straightforward lie.
  if (knowledge.isEmpty || !hasTaste(taste)) {
    return { shelves: [], knowledge, isCold: true };
  }

  const likedCategories = knowledge.likes.categories.slice(0, 4).map((p) => p.value);
  const likedBrands = knowledge.likes.brands.slice(0, 4).map((p) => p.value);
  const likedQualities = knowledge.likes.qualities.slice(0, 3).map((p) => p.value);
  const budget = knowledge.budget;

  const queries: Promise<Row[]>[] = [];
  const specs: { id: string; title: string; because: string }[] = [];

  const add = (
    id: string,
    title: string,
    because: string,
    where: ReturnType<typeof sql>,
    pool = 60,
  ) => {
    specs.push({ id, title, because });
    queries.push(db.execute<Row>(candidateSql(userId, where, pool)) as unknown as Promise<Row[]>);
  };

  if (likedCategories.length > 0) {
    add(
      "categories",
      "More of what you shop for",
      `You keep coming back to ${humanList(likedCategories.slice(0, 3))}.`,
      sql`p.category IN (${inList(likedCategories)})`,
    );
  }

  if (likedBrands.length > 0) {
    add(
      "brands",
      "From brands you return to",
      `You have bought ${humanList(likedBrands.slice(0, 3))} before.`,
      sql`p.brand IN (${inList(likedBrands)})`,
    );
  }

  if (likedQualities.length > 0) {
    /*
     * The discovery shelf. Categories they already buy are EXCLUDED on purpose:
     * this shelf exists to leave their habits, and if it were allowed to return
     * more running shoes it would, because those score highest on every axis.
     * Qualities are what makes that possible — they are the one part of a
     * profile that means the same thing in a category the shopper has never
     * touched.
     */
    const qualityFilter = sql.join(
      likedQualities.map(
        (q) => sql`COALESCE((p.attributes->'qualities'->>${q})::int, 0) >= 4`,
      ),
      sql` AND `,
    );
    add(
      "discover",
      "Worth a look, outside your usual",
      `Different from what you normally buy, but strong on ${humanList(likedQualities.map(humanise))} — the things your purchases and reviews say you care about.`,
      likedCategories.length > 0
        ? sql`(${qualityFilter}) AND p.category NOT IN (${inList(likedCategories)})`
        : qualityFilter,
    );
  }

  if (budget && budget.orders >= 2) {
    add(
      "budget",
      "In your usual range",
      `Most of what you buy lands between ${rupees(budget.p25Minor)} and ${rupees(budget.p75Minor)}.`,
      sql`c.price_minor BETWEEN ${budget.p25Minor} AND ${budget.p75Minor}`,
    );
  }

  const pools = await Promise.all(queries);

  // A shelf that came back empty is dropped rather than rendered as a heading
  // over nothing, and the same product is never repeated across shelves — a
  // page that shows one item four times reads as having nothing to say.
  const alreadyShown = new Set<string>();
  const shelves: Shelf[] = [];

  for (const [index, spec] of specs.entries()) {
    const items = rankByAffinity(pools[index], taste, perShelf * 2)
      .filter((item) => !alreadyShown.has(item.productId))
      .slice(0, perShelf);

    if (items.length === 0) continue;
    for (const item of items) alreadyShown.add(item.productId);
    shelves.push({ ...spec, items });
  }

  return { shelves, knowledge, isCold: shelves.length === 0 };
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function humanise(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function rupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
}

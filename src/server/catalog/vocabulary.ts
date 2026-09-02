import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The catalog's real vocabulary: categories, brands and variant axis values
 * that actually exist.
 *
 * Both the LLM intent parser and the rule-based fallback are grounded in this,
 * so neither can produce a filter the catalog cannot satisfy (asking for
 * "crimson" when the axis only holds "red" would silently return nothing).
 */

export type Vocabulary = {
  categories: string[];
  brands: string[];
  /** Variant axis name → distinct values, e.g. { color: [...], size: [...] }. */
  axes: Record<string, string[]>;
};

const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; value: Vocabulary } | null = null;

export async function getVocabulary(force = false): Promise<Vocabulary> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const categoryRows = await db.execute<{ category: string }>(sql`
    SELECT DISTINCT category FROM products WHERE status = 'active' ORDER BY category
  `);
  const brandRows = await db.execute<{ brand: string }>(sql`
    SELECT DISTINCT brand FROM products WHERE status = 'active' AND brand IS NOT NULL ORDER BY brand
  `);
  const axisRows = await db.execute<{ axis: string; value: string }>(sql`
    SELECT DISTINCT kv.key AS axis, kv.value AS value
    FROM product_variants v, jsonb_each_text(v.attributes) AS kv(key, value)
    WHERE v.active = true
    ORDER BY axis, value
  `);

  const axes: Record<string, string[]> = {};
  for (const row of axisRows as unknown as { axis: string; value: string }[]) {
    (axes[row.axis] ??= []).push(row.value);
  }

  const value: Vocabulary = {
    categories: (categoryRows as unknown as { category: string }[]).map((r) => r.category),
    brands: (brandRows as unknown as { brand: string }[]).map((r) => r.brand),
    axes,
  };

  cached = { at: Date.now(), value };
  return value;
}

export function invalidateVocabulary() {
  cached = null;
}

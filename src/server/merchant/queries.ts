import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The categories this merchant actually sells, for scoping a promotion.
 *
 * Read from their own catalogue rather than offered as a fixed list: a
 * promotion scoped to a category they do not stock would never apply, and the
 * merchant would have no way to tell why.
 */
export async function merchantCategories(merchantId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT category FROM products
    WHERE merchant_id = ${merchantId} AND status = 'active'
    ORDER BY category
  `)) as unknown as { category: string }[];
  return rows.map((r) => r.category);
}

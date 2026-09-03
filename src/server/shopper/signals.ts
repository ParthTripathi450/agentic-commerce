import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopperSignals } from "@/db/schema";

/**
 * Recording the browsing half of the knowledge base.
 *
 * Every write here is best-effort and swallows its own errors. A page must
 * never fail to render, and a search must never fail to run, because logging
 * that someone looked at something did not work — the signal is worth 1 point
 * against a purchase's 4, so losing one is not worth a visible error.
 */

/** Views of the same product inside this window collapse into one row. */
const VIEW_DEDUPE_MINUTES = 30;

type ViewSignal = {
  userId: string;
  productId: string;
  category?: string | null;
  brand?: string | null;
  priceMinor?: number | null;
};

export async function recordProductView(signal: ViewSignal): Promise<void> {
  try {
    // Re-reading a product page while comparing options is one interest, not
    // five. Without this, revisiting a tab would outweigh a real purchase.
    const [recent] = await db
      .select({ id: shopperSignals.id })
      .from(shopperSignals)
      .where(
        and(
          eq(shopperSignals.userId, signal.userId),
          eq(shopperSignals.productId, signal.productId),
          eq(shopperSignals.kind, "view"),
          sql`${shopperSignals.createdAt} > now() - interval '${sql.raw(String(VIEW_DEDUPE_MINUTES))} minutes'`,
        ),
      )
      .limit(1);
    if (recent) return;

    await db.insert(shopperSignals).values({
      userId: signal.userId,
      kind: "view",
      productId: signal.productId,
      category: signal.category ?? null,
      brand: signal.brand ?? null,
      priceMinor: signal.priceMinor ?? null,
    });
  } catch {
    // Best-effort by design; see the module comment.
  }
}

export async function recordSearch(
  userId: string,
  query: string,
  categories: string[] = [],
): Promise<void> {
  const trimmed = query.trim().slice(0, 200);
  if (!trimmed) return;
  try {
    await db.insert(shopperSignals).values({
      userId,
      kind: "search",
      query: trimmed,
      category: categories[0] ?? null,
    });
  } catch {
    // Best-effort by design.
  }
}

/**
 * A filter the shopper ticked deliberately.
 *
 * Narrower evidence than a search phrase but the same weight: choosing
 * "Running Shoes" from a list is a statement about what they want, even though
 * it costs one click.
 */
export async function recordFilter(
  userId: string,
  filter: { category?: string; brand?: string; maxPriceMinor?: number },
): Promise<void> {
  if (!filter.category && !filter.brand) return;
  try {
    await db.insert(shopperSignals).values({
      userId,
      kind: "filter",
      category: filter.category ?? null,
      brand: filter.brand ?? null,
      priceMinor: filter.maxPriceMinor ?? null,
    });
  } catch {
    // Best-effort by design.
  }
}

/**
 * Erase the browsing history the profile is built from.
 *
 * Only the weak signals live in this table, so this is the one part of the
 * knowledge base that can be deleted outright — orders and reviews are records
 * of real transactions and are not ours to remove on a preference toggle.
 */
export async function deleteShopperSignals(userId: string): Promise<number> {
  const deleted = await db
    .delete(shopperSignals)
    .where(eq(shopperSignals.userId, userId))
    .returning({ id: shopperSignals.id });
  return deleted.length;
}

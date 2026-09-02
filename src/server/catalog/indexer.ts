import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogDocuments,
  merchantPolicies,
  merchants,
  productVariants,
  products,
} from "@/db/schema";
import { embed } from "@/server/ai/embeddings";
import { buildAiText, sourceHash, type NormalizerInput } from "./normalize";

const EMBED_BATCH = 32;

export type IndexResult = {
  total: number;
  indexed: number;
  skipped: number;
  durationMs: number;
};

/** Assembles the normalizer input for the given products (all, if unscoped). */
async function loadInputs(productIds?: string[]) {
  const base = db
    .select({
      product: products,
      merchant: merchants,
      policies: merchantPolicies,
    })
    .from(products)
    .innerJoin(merchants, eq(products.merchantId, merchants.id))
    .leftJoin(merchantPolicies, eq(merchantPolicies.merchantId, merchants.id))
    .$dynamic();

  const rows = await (productIds?.length
    ? base.where(inArray(products.id, productIds))
    : base);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.product.id);
  const variants = await db
    .select()
    .from(productVariants)
    .where(inArray(productVariants.productId, ids));

  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  return rows.map(({ product, merchant, policies }) => {
    const input: NormalizerInput = {
      product: {
        id: product.id,
        title: product.title,
        description: product.description,
        brand: product.brand,
        category: product.category,
        attributes: product.attributes,
        ratingBp: product.ratingBp,
        ratingCount: product.ratingCount,
        searchTags: product.searchTags ?? [],
      },
      merchant: {
        name: merchant.name,
        slug: merchant.slug,
        description: merchant.description,
      },
      policies: policies
        ? {
            returnWindowDays: policies.returnWindowDays,
            returnsAccepted: policies.returnsAccepted,
            standardDeliveryDays: policies.standardDeliveryDays,
            warrantyText: policies.warrantyText,
          }
        : null,
      variants: variants
        .filter((v) => v.productId === product.id)
        .map((v) => ({
          attributes: v.attributes,
          priceMinor: v.priceMinor,
          currency: v.currency,
          active: v.active,
        })),
    };
    return { merchantId: merchant.id, input };
  });
}

/**
 * Rebuilds the AI-readable catalog: normalised text + embedding per product.
 *
 * Products whose source hash is unchanged are skipped, so this is safe to call
 * on every dashboard save as well as for a full rebuild.
 */
export async function indexCatalog(options?: {
  productIds?: string[];
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<IndexResult> {
  const startedAt = Date.now();
  const entries = await loadInputs(options?.productIds);
  const total = entries.length;
  if (total === 0) return { total: 0, indexed: 0, skipped: 0, durationMs: 0 };

  const existing = await db
    .select({
      productId: catalogDocuments.productId,
      sourceHash: catalogDocuments.sourceHash,
    })
    .from(catalogDocuments)
    .where(inArray(catalogDocuments.productId, entries.map((e) => e.input.product.id)));
  const hashByProduct = new Map(existing.map((e) => [e.productId, e.sourceHash]));

  const pending = entries
    .map((entry) => ({
      ...entry,
      hash: sourceHash(entry.input),
      aiText: buildAiText(entry.input),
    }))
    .filter((entry) => options?.force || hashByProduct.get(entry.input.product.id) !== entry.hash);

  const skipped = total - pending.length;
  let done = 0;

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map((b) => b.aiText));

    await db
      .insert(catalogDocuments)
      .values(
        batch.map((entry, idx) => ({
          productId: entry.input.product.id,
          merchantId: entry.merchantId,
          aiText: entry.aiText,
          // Stored apart so the generated vector can weight them above the body.
          titleText: entry.input.product.title,
          tagsText: entry.input.product.searchTags.join(", "),
          embedding: vectors[idx],
          sourceHash: entry.hash,
          embeddedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: catalogDocuments.productId,
        set: {
          aiText: sql`excluded.ai_text`,
          titleText: sql`excluded.title_text`,
          tagsText: sql`excluded.tags_text`,
          embedding: sql`excluded.embedding`,
          sourceHash: sql`excluded.source_hash`,
          embeddedAt: sql`excluded.embedded_at`,
          updatedAt: new Date(),
        },
      });

    done += batch.length;
    options?.onProgress?.(done, pending.length);
  }

  return { total, indexed: pending.length, skipped, durationMs: Date.now() - startedAt };
}

/** Removes catalog documents for products that no longer exist or are archived. */
export async function pruneCatalog(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM catalog_documents cd
    USING products p
    WHERE cd.product_id = p.id AND p.status <> 'active'
  `);
  return result.length ?? 0;
}

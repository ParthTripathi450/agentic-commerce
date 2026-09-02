import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { ProductForm, VariantRow } from "@/components/merchant/product-forms";
import { AddVariantForm } from "@/components/merchant/variant-manager";
import { ProductImages } from "@/components/merchant/product-images";
import { ProductTags } from "@/components/merchant/product-tags";
import { db } from "@/db";
import { availabilityWindows, catalogDocuments, inventory, productVariants, products } from "@/db/schema";
import { requireMerchant } from "@/lib/session";
import { formatAttributeLines } from "@/server/catalog/actions";

export default async function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await requireMerchant();
  const { id } = await params;

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!product) notFound();

  const variants = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      priceMinor: productVariants.priceMinor,
      active: productVariants.active,
      quantity: inventory.quantity,
      reserved: inventory.reserved,
      lowStockThreshold: inventory.lowStockThreshold,
      windowStartsAt: availabilityWindows.startsAt,
      windowEndsAt: availabilityWindows.endsAt,
    })
    .from(productVariants)
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .leftJoin(availabilityWindows, eq(availabilityWindows.variantId, productVariants.id))
    .where(eq(productVariants.productId, id));

  const now = new Date();
  /** datetime-local wants "YYYY-MM-DDTHH:mm" with no timezone suffix. */
  const forInput = (date: Date | null) =>
    date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : null;

  const [document] = await db
    .select()
    .from(catalogDocuments)
    .where(eq(catalogDocuments.productId, id))
    .limit(1);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/merchant/products" className="text-xs text-muted-foreground hover:text-foreground">
          ← Products
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{product.title}</h1>
      </div>

      <ProductForm
        product={{
          id: product.id,
          title: product.title,
          description: product.description,
          brand: product.brand,
          category: product.category,
          status: product.status,
          attributeLines: await formatAttributeLines(product.attributes),
        }}
      />

      <ProductTags productId={product.id} initialTags={product.searchTags ?? []} />

      <ProductImages productId={product.id} imageUrls={product.imageUrls} />

      <Card>
        <CardHeader>
          <CardTitle>Variants, pricing and stock</CardTitle>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {variants.map((variant) => (
            <VariantRow
              key={variant.id}
              productId={product.id}
              variant={{
                id: variant.id,
                sku: variant.sku,
                isOnlyVariant: variants.length <= 1,
                attributes: variant.attributes,
                priceMinor: variant.priceMinor,
                quantity: variant.quantity ?? 0,
                reserved: variant.reserved ?? 0,
                lowStockThreshold: variant.lowStockThreshold ?? 5,
                active: variant.active,
                windowStartsAt: forInput(variant.windowStartsAt),
                windowEndsAt: forInput(variant.windowEndsAt),
                inWindow:
                  !variant.windowStartsAt ||
                  (variant.windowStartsAt <= now &&
                    (!variant.windowEndsAt || variant.windowEndsAt >= now)),
              }}
            />
          ))}
          <AddVariantForm productId={product.id} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What AI agents read</CardTitle>
        </CardHeader>
        <CardBody>
          {document ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Generated from the fields above — you never write this by hand. It is embedded for
                semantic search and rendered into this merchant&rsquo;s ACP feed.
              </p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs leading-relaxed">
                {document.aiText}
              </pre>
              <p className="mt-2 text-xs text-subtle">
                Last indexed{" "}
                {document.embeddedAt ? new Date(document.embeddedAt).toLocaleString("en-IN") : "never"}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not indexed yet — agents cannot discover this product. Save it to generate its AI
              document.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge, Card, CardBody, EmptyState, LinkButton } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import { getMerchantProducts } from "@/server/catalog/actions";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { merchant } = await requireMerchant();
  const { q } = await searchParams;
  const all = await getMerchantProducts(merchant.id);

  // Sidebar search lands here; match on the fields a merchant would search by.
  const query = (q ?? "").trim().toLowerCase();
  const products = query
    ? all.filter((p) =>
        [p.title, p.category, p.brand ?? ""].some((field) => field.toLowerCase().includes(query)),
      )
    : all;
  const unindexed = products.filter((p) => !p.indexed && p.status === "active").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description={
          query
            ? `${products.length} of ${all.length} products matching "${q}".`
            : `${products.length} products. Saving a change re-indexes it for AI discovery automatically — there is no separate publish step.`
        }
        actions={<LinkButton href="/merchant/products/new">Add product</LinkButton>}
      />

      {unindexed > 0 ? (
        <Card>
          <CardBody className="text-sm text-muted-foreground">
            {unindexed} active product{unindexed === 1 ? " is" : "s are"} not yet in the AI
            catalog and cannot be found by agents. Re-index from the{" "}
            <Link href="/merchant/protocols" className="text-primary hover:underline">
              Protocols
            </Link>{" "}
            page.
          </CardBody>
        </Card>
      ) : null}

      {products.length === 0 ? (
        <EmptyState title={query ? `Nothing matches "${q}"` : "No products yet"}>
          {query ? (
            <Link href="/merchant/products" className="text-primary hover:underline">
              Clear the search
            </Link>
          ) : (
            "Add your first product to become discoverable."
          )}
        </EmptyState>
      ) : (
        <Card>
          <CardBody className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Category</th>
                    <th className="px-3 py-2 text-right font-medium">Variants</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Stock</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-5 py-2.5">
                        <Link href={`/merchant/products/${product.id}`} className="font-medium hover:text-primary">
                          {product.title}
                        </Link>
                        {product.brand ? (
                          <span className="ml-1.5 text-xs text-subtle">{product.brand}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{product.category}</td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">{product.variantCount}</td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {product.minPriceMinor === product.maxPriceMinor
                          ? formatMoney(product.minPriceMinor)
                          : `${formatMoney(product.minPriceMinor)}–${formatMoney(product.maxPriceMinor)}`}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">
                        <span className={product.totalStock === 0 ? "text-danger" : ""}>
                          {product.totalStock}
                        </span>
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex gap-1">
                          <Badge tone={product.status === "active" ? "success" : "neutral"}>
                            {product.status}
                          </Badge>
                          {product.status === "active" && !product.indexed ? (
                            <Badge tone="warning">not indexed</Badge>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

import { ShoppingAgent } from "@/components/shop/shopping-agent";
import { PageHeader } from "@/components/page-header";
import { requireCustomer } from "@/lib/session";
import { providerStatus } from "@/server/ai/llm";
import { getFeaturedProducts } from "@/server/catalog/featured";
import { describeMethod, getDefaultPaymentMethod } from "@/server/payments/queries";

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireCustomer();
  const { q } = await searchParams;
  const [featured, method] = await Promise.all([
    getFeaturedProducts(8),
    getDefaultPaymentMethod(user.id),
  ]);
  const status = providerStatus();

  return (
    <div>
      <PageHeader
        title="Shopping agent"
        description="Describe what you want in plain language. The agent searches every merchant's machine-readable catalog, ranks the options on published criteria, and explains why it chose one over the others."
      />
      <ShoppingAgent
        degraded={status.degradedMode}
        featured={featured}
        initialQuery={q}
        savedMethod={method ? describeMethod(method) : null}
      />
    </div>
  );
}

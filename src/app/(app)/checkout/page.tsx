import { PageHeader } from "@/components/page-header";
import { GroupCheckoutFlow } from "@/components/cart/group-checkout-flow";
import { requireCustomer } from "@/lib/session";
import { describeMethod, getDefaultPaymentMethod } from "@/server/payments/queries";

/**
 * One checkout for the whole cart.
 *
 * There is no per-cart parameter any more: baskets stay per-merchant because
 * fulfilment and Cart Mandates are, but the shopper pays once.
 */
export default async function CheckoutPage() {
  const user = await requireCustomer();
  const method = await getDefaultPaymentMethod(user.id);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Checkout"
        description="Nothing is charged until you allow it. Your limits and the signed mandate chain are checked first."
      />
      <GroupCheckoutFlow savedMethod={method ? describeMethod(method) : null} />
    </div>
  );
}

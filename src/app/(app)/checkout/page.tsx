import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { CheckoutFlow } from "@/components/cart/checkout-flow";
import { requireCustomer } from "@/lib/session";
import { describeMethod, getDefaultPaymentMethod } from "@/server/payments/queries";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ cart?: string }>;
}) {
  const user = await requireCustomer();
  const { cart } = await searchParams;
  if (!cart) redirect("/cart");

  const method = await getDefaultPaymentMethod(user.id);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Checkout"
        description="Nothing is charged until you allow it. Your limits and the signed mandate chain are checked first."
      />
      <CheckoutFlow cartId={cart} savedMethod={method ? describeMethod(method) : null} />
    </div>
  );
}

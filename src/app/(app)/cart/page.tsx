import { PageHeader } from "@/components/page-header";
import { CartList, type CartView } from "@/components/cart/cart-view";
import { LinkButton } from "@/components/ui";
import { requireCustomer } from "@/lib/session";
import { getOpenCarts } from "@/server/commerce/cart";
import { getProductImages } from "@/server/catalog/featured";

export default async function CartPage() {
  const user = await requireCustomer();
  const carts = await getOpenCarts(user.id);

  const images = await getProductImages(carts.flatMap((c) => c.lines.map((l) => l.productId)));

  const views: CartView[] = carts.map((cart) => ({
    cartId: cart.cartId,
    merchant: cart.merchant,
    totals: cart.totals,
    issues: cart.issues,
    lines: cart.lines.map((line) => ({
      variantId: line.variantId,
      title: line.title,
      attributes: line.attributes,
      quantity: line.quantity,
      unitPriceMinor: line.currentPriceMinor,
      availableQuantity: line.availableQuantity,
      imageUrl: images.get(line.productId) ?? null,
    })),
  }));

  const totalUnits = carts.reduce((sum, c) => sum + c.itemCount, 0);

  return (
    <div>
      <PageHeader
        title="Your cart"
        description={
          totalUnits > 0
            ? `${totalUnits} item${totalUnits === 1 ? "" : "s"} ready to check out.`
            : "Nothing here yet."
        }
        actions={<LinkButton href="/shop" variant="secondary">Keep shopping</LinkButton>}
      />
      <CartList carts={views} />
    </div>
  );
}

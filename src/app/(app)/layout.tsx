import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { catalogDocuments, merchants, products } from "@/db/schema";
import { CatalogHealth } from "@/components/merchant/catalog-health";
import { getCartItemCount } from "@/server/commerce/cart";
import { AppSidebar, SignOutButton, type NavItem } from "@/components/app-sidebar";
import { Toaster } from "@/components/ui/sonner";
import { auth } from "@/lib/auth";
import { signOutAction } from "@/server/auth/actions";

const customerNav = (cartCount: number): NavItem[] => [
  { href: "/shop", label: "Shop with AI", icon: "shop" },
  { href: "/browse", label: "Browse products", icon: "store" },
  { href: "/for-you", label: "For you", icon: "insights" },
  { href: "/cart", label: "Your cart", icon: "cart", badge: cartCount || undefined },
  { href: "/orders", label: "Your orders", icon: "orders" },
  { href: "/reviews", label: "Your reviews", icon: "reviews" },
  { href: "/support", label: "Support", icon: "support" },
];

const CUSTOMER_SECONDARY: NavItem[] = [
  { href: "/preferences", label: "What we've learned", icon: "insights" },
  { href: "/activity", label: "Agent activity", icon: "activity" },
  { href: "/settings/limits", label: "Spending limits", icon: "limits" },
];

const MERCHANT_PRIMARY: NavItem[] = [
  { href: "/merchant", label: "Overview", icon: "dashboard" },
  { href: "/merchant/products", label: "Products", icon: "products" },
  { href: "/merchant/orders", label: "Orders", icon: "merchantOrders" },
  { href: "/merchant/promotions", label: "Promotions", icon: "promotions" },
  { href: "/merchant/insights", label: "Insights", icon: "insights" },
  { href: "/merchant/reviews", label: "Reviews", icon: "reviews" },
];

const MERCHANT_SECONDARY: NavItem[] = [
  { href: "/merchant/support", label: "Customer queries", icon: "support" },
  { href: "/merchant/protocols", label: "Protocols", icon: "protocols" },
  { href: "/merchant/settings", label: "Settings", icon: "settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const isMerchant = session.user.role === "merchant";
  const cartCount = isMerchant ? 0 : await getCartItemCount(session.user.id);

  // How much of this merchant's catalogue AI buyers can actually find.
  let health: { indexed: number; total: number } | null = null;
  if (isMerchant) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        indexed: sql<number>`count(${catalogDocuments.productId})`,
      })
      .from(products)
      .innerJoin(merchants, eq(merchants.id, products.merchantId))
      .leftJoin(catalogDocuments, eq(catalogDocuments.productId, products.id))
      .where(and(eq(merchants.userId, session.user.id), eq(products.status, "active")));
    if (row) health = { indexed: Number(row.indexed), total: Number(row.total) };
  }

  return (
    <div className="flex min-h-screen">
      <AppSidebar
        primary={isMerchant ? MERCHANT_PRIMARY : customerNav(cartCount)}
        secondary={isMerchant ? MERCHANT_SECONDARY : CUSTOMER_SECONDARY}
        user={{
          name: session.user.name ?? "Account",
          email: session.user.email ?? "",
          role: session.user.role,
        }}
        signOut={
          <form action={signOutAction}>
            <SignOutButton />
          </form>
        }
        footer={health ? <CatalogHealth indexed={health.indexed} total={health.total} /> : undefined}
      />

      {/* Left-aligned against the sidebar with a readable max width — centring
          it left a dead gap beside the nav on wide screens. */}
      <div className="min-w-0 flex-1 bg-background">
        <main className="w-full max-w-[1280px] px-6 py-8 lg:px-10">{children}</main>
      </div>

      <Toaster position="bottom-right" />
    </div>
  );
}

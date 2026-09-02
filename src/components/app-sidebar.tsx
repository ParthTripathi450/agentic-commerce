"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  BadgeIndianRupee,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  LifeBuoy,
  type LucideIcon,
  Network,
  Receipt,
  Search,
  ShoppingCart,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  Tags,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Rendered as a pill on the right of the row, e.g. a cart count. */
  badge?: number;
};

const ICONS = {
  dashboard: LayoutDashboard,
  shop: Sparkles,
  orders: Receipt,
  activity: ShieldCheck,
  limits: BadgeIndianRupee,
  products: Boxes,
  merchantOrders: ClipboardList,
  promotions: Tags,
  insights: Sparkles,
  protocols: Network,
  settings: Settings,
  cart: ShoppingCart,
  support: LifeBuoy,
  store: Store,
} satisfies Record<string, LucideIcon>;

export function AppSidebar({
  primary,
  secondary,
  user,
  signOut,
  footer,
}: {
  primary: NavItem[];
  secondary: NavItem[];
  user: { name: string; email: string; role: string };
  signOut: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");

  // Search filters the nav as you type; Enter runs a real search on the surface
  // that can answer it — the shopping agent, or the merchant's own catalogue.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { primary, secondary };
    const match = (item: NavItem) => item.label.toLowerCase().includes(q);
    return { primary: primary.filter(match), secondary: secondary.filter(match) };
  }, [query, primary, secondary]);

  const runSearch = () => {
    const q = query.trim();
    if (!q) return;
    const isMerchant = user.role === "merchant";
    router.push(isMerchant ? `/merchant/products?q=${encodeURIComponent(q)}` : `/shop?q=${encodeURIComponent(q)}`);
    setQuery("");
  };

  /** Longest matching href wins, so /merchant does not light up on /merchant/orders. */
  const activeHref = [...primary, ...secondary]
    .map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  const renderItem = (item: NavItem) => {
    const Icon = ICONS[item.icon];
    const active = item.href === activeHref;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
          )}
        >
          <Icon className="size-4.5 shrink-0" strokeWidth={2} />
          <span className="truncate">{item.label}</span>
          {item.badge ? (
            <span className="tabular ml-auto rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[11px] font-semibold text-sidebar-primary-foreground">
              {item.badge}
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  return (
    <aside className="sticky top-0 flex h-screen w-[268px] shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar px-4 py-5">
      <Link href={primary[0]?.href ?? "/"} className="px-1">
        <Logo tone="sidebar" />
      </Link>

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-sidebar-muted"
          strokeWidth={2}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch();
            if (event.key === "Escape") setQuery("");
          }}
          placeholder="Search"
          aria-label="Search navigation and catalogue"
          className="h-9 w-full rounded-lg border border-sidebar-border bg-sidebar-accent/60 pl-9 pr-3 text-sm text-sidebar-foreground placeholder:text-sidebar-muted focus-visible:border-sidebar-ring focus-visible:ring-2 focus-visible:ring-sidebar-ring/40 focus-visible:outline-none"
        />
      </div>

      <nav className="flex-1 overflow-y-auto">
        {filtered.primary.length === 0 && filtered.secondary.length === 0 ? (
          <p className="px-3 py-2 text-xs text-sidebar-muted">
            No pages match. Press Enter to search the catalogue.
          </p>
        ) : (
          <ul className="space-y-1">{filtered.primary.map(renderItem)}</ul>
        )}
      </nav>

      {filtered.secondary.length > 0 ? (
        <ul className="space-y-1 border-t border-sidebar-border pt-3">
          {filtered.secondary.map(renderItem)}
        </ul>
      ) : null}

      {footer}

      <div className="flex items-center gap-2.5 rounded-lg border border-sidebar-border p-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          {user.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-sidebar-foreground">
            {user.name}
          </span>
          <span className="block truncate text-xs text-sidebar-muted">{user.email}</span>
        </span>
        {signOut}
      </div>
    </aside>
  );
}

/** Sign-out control, kept separate so the sidebar itself stays a client island. */
export function SignOutButton() {
  return (
    <Button
      type="submit"
      variant="ghost"
      size="icon"
      aria-label="Sign out"
      className="shrink-0 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-4.5" aria-hidden>
        <path
          d="M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2M10 17l5-5-5-5M15 12H3"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Button>
  );
}

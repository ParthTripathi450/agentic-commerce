import { PageHeader } from "@/components/page-header";
import { BrowseFilters } from "@/components/shop/browse-filters";
import { BrowseGrid } from "@/components/shop/browse-grid";
import { requireCustomer } from "@/lib/session";
import { recordFilter, recordSearch } from "@/server/shopper/signals";
import { PAGE_SIZE, type BrowseQuery, type BrowseSort } from "@/lib/browse";
import { browseCatalog, browseMerchants } from "@/server/catalog/browse";

const SORTS: BrowseSort[] = ["relevance", "price_asc", "price_desc", "rating", "popular", "newest"];

type Params = Record<string, string | string[] | undefined>;

const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Query strings are user input like any other.
 *
 * Everything here is parsed to a known shape before it reaches SQL: a bad sort
 * key falls back rather than reaching an ORDER BY, and a non-numeric price is
 * dropped rather than becoming NaN — which would silently match nothing and
 * look like an empty catalogue.
 */
function parseQuery(params: Params): BrowseQuery {
  const num = (v: string | string[] | undefined) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

  const sort = one(params.sort);
  return {
    q: one(params.q)?.slice(0, 120),
    categories: many(params.category),
    brands: many(params.brand),
    merchant: one(params.merchant),
    minPriceMinor: num(params.min),
    maxPriceMinor: num(params.max),
    minRatingBp: num(params.rating),
    inStockOnly: one(params.stock) !== "any",
    sort: SORTS.includes(sort as BrowseSort) ? (sort as BrowseSort) : "relevance",
    page: num(params.page) || 1,
  };
}

export default async function BrowsePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireCustomer();
  const params = await searchParams;
  const query = parseQuery(params);

  // What someone searched and filtered for is the "looks for" half of their
  // profile — the half that leaves no trace in an order. Only deliberate acts
  // are logged: an empty browse of page 1 says nothing about anybody.
  if (query.q) await recordSearch(user.id, query.q, query.categories);
  else if (query.categories?.length || query.brands?.length) {
    await recordFilter(user.id, {
      category: query.categories?.[0],
      brand: query.brands?.[0],
      maxPriceMinor: query.maxPriceMinor,
    });
  }

  const [result, merchants] = await Promise.all([browseCatalog(query), browseMerchants()]);

  const pageHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of many(value)) next.append(key, v);
    }
    next.set("page", String(page));
    return `/browse?${next.toString()}`;
  };

  const first = (result.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(result.page * PAGE_SIZE, result.total);

  return (
    <div>
      <PageHeader
        title="Browse products"
        description="The whole catalogue, from every merchant. Search it, filter it by price, category, brand or rating, and sort it however you like — no agent involved."
      />

      <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
        <BrowseFilters result={result} merchants={merchants} />

        <div className="min-w-0 space-y-4">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {result.total === 0 ? (
              "No products match"
            ) : (
              <>
                Showing <span className="tabular font-medium text-foreground">{first}–{last}</span> of{" "}
                <span className="tabular font-medium text-foreground">{result.total}</span> products
                {query.q ? <> for “{query.q}”</> : null}
              </>
            )}
          </p>
          <BrowseGrid result={result} href={pageHref} />
        </div>
      </div>
    </div>
  );
}

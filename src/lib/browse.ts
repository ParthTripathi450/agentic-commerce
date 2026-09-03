/**
 * Browse's shared vocabulary — types and constants only, NO database import.
 *
 * The filter rail is a client component and needs the sort list and the result
 * shape. Importing those from `server/catalog/browse.ts` would drag `db` — and
 * with it the `postgres` driver's `net`/`tls` imports — into the browser
 * bundle, which fails the build outright (`Module not found: Can't resolve
 * 'net'`). Same rule as pure logic in a `"use server"` file: what both sides
 * share lives in a module that imports neither side's machinery.
 */

export type BrowseSort =
  | "relevance"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "popular"
  | "newest";

export const BROWSE_SORTS: { value: BrowseSort; label: string }[] = [
  { value: "relevance", label: "Best match" },
  { value: "popular", label: "Most popular" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Highest rated" },
  { value: "newest", label: "Newest" },
];

export const PAGE_SIZE = 24;

export type BrowseQuery = {
  q?: string;
  categories?: string[];
  brands?: string[];
  merchant?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  /** Minimum star rating, in basis points (4000 = 4★ and up). */
  minRatingBp?: number;
  inStockOnly?: boolean;
  sort?: BrowseSort;
  page?: number;
};

export type BrowseItem = {
  productId: string;
  variantId: string;
  title: string;
  brand: string | null;
  category: string;
  merchantName: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  currency: string;
  imageUrl: string | null;
  ratingBp: number | null;
  ratingCount: number;
  inStock: boolean;
};

export type FacetCount = { value: string; count: number };

export type PriceBand = { minMinor: number; maxMinor: number | null; count: number };

export type BrowseResult = {
  items: BrowseItem[];
  total: number;
  page: number;
  pageCount: number;
  categories: FacetCount[];
  brands: FacetCount[];
  /** Quartile bands of the price distribution the CURRENT filters produce. */
  priceBands: PriceBand[];
  priceRange: { minMinor: number; maxMinor: number } | null;
};

import { describe, expect, it } from "vitest";
import { resolveVariant } from "./refine";
import type { ProductDetail, ProductVariantView } from "@/server/catalog/product-page";

/**
 * Refining one product.
 *
 * The property that matters: the answer can only ever be a variant that
 * exists, and a request that cannot be met is REFUSED with the real options
 * rather than quietly answered with the nearest thing.
 */

const v = (
  id: string,
  color: string,
  size: string,
  priceMinor: number,
  availableQuantity = 5,
): ProductVariantView => ({
  variantId: id,
  sku: id.toUpperCase(),
  attributes: { color, size },
  priceMinor,
  compareAtPriceMinor: null,
  currency: "INR",
  availableQuantity,
  imageUrl: null,
});

const product = {
  productId: "p1",
  title: "Velocity Run 3",
  variants: [
    v("a", "black", "9", 429900),
    v("b", "black", "10", 429900),
    v("c", "navy", "10", 399900),
    v("d", "navy", "11", 449900, 0),
    v("e", "white", "10", 379900),
  ],
} as unknown as ProductDetail;

const current = product.variants.find((x) => x.variantId === "b");

describe("resolveVariant", () => {
  it("changes colour and keeps the size they did not mention", () => {
    const { variant } = resolveVariant(product, current, {
      color: "navy", size: null, wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("c");
    expect(variant?.attributes.size).toBe("10");
  });

  it("changes size and keeps the colour", () => {
    const { variant } = resolveVariant(product, current, {
      color: null, size: "9", wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("a");
    expect(variant?.attributes.color).toBe("black");
  });

  it("prefers something in stock over something that is not", () => {
    // navy/11 exists but has none left; asking for navy should not land there.
    const { variant } = resolveVariant(product, undefined, {
      color: "navy", size: null, wantsCheapest: false,
    });
    expect(variant?.availableQuantity).toBeGreaterThan(0);
  });

  it("finds the cheapest when asked, rather than the first match", () => {
    const { variant } = resolveVariant(product, undefined, {
      color: null, size: "10", wantsCheapest: true,
    });
    expect(variant?.variantId).toBe("e");
    expect(variant?.priceMinor).toBe(379900);
  });

  it("refuses a colour the product does not come in, and names it", () => {
    const { variant, missing } = resolveVariant(product, current, {
      color: "purple", size: null, wantsCheapest: false,
    });
    expect(variant).toBeNull();
    expect(missing).toBe("colour purple");
  });

  it("refuses a size that does not exist, and names it", () => {
    const { missing } = resolveVariant(product, current, {
      color: null, size: "15", wantsCheapest: false,
    });
    expect(missing).toBe("size 15");
  });

  it("names the COMBINATION when both halves exist but not together", () => {
    // white and 9 both exist; white in a 9 does not.
    const { variant, missing } = resolveVariant(product, undefined, {
      color: "white", size: "9", wantsCheapest: false,
    });
    expect(variant).toBeNull();
    expect(missing).toBe("white in size 9");
  });

  it("is case-insensitive about how the shopper typed it", () => {
    const { variant } = resolveVariant(product, current, {
      color: "NAVY", size: null, wantsCheapest: false,
    });
    expect(variant?.attributes.color).toBe("navy");
  });

  it("keeps the current variant when nothing was asked to change", () => {
    const { variant } = resolveVariant(product, current, {
      color: null, size: null, wantsCheapest: false,
    });
    expect(variant?.variantId).toBe("b");
  });
});

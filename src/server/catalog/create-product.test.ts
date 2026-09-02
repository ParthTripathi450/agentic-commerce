import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { inventory, merchants, productVariants, products } from "@/db/schema";
import { parseAttributeLines, toStringMap } from "./attributes";
import {
  comboKey,
  createProductWithVariants,
  deriveSearchTags,
  validateVariants,
  type NewVariant,
} from "./create-product";

/**
 * The single product writer.
 *
 * These exist because the manual form and the assisted wizard had drifted three
 * ways while both claiming to "create a product". The rules now live in one
 * place, so they are asserted in one place.
 */

const variant = (attrs: Record<string, string>, over: Partial<NewVariant> = {}): NewVariant => ({
  attributes: attrs,
  priceMinor: 499_900,
  quantity: 5,
  ...over,
});

describe("validateVariants", () => {
  it("refuses a product with no variant", () => {
    // No variant means no price and no stock: complete-looking, unbuyable.
    const result = validateVariants([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one variant/i);
  });

  it("refuses two variants with the same options", () => {
    const result = validateVariants([variant({ size: "10" }), variant({ size: "10" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/same options/i);
  });

  it("treats option order as irrelevant when detecting duplicates", () => {
    const result = validateVariants([
      variant({ size: "10", color: "black" }),
      variant({ color: "Black", size: "10" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("refuses a zero or negative price", () => {
    expect(validateVariants([variant({ size: "10" }, { priceMinor: 0 })]).ok).toBe(false);
    expect(validateVariants([variant({ size: "10" }, { priceMinor: -1 })]).ok).toBe(false);
  });

  it("allows zero stock but not fractional or negative stock", () => {
    expect(validateVariants([variant({ size: "10" }, { quantity: 0 })]).ok).toBe(true);
    expect(validateVariants([variant({ size: "10" }, { quantity: -1 })]).ok).toBe(false);
    expect(validateVariants([variant({ size: "10" }, { quantity: 1.5 })]).ok).toBe(false);
  });

  it("bounds the batch for every caller, not just the wizard", () => {
    const many = Array.from({ length: 25 }, (_, i) => variant({ size: String(i) }));
    const result = validateVariants(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/25 variants/);
  });
});

describe("comboKey", () => {
  it("is order- and case-independent", () => {
    expect(comboKey({ a: "X", b: "y" })).toBe(comboKey({ b: "Y", a: "x" }));
  });
  it("separates genuinely different option sets", () => {
    expect(comboKey({ size: "10" })).not.toBe(comboKey({ size: "11" }));
  });
});

describe("deriveSearchTags", () => {
  it("gives the manual form the tags it never used to write", () => {
    const tags = deriveSearchTags({
      title: "Stride Velocity Run 3",
      brand: "Stride",
      category: "Running Shoes",
    });
    expect(tags).toContain("running shoes");
    expect(tags).toContain("velocity run 3");
  });

  it("excludes the bare brand, which matches everything the merchant sells", () => {
    const tags = deriveSearchTags({
      title: "Stride Velocity Run 3",
      brand: "Stride",
      category: "Running Shoes",
    });
    expect(tags).not.toContain("stride");
  });

  it("survives a brand containing regex metacharacters", () => {
    const tags = deriveSearchTags({
      title: "Dr. Martens 1460 Boot",
      brand: "Dr. Martens",
      category: "Boots",
    });
    expect(tags).toContain("boots");
    expect(tags.join(" ")).not.toMatch(/Lower-cased/);
  });

  it("drops stopwords and very short fragments", () => {
    const tags = deriveSearchTags({ title: "The Pack of Wool Socks", brand: null, category: "Socks" });
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("of");
  });
});

describe("parseAttributeLines", () => {
  it("coerces types agents filter on", () => {
    const parsed = parseAttributeLines("Water Resistant: true\nWeight: 250\nColors: red, blue");
    expect(parsed.waterResistant).toBe(true);
    expect(parsed.weight).toBe(250);
    expect(parsed.colors).toEqual(["red", "blue"]);
  });

  it("ignores lines with no separator or no value", () => {
    expect(parseAttributeLines("nonsense\nkey:")).toEqual({});
  });

  it("stringifies variant attribute maps", () => {
    expect(toStringMap({ size: 10, wide: true })).toEqual({ size: "10", wide: "true" });
  });
});

// --- integration: the writer actually writes ------------------------------

const createdProductIds: string[] = [];

afterAll(async () => {
  if (createdProductIds.length === 0) return;
  // order_items reference variants, but these test products were never ordered.
  const variantRows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(inArray(productVariants.productId, createdProductIds));
  const variantIds = variantRows.map((v) => v.id);
  if (variantIds.length) {
    await db.delete(inventory).where(inArray(inventory.variantId, variantIds));
    await db.delete(productVariants).where(inArray(productVariants.id, variantIds));
  }
  await db.delete(products).where(inArray(products.id, createdProductIds));
});

describe("createProductWithVariants", () => {
  it("writes product, every variant and matching inventory, with tags set", async () => {
    const [merchant] = await db.select().from(merchants).limit(1);
    const title = `Test Consolidated ${Date.now()}`;

    const result = await createProductWithVariants({
      merchantId: merchant.id,
      merchantSlug: merchant.slug,
      title,
      description: "Created by the shared writer.",
      brand: "Testbrand",
      category: "Running Shoes",
      attributes: { material: "mesh" },
      searchTags: deriveSearchTags({ title, brand: "Testbrand", category: "Running Shoes" }),
      status: "draft",
      variants: [
        variant({ size: "10", color: "black" }, { quantity: 3 }),
        variant({ size: "11", color: "black" }, { quantity: 7 }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdProductIds.push(result.productId);
    expect(result.variantCount).toBe(2);

    const [row] = await db.select().from(products).where(eq(products.id, result.productId));
    // The whole point of consolidating: the manual path used to write none.
    expect(row.searchTags.length).toBeGreaterThan(0);

    const variants = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, result.productId));
    expect(variants).toHaveLength(2);

    const stock = await db
      .select()
      .from(inventory)
      .where(inArray(inventory.variantId, variants.map((v) => v.id)));
    expect(stock.map((s) => s.quantity).sort()).toEqual([3, 7]);
  });

  it("gives colliding option names distinct SKUs", async () => {
    // slugFragment truncates to 4 chars, so "Large" and "Larger" both -> "LARG".
    // Generated concurrently these collided and violated variants_sku_idx.
    const [merchant] = await db.select().from(merchants).limit(1);
    const title = `Test Collide ${Date.now()}`;

    const result = await createProductWithVariants({
      merchantId: merchant.id,
      merchantSlug: merchant.slug,
      title,
      description: "",
      brand: null,
      category: "Running Shoes",
      attributes: {},
      searchTags: ["test"],
      status: "draft",
      variants: [variant({ size: "Large" }), variant({ size: "Larger" })],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdProductIds.push(result.productId);

    const variants = await db
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(eq(productVariants.productId, result.productId));
    expect(new Set(variants.map((v) => v.sku)).size).toBe(2);
  });

  it("writes nothing when the batch is invalid", async () => {
    const [merchant] = await db.select().from(merchants).limit(1);
    const [before] = await db.select({ n: products.id }).from(products).limit(1);

    const result = await createProductWithVariants({
      merchantId: merchant.id,
      merchantSlug: merchant.slug,
      title: "Test Should Not Exist",
      description: "",
      brand: null,
      category: "Running Shoes",
      attributes: {},
      searchTags: [],
      status: "draft",
      variants: [],
    });

    expect(result.ok).toBe(false);
    expect(before).toBeDefined();
    const orphan = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.title, "Test Should Not Exist"));
    expect(orphan).toHaveLength(0);
  });
});

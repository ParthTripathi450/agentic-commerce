import { createHash } from "node:crypto";
import { formatMoney } from "@/lib/money";

/**
 * Turns merchant-authored product data into the AI-readable catalog document.
 *
 * Merchants never write this text — it is derived, so an edit in the dashboard
 * automatically updates what agents can discover. The same normalised view
 * feeds the ACP product feed and the embedding.
 *
 * Deliberately EXCLUDES live stock levels. Embeddings describe what a product
 * *is*; whether it can be bought right now is answered by a live inventory
 * query at search time. Mixing the two would force a re-embed on every sale.
 */

export type NormalizerInput = {
  product: {
    id: string;
    title: string;
    description: string;
    brand: string | null;
    category: string;
    attributes: Record<string, unknown>;
    ratingBp: number | null;
    ratingCount: number;
    /** Merchant-owned search tags, weighted above the body in the index. */
    searchTags: string[];
  };
  merchant: { name: string; slug: string; description: string | null };
  policies: {
    returnWindowDays: number;
    returnsAccepted: boolean;
    standardDeliveryDays: number;
    warrantyText: string | null;
  } | null;
  variants: Array<{
    attributes: Record<string, string>;
    priceMinor: number;
    currency: string;
    active: boolean;
  }>;
};

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function humanizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Collapses variant attributes into the distinct options per axis. */
export function summariseAxes(
  variants: NormalizerInput["variants"],
): Record<string, string[]> {
  const axes: Record<string, Set<string>> = {};
  for (const v of variants) {
    for (const [k, val] of Object.entries(v.attributes)) {
      (axes[k] ??= new Set()).add(val);
    }
  }
  return Object.fromEntries(Object.entries(axes).map(([k, set]) => [k, [...set]]));
}

export function priceBand(variants: NormalizerInput["variants"]) {
  const active = variants.filter((v) => v.active);
  const prices = (active.length ? active : variants).map((v) => v.priceMinor);
  const currency = variants[0]?.currency ?? "INR";
  if (prices.length === 0) return { minMinor: 0, maxMinor: 0, currency };
  return { minMinor: Math.min(...prices), maxMinor: Math.max(...prices), currency };
}

export function buildAiText(input: NormalizerInput): string {
  const { product, merchant, policies, variants } = input;
  const lines: string[] = [];

  lines.push(
    `${product.title}${product.brand ? ` by ${product.brand}` : ""} — ${product.category}.`,
  );
  lines.push(`Sold by ${merchant.name}.`);
  lines.push(product.description.trim());

  const axes = summariseAxes(variants);
  const axisText = Object.entries(axes)
    .map(([k, values]) => `${humanizeKey(k)}: ${values.join(", ")}`)
    .join("; ");
  if (axisText) lines.push(`Available options — ${axisText}.`);

  const band = priceBand(variants);
  lines.push(
    band.minMinor === band.maxMinor
      ? `Price: ${formatMoney(band.minMinor, band.currency)}.`
      : `Price range: ${formatMoney(band.minMinor, band.currency)} to ${formatMoney(band.maxMinor, band.currency)}.`,
  );

  const attrText = Object.entries(product.attributes)
    .map(([k, v]) => {
      const value = humanizeValue(v);
      return value ? `${humanizeKey(k)}: ${value}` : null;
    })
    .filter(Boolean)
    .join("; ");
  if (attrText) lines.push(`Specifications — ${attrText}.`);

  // Tags join the embedded text too: phrases like "marathon training" carry
  // real semantic signal that the description may not spell out.
  if (product.searchTags.length > 0) {
    lines.push(`Also known for — ${product.searchTags.join(", ")}.`);
  }

  if (product.ratingBp && product.ratingCount > 0) {
    lines.push(
      `Rated ${(product.ratingBp / 1000).toFixed(1)} out of 5 from ${product.ratingCount} reviews.`,
    );
  }

  if (policies) {
    const policyBits = [
      `usually delivered in ${policies.standardDeliveryDays} days`,
      policies.returnsAccepted
        ? `${policies.returnWindowDays}-day returns`
        : "no returns accepted",
    ];
    if (policies.warrantyText) policyBits.push(policies.warrantyText.replace(/\.$/, ""));
    lines.push(`Merchant terms — ${policyBits.join("; ")}.`);
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Hash of everything that feeds `aiText`. Unchanged hash ⇒ skip re-embedding,
 * which keeps a full catalog re-index cheap.
 */
export function sourceHash(input: NormalizerInput): string {
  const material = {
    p: {
      t: input.product.title,
      d: input.product.description,
      b: input.product.brand,
      c: input.product.category,
      a: input.product.attributes,
      r: input.product.ratingBp,
      rc: input.product.ratingCount,
      tg: input.product.searchTags,
    },
    m: input.merchant,
    pol: input.policies,
    v: input.variants
      .map((v) => `${JSON.stringify(v.attributes)}:${v.priceMinor}:${v.active}`)
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

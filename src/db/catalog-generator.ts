import type { ProductTemplate } from "./seed-data";
import {
  ARCHETYPES, BRANDS, TIER_PRICE_FACTOR, TIER_QUALITY_SHIFT, QUALITY_LABELS,
  type Archetype, type Brand, type Material, type QualityKey, type QualityScores,
} from "./catalog-blueprints";

/**
 * Composes products from blueprints.
 *
 * The invariant this file exists to hold: **the description, the quality scores
 * and (later) the reviews are all derived from the same three facts** —
 * archetype, material, brand tier. Nothing is sampled independently, so a
 * waterproof boot cannot end up described as breathable, and no review can
 * praise a quality the scores say is poor.
 *
 * That coherence is what makes the corpus usable for retrieval. A dataset whose
 * prose and attributes disagree teaches a retriever nothing except noise.
 */

const MODEL_NAMES = [
  "Aero", "Vertex", "Cadence", "Summit", "Drift", "Ridge", "Pulse", "Harbour",
  "Meridian", "Fathom", "Lumen", "Terra", "Kestrel", "Anchor", "Quill", "Ember",
  "Nomad", "Slate", "Cirrus", "Bastion", "Halo", "Onyx", "Verge", "Willow",
];

export function clamp(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

/** archetype base + material shifts + brand tier, clamped to 1–5. */
export function composeQualities(
  archetype: Archetype,
  material: Material,
  tier: Brand["tier"],
): QualityScores {
  const out: QualityScores = {};
  const keys = new Set<QualityKey>([
    ...(Object.keys(archetype.base) as QualityKey[]),
    ...(Object.keys(material.shifts) as QualityKey[]),
  ]);

  for (const key of keys) {
    const base = archetype.base[key];
    // A material can only ADJUST a quality the archetype has an opinion about,
    // plus any it introduces itself. Otherwise "non-stick" leaks onto a shoe.
    if (base === undefined && material.shifts[key] === undefined) continue;
    const value = (base ?? 3) + (material.shifts[key] ?? 0) + TIER_QUALITY_SHIFT[tier];
    out[key] = clamp(value);
  }
  return out;
}

/** The two or three qualities worth leading with, strongest first. */
export function standoutQualities(qualities: QualityScores, min = 4): QualityKey[] {
  return (Object.entries(qualities) as [QualityKey, number][])
    .filter(([, v]) => v >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/** Qualities the shopper should be warned about, weakest first. */
export function weakQualities(qualities: QualityScores, max = 2): QualityKey[] {
  return (Object.entries(qualities) as [QualityKey, number][])
    .filter(([, v]) => v <= max)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
}

/**
 * Writes the description FROM the scores.
 *
 * Including the weaknesses is deliberate. A catalogue where every product is
 * good at everything gives retrieval nothing to separate on, and a shopper
 * asking for "breathable" would get waterproof boots back with equal
 * confidence.
 */
export function composeDescription(
  archetype: Archetype,
  material: Material,
  qualities: QualityScores,
): string {
  const strong = standoutQualities(qualities).slice(0, 3).map((k) => QUALITY_LABELS[k]);
  const weak = weakQualities(qualities).slice(0, 1).map((k) => QUALITY_LABELS[k]);

  const parts = [`Built for ${archetype.useCase}, with ${material.blurb}.`];

  if (strong.length === 1) parts.push(`It stands out on ${strong[0]}.`);
  else if (strong.length > 1) {
    parts.push(`Strongest on ${strong.slice(0, -1).join(", ")} and ${strong[strong.length - 1]}.`);
  }

  if (weak.length) {
    parts.push(
      `The trade-off is ${weak[0]} — ${material.name} is not the choice if that matters most to you.`,
    );
  }

  const specNote = Object.entries(archetype.specs ?? {})
    .slice(0, 3)
    .map(([k, v]) => `${humanise(k)} ${formatSpec(v)}`)
    .join(", ");
  if (specNote) parts.push(`Specifics: ${specNote}.`);

  return parts.join(" ");
}

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim().toLowerCase();
}

function formatSpec(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Tags from the archetype plus the qualities that actually scored well. */
export function composeTags(archetype: Archetype, qualities: QualityScores): string[] {
  const strong = standoutQualities(qualities).map((k) => QUALITY_LABELS[k]);
  return [...new Set([...archetype.tags, ...strong])].slice(0, 14);
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GeneratedProduct = ProductTemplate & {
  qualities: QualityScores;
  archetypeKey: string;
  materialName: string;
  tier: Brand["tier"];
};

/**
 * Every plausible archetype × brand × material combination.
 *
 * Deterministic: same seed, same catalogue, so a re-run does not silently
 * produce a different dataset than the one an eval set was built against.
 */
export function generateCatalogue(options: {
  merchantSlugs: string[];
  seed?: number;
  /** Stop once this many products exist. */
  limit?: number;
}): GeneratedProduct[] {
  const rand = mulberry32(options.seed ?? 20260903);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const byKey = new Map(ARCHETYPES.map((a) => [a.key, a]));
  const out: GeneratedProduct[] = [];
  let nameCursor = 0;

  for (const brand of BRANDS) {
    for (const archetypeKey of brand.makes) {
      const archetype = byKey.get(archetypeKey);
      if (!archetype) continue;

      for (const material of archetype.materials) {
        if (options.limit && out.length >= options.limit) return out;

        const qualities = composeQualities(archetype, material, brand.tier);
        const model = MODEL_NAMES[nameCursor++ % MODEL_NAMES.length];
        const title = `${brand.name} ${model} ${archetype.noun}`;

        const basePrice = Math.round(
          (archetype.basePriceMinor * material.priceFactor * TIER_PRICE_FACTOR[brand.tier]) / 100,
        ) * 100;

        // Two or three merchants each, so price comparison across sellers works.
        const merchants = [...new Set(
          Array.from({ length: randInt(1, 3) }, () => pick(options.merchantSlugs)),
        )];

        const colors = [...new Set(
          Array.from({ length: randInt(2, Math.min(4, archetype.colors.length)) }, () =>
            pick(archetype.colors),
          ),
        )];

        const axes = archetype.sizeAxis
          ? [{ name: "size", values: archetype.sizeAxis }, { name: "color", values: colors }]
          : [{ name: "color", values: colors }];

        out.push({
          key: `${brand.name}-${archetype.key}-${material.name}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-"),
          title,
          brand: brand.name,
          category: archetype.category,
          description: composeDescription(archetype, material, qualities),
          attributes: {
            ...archetype.specs,
            material: material.name,
            useCase: archetype.useCase,
            // The scores ride along in attributes, so buildAiText embeds them
            // and retrieval can match "breathable" to a number, not just prose.
            qualities,
          },
          basePriceMinor: basePrice,
          axes,
          merchants,
          demand: randInt(3, 14),
          qualities,
          archetypeKey: archetype.key,
          materialName: material.name,
          tier: brand.tier,
        });
      }
    }
  }

  return out;
}

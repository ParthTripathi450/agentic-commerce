/**
 * Blueprints for a coherent synthetic catalogue.
 *
 * The point of this file is CONSISTENCY, not volume. A dataset where a mesh
 * running shoe scores 5/5 on water resistance is worse than no dataset at all:
 * retrieval learns nothing from it, and a RAG answer built on it is wrong in a
 * way nobody can see.
 *
 * So qualities are never random. They come from an archetype (what the thing
 * IS) adjusted by a material (what it is MADE OF) and a brand tier (how well it
 * is made), and the description and reviews are written from those same three
 * facts — so prose, scores and opinions cannot disagree with each other.
 *
 * Brands are invented. Attaching fabricated durability scores to real
 * manufacturers would make this data misleading the moment it is screenshotted.
 */

/** 1–5, where 3 is unremarkable. Scored rather than boolean so ranking can use them. */
export type QualityKey =
  | "durability" | "comfort" | "breathability" | "waterResistance" | "grip"
  | "warmth" | "materialQuality" | "support" | "packability" | "easeOfCare"
  | "batteryLife" | "soundQuality" | "noiseIsolation" | "portability"
  | "capacity" | "heatRetention" | "sharpness" | "nonStick" | "absorbency"
  | "softness" | "brightness" | "stability";

export type QualityScores = Partial<Record<QualityKey, number>>;

/** Shopper-facing wording for each quality, used in descriptions and reviews. */
export const QUALITY_LABELS: Record<QualityKey, string> = {
  durability: "durability", comfort: "comfort", breathability: "breathability",
  waterResistance: "water resistance", grip: "grip", warmth: "warmth",
  materialQuality: "material quality", support: "support", packability: "packability",
  easeOfCare: "ease of care", batteryLife: "battery life", soundQuality: "sound quality",
  noiseIsolation: "noise isolation", portability: "portability", capacity: "capacity",
  heatRetention: "heat retention", sharpness: "sharpness", nonStick: "non-stick performance",
  absorbency: "absorbency", softness: "softness", brightness: "brightness",
  stability: "stability",
};

export type Material = {
  name: string;
  /** Added to the archetype's base scores, then clamped to 1–5. */
  shifts: QualityScores;
  priceFactor: number;
  /** Phrase dropped into the generated description. */
  blurb: string;
};

export type Archetype = {
  key: string;
  noun: string;
  category: string;
  useCase: string;
  base: QualityScores;
  basePriceMinor: number;
  materials: Material[];
  sizeAxis: string[] | null;
  colors: string[];
  specs?: Record<string, unknown>;
  tags: string[];
};

export type BrandTier = "budget" | "mid" | "premium";

export type Brand = {
  name: string;
  tier: BrandTier;
  /** Archetype keys this brand plausibly makes. */
  makes: string[];
};

const SHOE_SIZES = ["6", "7", "8", "9", "10", "11", "12"];
const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const WAIST = ["28", "30", "32", "34", "36", "38"];

// ---------------------------------------------------------------- materials

const MESH: Material = {
  name: "engineered mesh",
  shifts: { breathability: 2, waterResistance: -2, durability: -1 },
  priceFactor: 0.95,
  blurb: "an open engineered mesh upper that moves air freely",
};
const KNIT: Material = {
  name: "seamless knit",
  shifts: { breathability: 1, comfort: 1, durability: -1, waterResistance: -1 },
  priceFactor: 1.0,
  blurb: "a seamless knit upper that flexes with the foot",
};
const LEATHER: Material = {
  name: "full-grain leather",
  shifts: { durability: 2, materialQuality: 2, breathability: -1, waterResistance: 1 },
  priceFactor: 1.45,
  blurb: "full-grain leather that softens rather than cracks",
};
const SUEDE: Material = {
  name: "brushed suede",
  shifts: { materialQuality: 1, comfort: 1, waterResistance: -1, easeOfCare: -2 },
  priceFactor: 1.2,
  blurb: "brushed suede panels",
};
const MEMBRANE: Material = {
  name: "waterproof membrane",
  shifts: { waterResistance: 3, breathability: -2, durability: 1 },
  priceFactor: 1.5,
  blurb: "a fully taped waterproof membrane",
};
const CANVAS: Material = {
  name: "cotton canvas",
  shifts: { breathability: 1, durability: -1, waterResistance: -2, easeOfCare: 1 },
  priceFactor: 0.8,
  blurb: "heavy cotton canvas",
};
const RIPSTOP: Material = {
  name: "recycled ripstop nylon",
  shifts: { durability: 2, packability: 2, waterResistance: 1 },
  priceFactor: 1.1,
  blurb: "recycled ripstop nylon that resists tearing",
};
const MERINO: Material = {
  name: "merino wool",
  shifts: { warmth: 2, comfort: 2, breathability: 1, materialQuality: 2, easeOfCare: -1 },
  priceFactor: 1.6,
  blurb: "fine merino wool that stays fresh for days",
};
const COTTON: Material = {
  name: "combed cotton",
  shifts: { comfort: 2, breathability: 1, easeOfCare: 2, durability: -1 },
  priceFactor: 0.9,
  blurb: "soft combed cotton",
};
const POLY_TECH: Material = {
  name: "recycled technical polyester",
  shifts: { durability: 1, easeOfCare: 2, breathability: 1, comfort: -1 },
  priceFactor: 1.0,
  blurb: "quick-drying recycled polyester",
};
const DOWN: Material = {
  name: "700-fill down",
  shifts: { warmth: 3, packability: 2, materialQuality: 2, waterResistance: -1 },
  priceFactor: 1.7,
  blurb: "700-fill responsibly sourced down",
};
const FLEECE: Material = {
  name: "brushed fleece",
  shifts: { warmth: 2, comfort: 2, packability: -1, breathability: -1 },
  priceFactor: 0.95,
  blurb: "brushed-back fleece",
};
const STAINLESS: Material = {
  name: "18/10 stainless steel",
  shifts: { durability: 2, materialQuality: 2, heatRetention: 1, easeOfCare: 1 },
  priceFactor: 1.3,
  blurb: "18/10 stainless steel",
};
const CAST_IRON: Material = {
  name: "seasoned cast iron",
  shifts: { durability: 3, heatRetention: 3, easeOfCare: -2, portability: -2 },
  priceFactor: 1.15,
  blurb: "pre-seasoned cast iron",
};
const CERAMIC: Material = {
  name: "ceramic non-stick",
  shifts: { nonStick: 3, easeOfCare: 2, durability: -1 },
  priceFactor: 1.0,
  blurb: "a PFOA-free ceramic non-stick coating",
};
const ALUMINIUM: Material = {
  name: "anodised aluminium",
  shifts: { portability: 2, durability: 1, heatRetention: -1 },
  priceFactor: 0.95,
  blurb: "hard-anodised aluminium",
};
const BAMBOO: Material = {
  name: "bamboo viscose",
  shifts: { softness: 2, absorbency: 2, breathability: 1, durability: -1 },
  priceFactor: 1.2,
  blurb: "bamboo viscose",
};
const LONG_STAPLE: Material = {
  name: "long-staple cotton",
  shifts: { softness: 2, absorbency: 2, durability: 1, materialQuality: 2 },
  priceFactor: 1.4,
  blurb: "long-staple cotton woven at a high thread count",
};

export const ARCHETYPES: Archetype[] = [
  // ------------------------------------------------------------- footwear
  {
    key: "road-running", noun: "Road Running Shoes", category: "Running Shoes",
    useCase: "daily road running and treadmill miles",
    base: { comfort: 4, durability: 3, breathability: 3, grip: 3, support: 3, waterResistance: 2 },
    basePriceMinor: 549900, materials: [MESH, KNIT, MEMBRANE],
    sizeAxis: SHOE_SIZES, colors: ["black", "white", "blue", "grey", "coral"],
    specs: { dropMm: 8, closure: "lace-up", outsole: "carbon rubber" },
    tags: ["road running", "daily trainer", "cushioned"],
  },
  {
    key: "trail-running", noun: "Trail Running Shoes", category: "Trail Shoes",
    useCase: "loose trails, wet rock and technical descents",
    base: { grip: 5, durability: 4, support: 4, comfort: 3, breathability: 3, waterResistance: 2 },
    basePriceMinor: 799900, materials: [MESH, RIPSTOP, MEMBRANE],
    sizeAxis: SHOE_SIZES, colors: ["olive", "black", "orange", "slate"],
    specs: { lugDepthMm: 5, rockPlate: true, closure: "lace-up" },
    tags: ["trail running", "aggressive lugs", "off road"],
  },
  {
    key: "court-sneaker", noun: "Court Sneakers", category: "Sneakers",
    useCase: "everyday wear and casual court style",
    base: { comfort: 4, durability: 3, materialQuality: 3, breathability: 3, grip: 3 },
    basePriceMinor: 449900, materials: [LEATHER, CANVAS, SUEDE, KNIT],
    sizeAxis: SHOE_SIZES, colors: ["white", "black", "green", "navy", "cream"],
    specs: { sole: "vulcanised rubber", style: "low top" },
    tags: ["casual", "everyday", "retro court"],
  },
  {
    key: "hiking-boot", noun: "Hiking Boots", category: "Hiking Boots",
    useCase: "loaded packs over rough ground",
    base: { durability: 5, support: 5, grip: 4, waterResistance: 3, warmth: 3, comfort: 3, breathability: 2 },
    basePriceMinor: 999900, materials: [LEATHER, MEMBRANE, RIPSTOP],
    sizeAxis: SHOE_SIZES, colors: ["brown", "grey", "black"],
    specs: { cut: "mid", shank: "nylon", lugDepthMm: 5 },
    tags: ["hiking", "backpacking", "ankle support"],
  },
  {
    key: "formal-shoe", noun: "Leather Dress Shoes", category: "Formal Shoes",
    useCase: "offices, weddings and anything with a dress code",
    base: { materialQuality: 5, durability: 4, comfort: 3, breathability: 2, grip: 2, waterResistance: 2 },
    basePriceMinor: 1149900, materials: [LEATHER, SUEDE],
    sizeAxis: SHOE_SIZES, colors: ["black", "brown", "oxblood", "tan"],
    specs: { construction: "Goodyear welt", sole: "leather", resoleable: true },
    tags: ["formal", "office", "resoleable"],
  },
  {
    key: "training-shoe", noun: "Cross Training Shoes", category: "Training Shoes",
    useCase: "lifting, circuits and gym floors",
    base: { stability: 5, durability: 4, grip: 4, support: 4, comfort: 3, breathability: 3 },
    basePriceMinor: 529900, materials: [MESH, RIPSTOP, KNIT],
    sizeAxis: SHOE_SIZES, colors: ["black", "white", "lime", "grey"],
    specs: { dropMm: 4, sole: "flat stable", ropeGuard: true },
    tags: ["gym", "lifting", "cross training"],
  },
  {
    key: "court-sport-shoe", noun: "Court Sport Shoes", category: "Court Shoes",
    useCase: "tennis, badminton and indoor court sports",
    base: { grip: 5, support: 4, stability: 4, durability: 4, comfort: 3, breathability: 3 },
    basePriceMinor: 619900, materials: [MESH, KNIT, LEATHER],
    sizeAxis: SHOE_SIZES, colors: ["white", "navy", "black", "yellow"],
    specs: { sole: "non-marking gum", lateralSupport: "reinforced" },
    tags: ["tennis", "badminton", "squash", "indoor court", "lateral support"],
  },
  {
    key: "walking-shoe", noun: "Walking Shoes", category: "Walking Shoes",
    useCase: "long days on your feet and city walking",
    base: { comfort: 5, support: 4, durability: 3, breathability: 3, grip: 3 },
    basePriceMinor: 469900, materials: [LEATHER, MESH, MEMBRANE, KNIT],
    sizeAxis: SHOE_SIZES, colors: ["black", "grey", "navy", "taupe"],
    specs: { insole: "removable orthotic friendly" },
    tags: ["walking", "all day comfort", "orthotic friendly"],
  },

  // ------------------------------------------------------------- apparel
  {
    key: "tee", noun: "T-Shirt", category: "T-Shirts",
    useCase: "everyday layering",
    base: { comfort: 4, breathability: 4, easeOfCare: 4, durability: 3, materialQuality: 3 },
    basePriceMinor: 119900, materials: [COTTON, MERINO, POLY_TECH],
    sizeAxis: APPAREL_SIZES, colors: ["white", "black", "navy", "sage", "ecru", "rust"],
    specs: { fit: "regular", neckline: "crew" },
    tags: ["everyday", "layering", "basics"],
  },
  {
    key: "hoodie", noun: "Hoodie", category: "Hoodies",
    useCase: "cool mornings and weekends",
    base: { warmth: 4, comfort: 5, easeOfCare: 3, durability: 3, breathability: 2 },
    basePriceMinor: 329900, materials: [FLEECE, COTTON, MERINO],
    sizeAxis: APPAREL_SIZES, colors: ["grey", "black", "forest", "burgundy", "oatmeal"],
    specs: { hood: "double layer", pocket: "kangaroo" },
    tags: ["casual", "warm", "weekend"],
  },
  {
    key: "rain-jacket", noun: "Rain Jacket", category: "Jackets",
    useCase: "sustained rain and wind",
    base: { waterResistance: 5, packability: 4, durability: 4, breathability: 2, warmth: 2 },
    basePriceMinor: 999900, materials: [MEMBRANE, RIPSTOP],
    sizeAxis: APPAREL_SIZES, colors: ["black", "orange", "moss", "navy"],
    specs: { seams: "fully taped", hood: "adjustable", pitZips: true },
    tags: ["waterproof", "rain", "shell"],
  },
  {
    key: "insulated-jacket", noun: "Insulated Jacket", category: "Jackets",
    useCase: "cold, dry days and as a mid-layer",
    base: { warmth: 5, packability: 4, comfort: 4, materialQuality: 4, waterResistance: 2, breathability: 2 },
    basePriceMinor: 1249900, materials: [DOWN, FLEECE, RIPSTOP],
    sizeAxis: APPAREL_SIZES, colors: ["black", "navy", "rust", "olive"],
    specs: { baffles: "box wall", packsIntoPocket: true },
    tags: ["insulated", "winter", "packable"],
  },
  {
    key: "base-layer", noun: "Base Layer Top", category: "Base Layers",
    useCase: "next-to-skin warmth under everything else",
    base: { warmth: 4, breathability: 4, comfort: 4, materialQuality: 4, packability: 4, easeOfCare: 2 },
    basePriceMinor: 449900, materials: [MERINO, POLY_TECH],
    sizeAxis: APPAREL_SIZES, colors: ["charcoal", "navy", "moss", "black"],
    specs: { seams: "flatlock", fit: "slim" },
    tags: ["base layer", "thermal", "odour resistant"],
  },
  {
    key: "chino", noun: "Chino Trousers", category: "Trousers",
    useCase: "smart-casual most days of the week",
    base: { comfort: 4, durability: 3, easeOfCare: 4, materialQuality: 3, breathability: 3 },
    basePriceMinor: 309900, materials: [COTTON, POLY_TECH],
    sizeAxis: WAIST, colors: ["stone", "navy", "olive", "black"],
    specs: { fit: "tapered", stretch: "2% elastane" },
    tags: ["smart casual", "office", "stretch"],
  },
  {
    key: "activewear-short", noun: "Training Shorts", category: "Activewear",
    useCase: "running and gym sessions",
    base: { breathability: 5, comfort: 4, easeOfCare: 4, packability: 4, durability: 3 },
    basePriceMinor: 169900, materials: [POLY_TECH, KNIT],
    sizeAxis: ["S", "M", "L", "XL"], colors: ["black", "navy", "coral", "grey"],
    specs: { liner: "built-in", pocket: "zip side" },
    tags: ["running", "gym", "quick drying"],
  },

  // --------------------------------------------------------------- audio
  {
    key: "over-ear-headphones", noun: "Over-Ear Headphones", category: "Headphones",
    useCase: "commutes, flights and focused work",
    base: { soundQuality: 4, noiseIsolation: 5, batteryLife: 5, comfort: 4, portability: 2, durability: 3 },
    basePriceMinor: 1299900,
    materials: [
      { name: "memory foam and vegan leather", shifts: { comfort: 1, materialQuality: 1 }, priceFactor: 1.0, blurb: "memory-foam earcups" },
      { name: "aluminium and lambskin", shifts: { materialQuality: 2, durability: 1 }, priceFactor: 1.5, blurb: "machined aluminium arms and lambskin pads" },
    ],
    sizeAxis: null, colors: ["black", "sand", "midnight"],
    specs: { driverMm: 40, bluetooth: "5.3", anc: true, batteryHours: 40 },
    tags: ["noise cancelling", "wireless", "long battery"],
  },
  {
    key: "earbuds", noun: "Wireless Earbuds", category: "Earbuds",
    useCase: "workouts and everyday listening",
    base: { portability: 5, soundQuality: 3, noiseIsolation: 3, batteryLife: 3, comfort: 3, waterResistance: 3 },
    basePriceMinor: 549900,
    materials: [
      { name: "silicone tips", shifts: { comfort: 1, noiseIsolation: 1 }, priceFactor: 1.0, blurb: "three silicone tip sizes" },
      { name: "sport fins", shifts: { comfort: 1, waterResistance: 1 }, priceFactor: 1.1, blurb: "locking sport fins" },
    ],
    sizeAxis: null, colors: ["white", "black", "sage"],
    specs: { ipRating: "IPX5", batteryHours: 8, caseCharges: 3 },
    tags: ["wireless", "sweatproof", "compact"],
  },
  {
    key: "speaker", noun: "Portable Speaker", category: "Speakers",
    useCase: "kitchens, gardens and camping",
    base: { soundQuality: 4, portability: 4, batteryLife: 4, waterResistance: 4, durability: 4 },
    basePriceMinor: 749900,
    materials: [
      { name: "rubberised shell", shifts: { durability: 1, waterResistance: 1 }, priceFactor: 1.0, blurb: "a rubberised drop-resistant shell" },
      { name: "woven fabric", shifts: { materialQuality: 1, waterResistance: -1 }, priceFactor: 1.1, blurb: "an acoustically transparent woven grille" },
    ],
    sizeAxis: null, colors: ["charcoal", "teal", "sand"],
    specs: { ipRating: "IP67", batteryHours: 20, stereoPair: true },
    tags: ["bluetooth", "waterproof", "outdoor"],
  },

  // ---------------------------------------------------------- bags & carry
  {
    key: "daypack", noun: "Daypack", category: "Backpacks",
    useCase: "commuting and day hikes",
    base: { capacity: 4, durability: 4, comfort: 4, waterResistance: 3, packability: 3, support: 3 },
    basePriceMinor: 549900, materials: [RIPSTOP, CANVAS, MEMBRANE],
    sizeAxis: null, colors: ["black", "olive", "navy", "sand"],
    specs: { litres: 22, laptopSleeve: "15 inch", sternumStrap: true },
    tags: ["commuting", "laptop", "day hike"],
  },
  {
    key: "duffel", noun: "Duffel Bag", category: "Luggage",
    useCase: "weekends away and gym kit",
    base: { capacity: 5, durability: 4, packability: 3, waterResistance: 3, portability: 3 },
    basePriceMinor: 699900, materials: [RIPSTOP, CANVAS, LEATHER],
    sizeAxis: null, colors: ["black", "olive", "brown"],
    specs: { litres: 40, shoulderStrap: "removable", baseReinforced: true },
    tags: ["weekend", "gym bag", "travel"],
  },

  // ------------------------------------------------------------- kitchen
  {
    key: "frying-pan", noun: "Frying Pan", category: "Cookware",
    useCase: "everyday searing and frying",
    base: { heatRetention: 3, durability: 3, easeOfCare: 3, materialQuality: 3, nonStick: 2, portability: 3 },
    basePriceMinor: 379900, materials: [CAST_IRON, STAINLESS, CERAMIC, ALUMINIUM],
    sizeAxis: ["20cm", "24cm", "28cm"], colors: ["natural"],
    specs: { ovenSafeC: 240, inductionReady: true },
    tags: ["cookware", "frying", "induction"],
  },
  {
    key: "chef-knife", noun: "Chef's Knife", category: "Kitchen Knives",
    useCase: "the knife you reach for every day",
    base: { sharpness: 4, durability: 4, materialQuality: 4, easeOfCare: 3 },
    basePriceMinor: 549900,
    materials: [
      { name: "high-carbon stainless", shifts: { sharpness: 1, durability: 1, easeOfCare: 1 }, priceFactor: 1.0, blurb: "high-carbon stainless steel" },
      { name: "Damascus-clad core", shifts: { sharpness: 1, materialQuality: 2, easeOfCare: -1 }, priceFactor: 1.8, blurb: "a Damascus-clad hardened core" },
    ],
    sizeAxis: ["16cm", "20cm", "24cm"], colors: ["walnut", "black"],
    specs: { hardnessHrc: 60, tang: "full" },
    tags: ["chef knife", "sharp", "kitchen"],
  },
  {
    key: "vacuum-flask", noun: "Vacuum Flask", category: "Drinkware",
    useCase: "keeping drinks hot on a commute or a hill",
    base: { heatRetention: 5, durability: 4, portability: 4, easeOfCare: 3, materialQuality: 4 },
    basePriceMinor: 219900, materials: [STAINLESS, ALUMINIUM],
    sizeAxis: ["350ml", "500ml", "750ml", "1L"], colors: ["steel", "black", "forest", "sand"],
    specs: { hoursHot: 12, hoursCold: 24, lid: "leakproof" },
    tags: ["insulated", "leakproof", "commute"],
  },

  // -------------------------------------------------------- home textiles
  {
    key: "towel-set", noun: "Bath Towel Set", category: "Bath Linen",
    useCase: "everyday bathrooms",
    base: { absorbency: 4, softness: 4, durability: 3, easeOfCare: 4, materialQuality: 3 },
    basePriceMinor: 249900, materials: [LONG_STAPLE, BAMBOO, COTTON],
    sizeAxis: null, colors: ["white", "grey", "sage", "clay"],
    specs: { gsm: 600, pieces: 4 },
    tags: ["towels", "absorbent", "quick drying"],
  },
  {
    key: "duvet-cover", noun: "Duvet Cover Set", category: "Bedding",
    useCase: "year-round bedding",
    base: { softness: 4, breathability: 4, durability: 3, easeOfCare: 3, materialQuality: 4 },
    basePriceMinor: 449900, materials: [LONG_STAPLE, BAMBOO, COTTON],
    sizeAxis: ["Single", "Double", "King"], colors: ["white", "charcoal", "sage", "blush"],
    specs: { threadCount: 400, weave: "percale" },
    tags: ["bedding", "breathable", "cotton"],
  },

  // -------------------------------------------------------------- fitness
  {
    key: "yoga-mat", noun: "Yoga Mat", category: "Fitness Accessories",
    useCase: "yoga, pilates and floor work",
    base: { grip: 4, comfort: 4, durability: 3, portability: 3, easeOfCare: 4 },
    basePriceMinor: 249900,
    materials: [
      { name: "natural rubber", shifts: { grip: 2, durability: 1, portability: -1 }, priceFactor: 1.3, blurb: "dense natural rubber" },
      { name: "TPE foam", shifts: { portability: 2, comfort: 1, durability: -1 }, priceFactor: 0.85, blurb: "lightweight closed-cell TPE" },
    ],
    sizeAxis: ["4mm", "6mm"], colors: ["charcoal", "sage", "terracotta", "indigo"],
    specs: { lengthCm: 183, alignmentMarks: true },
    tags: ["yoga", "non slip", "pilates"],
  },
  {
    key: "resistance-bands", noun: "Resistance Band Set", category: "Fitness Accessories",
    useCase: "home strength work and rehab",
    base: { durability: 4, portability: 5, easeOfCare: 4 },
    basePriceMinor: 149900,
    materials: [
      { name: "layered latex", shifts: { durability: 1 }, priceFactor: 1.0, blurb: "layered natural latex" },
      { name: "fabric-wrapped", shifts: { comfort: 2, durability: 1 }, priceFactor: 1.35, blurb: "a fabric outer that will not roll or pinch" },
    ],
    sizeAxis: null, colors: ["mixed"],
    specs: { pieces: 5, resistanceKg: "5-35" },
    tags: ["home gym", "rehab", "portable"],
  },

  // -------------------------------------------------------------- outdoor
  {
    key: "headlamp", noun: "Headlamp", category: "Outdoor Gear",
    useCase: "night runs, camping and power cuts",
    base: { brightness: 4, batteryLife: 4, waterResistance: 4, portability: 5, durability: 3 },
    basePriceMinor: 299900,
    materials: [
      { name: "polycarbonate", shifts: { portability: 1, durability: -1 }, priceFactor: 0.9, blurb: "a light polycarbonate housing" },
      { name: "reinforced composite", shifts: { durability: 2, waterResistance: 1 }, priceFactor: 1.25, blurb: "a reinforced composite housing" },
    ],
    sizeAxis: null, colors: ["black", "red", "yellow"],
    specs: { lumens: 400, ipRating: "IPX7", rechargeable: true },
    tags: ["camping", "running", "rechargeable"],
  },
  {
    key: "sleeping-bag", noun: "Sleeping Bag", category: "Outdoor Gear",
    useCase: "three-season camping",
    base: { warmth: 4, packability: 4, comfort: 4, durability: 3, waterResistance: 2 },
    basePriceMinor: 849900, materials: [DOWN, POLY_TECH, RIPSTOP],
    sizeAxis: ["Regular", "Long"], colors: ["moss", "slate", "rust"],
    specs: { comfortC: 0, shape: "mummy" },
    tags: ["camping", "three season", "packable"],
  },
];

/** Invented brands, positioned so price and quality move together. */
export const BRANDS: Brand[] = [
  { name: "Arcus", tier: "premium", makes: ["road-running", "trail-running", "training-shoe", "court-sport-shoe"] },
  { name: "Vantor", tier: "budget", makes: ["road-running", "court-sneaker", "walking-shoe", "tee", "chino", "activewear-short"] },
  { name: "Nimbra", tier: "mid", makes: ["road-running", "walking-shoe", "court-sport-shoe", "training-shoe"] },
  { name: "Torvi", tier: "mid", makes: ["trail-running", "hiking-boot", "daypack", "sleeping-bag", "headlamp"] },
  { name: "Cobbleworks", tier: "premium", makes: ["formal-shoe", "court-sneaker", "duffel"] },
  { name: "Solene", tier: "mid", makes: ["court-sneaker", "tee", "hoodie", "duvet-cover", "towel-set"] },
  { name: "Loom", tier: "mid", makes: ["tee", "hoodie", "chino", "base-layer", "towel-set", "duvet-cover"] },
  { name: "Northwind", tier: "premium", makes: ["rain-jacket", "insulated-jacket", "base-layer", "sleeping-bag", "daypack", "hiking-boot"] },
  { name: "Atelier", tier: "premium", makes: ["formal-shoe", "chino", "duvet-cover"] },
  { name: "Voltix", tier: "mid", makes: ["over-ear-headphones", "earbuds", "speaker", "headlamp"] },
  { name: "Kova", tier: "budget", makes: ["earbuds", "speaker", "resistance-bands", "yoga-mat", "vacuum-flask"] },
  { name: "Hearth", tier: "mid", makes: ["frying-pan", "chef-knife", "vacuum-flask", "towel-set"] },
  { name: "Verde", tier: "mid", makes: ["yoga-mat", "resistance-bands", "vacuum-flask", "duffel"] },
  { name: "Peak", tier: "premium", makes: ["hiking-boot", "trail-running", "rain-jacket", "headlamp", "sleeping-bag"] },
];

export const TIER_PRICE_FACTOR: Record<BrandTier, number> = {
  budget: 0.62, mid: 1.0, premium: 1.55,
};

/** Premium brands genuinely use better materials; budget ones cut corners. */
export const TIER_QUALITY_SHIFT: Record<BrandTier, number> = {
  budget: -1, mid: 0, premium: 1,
};

/** Merchants that stock the generated catalogue, beyond those already seeded. */
export const GENERATED_MERCHANTS = [
  "fleetfoot-running", "sole-republic", "oxford-and-last", "shoe-locker",
  "field-and-court", "loom-and-thread", "northwind-outdoor", "atelier-nine",
  "stride-athletics", "peak-gear", "urban-outfit-co", "budget-bazaar",
  "voltix-electronics", "hearth-and-home", "verde-living", "cook-and-co",
];

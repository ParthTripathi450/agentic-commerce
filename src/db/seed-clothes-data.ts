import type { MerchantSeed, ProductTemplate } from "./seed-data";

/**
 * Apparel depth, to match the footwear catalogue.
 *
 * Clothing is what shoes are most often bought with, so this is also what makes
 * the "goes with what you added" recommendations meaningful — co-purchase needs
 * something on the other side of the pair.
 *
 * Brands are invented, matching the rest of the seed.
 */

const APPAREL = ["XS", "S", "M", "L", "XL", "XXL"];
const CORE = ["S", "M", "L", "XL"];
const WAIST = ["28", "30", "32", "34", "36", "38"];

export const CLOTHES_MERCHANTS: MerchantSeed[] = [
  {
    slug: "loom-and-thread",
    name: "Loom & Thread",
    description: "Everyday cotton basics, cut generously and washed soft before they ship.",
    supportEmail: "hello@loomandthread.test",
    priceIndex: 1.02,
    fulfillmentRateBp: 9600,
    avgDispatchHours: 22,
    policies: {
      returnWindowDays: 30,
      returnsAccepted: true,
      returnPolicyText: "30-day returns, worn or unworn — sizing is hard to get right online.",
      shippingPolicyText: "Dispatched within a day, plastic-free packaging.",
      freeShippingAboveMinor: 150000,
      flatShippingMinor: 5900,
      standardDeliveryDays: 3,
      warrantyText: "Seams guaranteed for a year.",
      cancellationText: "Cancel free before dispatch.",
    },
  },
  {
    slug: "northwind-outdoor",
    name: "Northwind Outdoor",
    description: "Technical layers for weather that does not cooperate. Tested on actual hills.",
    supportEmail: "care@northwind.test",
    priceIndex: 1.16,
    fulfillmentRateBp: 9700,
    avgDispatchHours: 26,
    policies: {
      returnWindowDays: 21,
      returnsAccepted: true,
      returnPolicyText: "21-day returns on unworn kit with tags attached.",
      shippingPolicyText: "Dispatched within 48 hours.",
      freeShippingAboveMinor: 400000,
      flatShippingMinor: 8900,
      standardDeliveryDays: 4,
      warrantyText: "2-year warranty on waterproof membranes.",
      cancellationText: "Cancel free before dispatch.",
    },
  },
  {
    slug: "atelier-nine",
    name: "Atelier Nine",
    description: "Tailored occasionwear and smart separates. Made in small runs.",
    supportEmail: "studio@ateliernine.test",
    priceIndex: 1.28,
    fulfillmentRateBp: 9750,
    avgDispatchHours: 40,
    policies: {
      returnWindowDays: 14,
      returnsAccepted: true,
      returnPolicyText: "14-day returns on unaltered garments.",
      shippingPolicyText: "Pressed and boxed; dispatched in 2 working days.",
      freeShippingAboveMinor: 600000,
      flatShippingMinor: 12900,
      standardDeliveryDays: 5,
      warrantyText: "Complimentary first alteration.",
      cancellationText: "Cancel free within 24 hours.",
    },
  },
];

type ClothingSpec = {
  key: string;
  title: string;
  brand: string;
  category: string;
  description: string;
  priceMinor: number;
  colors: string[];
  sizes?: string[];
  merchants: string[];
  demand: number;
  attributes: Record<string, unknown>;
};

const CLOTHES: ClothingSpec[] = [
  // ------------------------------------------------------------- tops
  {
    key: "loom-heavy-tee",
    title: "Loom Heavyweight Cotton T-Shirt",
    brand: "Loom",
    category: "T-Shirts",
    description:
      "240gsm combed cotton with a ribbed collar that keeps its shape. Boxy fit, pre-shrunk, and it does not go see-through after a summer.",
    priceMinor: 129900,
    colors: ["white", "black", "sage", "navy", "ecru"],
    sizes: APPAREL,
    merchants: ["loom-and-thread", "urban-outfit-co", "budget-bazaar"],
    demand: 14,
    attributes: {
      gender: "unisex", fabric: "100% combed cotton", weightGsm: 240, fit: "boxy",
      care: "machine wash cold", features: ["pre-shrunk", "ribbed collar", "no side seams"],
    },
  },
  {
    key: "loom-pocket-tee",
    title: "Loom Pocket T-Shirt",
    brand: "Loom",
    category: "T-Shirts",
    description:
      "Lighter 180gsm everyday tee with a chest pocket and a slightly longer body.",
    priceMinor: 99900,
    colors: ["grey", "white", "olive", "rust"],
    sizes: APPAREL,
    merchants: ["loom-and-thread", "budget-bazaar"],
    demand: 13,
    attributes: {
      gender: "unisex", fabric: "cotton", weightGsm: 180, fit: "regular",
      features: ["chest pocket", "longer body"],
    },
  },
  {
    key: "northwind-merino-base",
    title: "Northwind Merino Base Layer",
    brand: "Northwind",
    category: "Base Layers",
    description:
      "170gsm merino wool next to skin. Warm when wet, and it does not start smelling on day two.",
    priceMinor: 549900,
    colors: ["charcoal", "navy", "moss"],
    sizes: CORE,
    merchants: ["northwind-outdoor", "peak-gear"],
    demand: 8,
    attributes: {
      gender: "unisex", fabric: "merino wool", weightGsm: 170, fit: "slim",
      features: ["odour resistant", "flatlock seams", "thumb loops"],
    },
  },
  {
    key: "loom-oxford-shirt",
    title: "Loom Oxford Button-Down Shirt",
    brand: "Loom",
    category: "Shirts",
    description:
      "Washed oxford cotton with a soft roll collar. Smart enough for the office, relaxed enough untucked.",
    priceMinor: 279900,
    colors: ["white", "blue", "pink", "striped"],
    sizes: CORE,
    merchants: ["loom-and-thread", "atelier-nine", "urban-outfit-co"],
    demand: 11,
    attributes: {
      gender: "men", fabric: "oxford cotton", fit: "regular", collar: "button-down",
      features: ["washed finish", "single chest pocket"],
    },
  },
  {
    key: "atelier-silk-blouse",
    title: "Atelier Silk Blouse",
    brand: "Atelier",
    category: "Shirts",
    description:
      "Sandwashed silk with a concealed placket and a fluid drape. Cool in summer, layers under knitwear.",
    priceMinor: 649900,
    colors: ["ivory", "black", "sage"],
    sizes: ["XS", "S", "M", "L"],
    merchants: ["atelier-nine"],
    demand: 6,
    attributes: {
      gender: "women", fabric: "sandwashed silk", fit: "relaxed",
      care: "dry clean", features: ["concealed placket", "french seams"],
    },
  },

  // --------------------------------------------------------- knitwear
  {
    key: "loom-fleece-hoodie",
    title: "Loom Brushed Fleece Hoodie",
    brand: "Loom",
    category: "Hoodies",
    description:
      "400gsm brushed-back fleece with a double-layer hood and a kangaroo pocket. Heavy enough to be the only layer in autumn.",
    priceMinor: 349900,
    colors: ["grey", "black", "forest", "burgundy"],
    sizes: APPAREL,
    merchants: ["loom-and-thread", "urban-outfit-co", "stride-athletics"],
    demand: 13,
    attributes: {
      gender: "unisex", fabric: "cotton-poly fleece", weightGsm: 400, fit: "relaxed",
      features: ["double-layer hood", "kangaroo pocket", "ribbed cuffs"],
    },
  },
  {
    key: "northwind-lambswool-crew",
    title: "Northwind Lambswool Crew Jumper",
    brand: "Northwind",
    category: "Knitwear",
    description:
      "Fully-fashioned lambswool crew neck, knitted in a mid-gauge that holds its shape.",
    priceMinor: 599900,
    colors: ["oatmeal", "navy", "moss", "charcoal"],
    sizes: CORE,
    merchants: ["northwind-outdoor", "atelier-nine"],
    demand: 9,
    attributes: {
      gender: "unisex", fabric: "lambswool", fit: "regular",
      features: ["fully fashioned", "ribbed hem"],
    },
  },

  // ---------------------------------------------------------- bottoms
  {
    key: "loom-selvedge-jeans",
    title: "Loom Selvedge Straight Jeans",
    brand: "Loom",
    category: "Jeans",
    description:
      "13.5oz raw selvedge denim, straight through the leg. Fades to your own pattern rather than arriving pre-worn.",
    priceMinor: 649900,
    colors: ["indigo", "black"],
    sizes: WAIST,
    merchants: ["loom-and-thread", "urban-outfit-co"],
    demand: 10,
    attributes: {
      gender: "unisex", fabric: "13.5oz selvedge denim", fit: "straight", rise: "mid",
      features: ["raw denim", "button fly", "selvedge outseam"],
    },
  },
  {
    key: "loom-chino",
    title: "Loom Stretch Chino Trousers",
    brand: "Loom",
    category: "Trousers",
    description:
      "Cotton twill with 2% elastane, so they move when you sit down. Tapered below the knee.",
    priceMinor: 329900,
    colors: ["stone", "navy", "olive", "black"],
    sizes: WAIST,
    merchants: ["loom-and-thread", "budget-bazaar", "atelier-nine"],
    demand: 12,
    attributes: {
      gender: "men", fabric: "cotton twill with elastane", fit: "tapered",
      features: ["stretch", "hidden coin pocket"],
    },
  },
  {
    key: "stride-run-tights",
    title: "Stride Thermal Running Tights",
    brand: "Stride",
    category: "Activewear",
    description:
      "Brushed-inside tights with a zip pocket at the back and reflective hits at the ankle for dark runs.",
    priceMinor: 269900,
    colors: ["black", "navy"],
    sizes: CORE,
    merchants: ["stride-athletics", "northwind-outdoor"],
    demand: 11,
    attributes: {
      gender: "unisex", fabric: "brushed poly-elastane", fit: "compression",
      features: ["zip pocket", "reflective", "flatlock seams"],
    },
  },
  {
    key: "stride-run-shorts",
    title: "Stride 5-Inch Running Shorts",
    brand: "Stride",
    category: "Activewear",
    description:
      "Lined 5-inch shorts with a phone-sized side pocket that does not bounce.",
    priceMinor: 169900,
    colors: ["black", "navy", "coral"],
    sizes: CORE,
    merchants: ["stride-athletics", "urban-outfit-co", "budget-bazaar"],
    demand: 13,
    attributes: {
      gender: "unisex", fabric: "recycled polyester", inseamInches: 5,
      features: ["built-in liner", "secure side pocket", "quick drying"],
    },
  },

  // ------------------------------------------------------ outerwear
  {
    key: "northwind-rain-shell",
    title: "Northwind 3-Layer Rain Shell",
    brand: "Northwind",
    category: "Jackets",
    description:
      "Fully taped 3-layer waterproof shell, 20k/20k rated, with pit zips and a helmet-compatible hood.",
    priceMinor: 1249900,
    colors: ["black", "orange", "moss"],
    sizes: CORE,
    merchants: ["northwind-outdoor", "peak-gear"],
    demand: 8,
    attributes: {
      gender: "unisex", waterproofMm: 20000, breathabilityGm2: 20000,
      features: ["fully taped seams", "pit zips", "adjustable hood"],
    },
  },
  {
    key: "northwind-down-jacket",
    title: "Northwind 700-Fill Down Jacket",
    brand: "Northwind",
    category: "Jackets",
    description:
      "700-fill responsibly-sourced down in a ripstop shell. Packs into its own pocket.",
    priceMinor: 1449900,
    colors: ["black", "navy", "rust"],
    sizes: CORE,
    merchants: ["northwind-outdoor"],
    demand: 7,
    attributes: {
      gender: "unisex", fill: "700-fill down", packable: true,
      features: ["packs into pocket", "ripstop shell", "elasticated cuffs"],
    },
  },
  {
    key: "atelier-wool-overcoat",
    title: "Atelier Wool Overcoat",
    brand: "Atelier",
    category: "Coats",
    description:
      "Single-breasted overcoat in a wool-cashmere blend, half-canvassed with a Bemberg lining.",
    priceMinor: 2199900,
    colors: ["camel", "charcoal", "navy"],
    sizes: CORE,
    merchants: ["atelier-nine"],
    demand: 5,
    attributes: {
      gender: "unisex", fabric: "wool-cashmere blend", construction: "half canvassed",
      features: ["Bemberg lining", "single breasted", "welt pockets"],
    },
  },

  // -------------------------------------------------------- formal
  {
    key: "atelier-suit-blazer",
    title: "Atelier Wool Suit Blazer",
    brand: "Atelier",
    category: "Suits",
    description:
      "Super 110s wool blazer with natural shoulders and a soft chest piece. Sold with matching trousers.",
    priceMinor: 1899900,
    colors: ["navy", "charcoal", "grey"],
    sizes: CORE,
    merchants: ["atelier-nine"],
    demand: 6,
    attributes: {
      gender: "men", fabric: "Super 110s wool", fit: "tailored",
      features: ["natural shoulder", "functional cuffs", "double vent"],
    },
  },
  {
    key: "atelier-occasion-dress",
    title: "Atelier Crepe Occasion Dress",
    brand: "Atelier",
    category: "Dresses",
    description:
      "Midi-length crepe dress with a concealed zip and a lined bodice. Holds a press all evening.",
    priceMinor: 1099900,
    colors: ["black", "emerald", "burgundy"],
    sizes: ["XS", "S", "M", "L", "XL"],
    merchants: ["atelier-nine", "urban-outfit-co"],
    demand: 7,
    attributes: {
      gender: "women", fabric: "stretch crepe", length: "midi",
      features: ["lined bodice", "concealed zip", "pockets"],
    },
  },

  // ------------------------------------------------ socks and extras
  {
    key: "loom-merino-socks",
    title: "Loom Merino Crew Socks (3 Pack)",
    brand: "Loom",
    category: "Socks",
    description:
      "Cushioned merino crew socks with a reinforced heel and toe. Three pairs.",
    priceMinor: 89900,
    colors: ["grey", "black", "mixed"],
    sizes: ["S", "M", "L"],
    merchants: ["loom-and-thread", "shoe-locker", "budget-bazaar"],
    demand: 15,
    attributes: {
      gender: "unisex", fabric: "merino blend", packSize: 3,
      features: ["reinforced heel", "cushioned sole", "seamless toe"],
    },
  },
  {
    key: "stride-running-socks",
    title: "Stride Anti-Blister Running Socks",
    brand: "Stride",
    category: "Socks",
    description:
      "Twin-layer construction that lets the two layers rub instead of your skin.",
    priceMinor: 69900,
    colors: ["white", "black"],
    sizes: ["S", "M", "L"],
    merchants: ["stride-athletics", "fleetfoot-running", "shoe-locker"],
    demand: 14,
    attributes: {
      gender: "unisex", fabric: "poly-blend", layers: 2,
      features: ["anti-blister", "arch support band", "quick drying"],
    },
  },
  {
    key: "northwind-beanie",
    title: "Northwind Ribbed Merino Beanie",
    brand: "Northwind",
    category: "Accessories",
    description:
      "Double-layer ribbed merino, sits close without squeezing.",
    priceMinor: 149900,
    colors: ["charcoal", "moss", "rust", "black"],
    sizes: ["One size"],
    merchants: ["northwind-outdoor", "peak-gear", "urban-outfit-co"],
    demand: 10,
    attributes: {
      gender: "unisex", fabric: "merino wool",
      features: ["double layer", "ribbed", "tagless"],
    },
  },
];

export const CLOTHES_PRODUCTS: ProductTemplate[] = CLOTHES.map((c) => ({
  key: c.key,
  title: c.title,
  brand: c.brand,
  category: c.category,
  description: c.description,
  attributes: c.attributes,
  basePriceMinor: c.priceMinor,
  axes: [
    { name: "size", values: c.sizes ?? CORE },
    { name: "color", values: c.colors },
  ],
  merchants: c.merchants,
  demand: c.demand,
}));

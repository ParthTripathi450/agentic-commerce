/**
 * Seed catalog definitions.
 *
 * Shaped deliberately so the demo query — "black running shoes, size 10, under
 * ₹5,000" — has an interesting answer: several merchants carry comparable
 * running shoes at different prices, delivery speeds and return windows, some
 * are out of stock in size 10, and one is cheap but fails the return-policy
 * criterion. That gives the ranker real trade-offs to explain rather than an
 * obvious single hit.
 */

export type MerchantSeed = {
  slug: string;
  name: string;
  description: string;
  supportEmail: string;
  /** Multiplier applied to template base prices — creates real price spread. */
  priceIndex: number;
  fulfillmentRateBp: number;
  avgDispatchHours: number;
  policies: {
    returnWindowDays: number;
    returnsAccepted: boolean;
    returnPolicyText: string;
    shippingPolicyText: string;
    freeShippingAboveMinor: number | null;
    flatShippingMinor: number;
    standardDeliveryDays: number;
    warrantyText: string;
    cancellationText: string;
  };
};

export const MERCHANTS: MerchantSeed[] = [
  {
    slug: "stride-athletics",
    name: "Stride Athletics",
    description:
      "Performance running and training gear. Specialist footwear fitting, wide sizes stocked.",
    supportEmail: "care@stride.test",
    priceIndex: 1.0,
    fulfillmentRateBp: 9700,
    avgDispatchHours: 18,
    policies: {
      returnWindowDays: 30,
      returnsAccepted: true,
      returnPolicyText: "30-day free returns on unworn footwear, prepaid label included.",
      shippingPolicyText: "Dispatched within 24 hours on weekdays.",
      freeShippingAboveMinor: 199900,
      flatShippingMinor: 9900,
      standardDeliveryDays: 3,
      warrantyText: "6-month manufacturing defect warranty.",
      cancellationText: "Cancel free of charge any time before dispatch.",
    },
  },
  {
    slug: "budget-bazaar",
    name: "Budget Bazaar",
    description: "Everyday essentials at the lowest price. High volume, no frills.",
    supportEmail: "help@budgetbazaar.test",
    priceIndex: 0.82,
    fulfillmentRateBp: 8900,
    avgDispatchHours: 60,
    policies: {
      returnWindowDays: 3,
      returnsAccepted: true,
      returnPolicyText: "3-day return window. Return shipping paid by the customer.",
      shippingPolicyText: "Dispatch in 2-3 working days.",
      freeShippingAboveMinor: null,
      flatShippingMinor: 5900,
      standardDeliveryDays: 7,
      warrantyText: "Warranty as provided by the brand only.",
      cancellationText: "Cancellation allowed within 12 hours of ordering.",
    },
  },
  {
    slug: "urban-outfit-co",
    name: "Urban Outfit Co.",
    description: "Streetwear and lifestyle apparel with a curated footwear range.",
    supportEmail: "hello@urbanoutfit.test",
    priceIndex: 1.12,
    fulfillmentRateBp: 9500,
    avgDispatchHours: 30,
    policies: {
      returnWindowDays: 14,
      returnsAccepted: true,
      returnPolicyText: "14-day exchange or refund on unused items.",
      shippingPolicyText: "Same-day dispatch on orders before 2pm.",
      freeShippingAboveMinor: 149900,
      flatShippingMinor: 7900,
      standardDeliveryDays: 4,
      warrantyText: "3-month warranty on accessories.",
      cancellationText: "Free cancellation before shipping.",
    },
  },
  {
    slug: "voltix-electronics",
    name: "Voltix Electronics",
    description: "Audio, wearables and charging gear. Authorised brand reseller.",
    supportEmail: "support@voltix.test",
    priceIndex: 1.05,
    fulfillmentRateBp: 9800,
    avgDispatchHours: 12,
    policies: {
      returnWindowDays: 10,
      returnsAccepted: true,
      returnPolicyText: "10-day replacement for dead-on-arrival units.",
      shippingPolicyText: "Insured courier, dispatched within 12 hours.",
      freeShippingAboveMinor: 99900,
      flatShippingMinor: 4900,
      standardDeliveryDays: 2,
      warrantyText: "1-year manufacturer warranty on all electronics.",
      cancellationText: "Cancel any time before the courier is assigned.",
    },
  },
  {
    slug: "hearth-and-home",
    name: "Hearth & Home",
    description: "Kitchen, storage and home comfort goods for everyday living.",
    supportEmail: "care@hearthhome.test",
    priceIndex: 0.95,
    fulfillmentRateBp: 9300,
    avgDispatchHours: 36,
    policies: {
      returnWindowDays: 7,
      returnsAccepted: true,
      returnPolicyText: "7-day return on unopened packaging.",
      shippingPolicyText: "Dispatch within 36 hours.",
      freeShippingAboveMinor: 129900,
      flatShippingMinor: 6900,
      standardDeliveryDays: 5,
      warrantyText: "Warranty varies by product category.",
      cancellationText: "Cancellation allowed until dispatch.",
    },
  },
  {
    slug: "peak-gear",
    name: "Peak Gear",
    description: "Outdoor, trekking and adventure equipment tested in the field.",
    supportEmail: "trail@peakgear.test",
    priceIndex: 1.18,
    fulfillmentRateBp: 9600,
    avgDispatchHours: 24,
    policies: {
      returnWindowDays: 21,
      returnsAccepted: true,
      returnPolicyText: "21-day field-test return policy, no questions asked.",
      shippingPolicyText: "Dispatch within 24 hours, tracked shipping.",
      freeShippingAboveMinor: 249900,
      flatShippingMinor: 11900,
      standardDeliveryDays: 4,
      warrantyText: "2-year warranty on packs and hardware.",
      cancellationText: "Free cancellation before dispatch.",
    },
  },
];

export type VariantAxis = { name: string; values: string[] };

export type ProductTemplate = {
  key: string;
  title: string;
  brand: string;
  category: string;
  description: string;
  attributes: Record<string, unknown>;
  /** Base price in minor units, before the merchant's price index. */
  basePriceMinor: number;
  axes: VariantAxis[];
  /** Merchant slugs that carry this product. */
  merchants: string[];
  /** Relative demand weight used when generating order history. */
  demand: number;
};

const SHOE_SIZES = ["7", "8", "9", "10", "11"];
const APPAREL_SIZES = ["S", "M", "L", "XL"];

export const PRODUCT_TEMPLATES: ProductTemplate[] = [
  // ---------------------------------------------------------------- footwear
  {
    key: "velocity-run-3",
    title: "Velocity Run 3 Road Running Shoes",
    brand: "Stride",
    category: "Running Shoes",
    description:
      "Lightweight neutral road running shoe with a responsive EVA midsole, breathable engineered mesh upper and a 8mm heel-to-toe drop. Built for daily training over 5-21 km.",
    attributes: {
      gender: "unisex",
      use: "road running",
      cushioning: "neutral",
      dropMm: 8,
      weightGrams: 245,
      upper: "engineered mesh",
      features: ["breathable", "reflective heel", "removable insole"],
    },
    basePriceMinor: 429900,
    axes: [
      { name: "size", values: SHOE_SIZES },
      { name: "color", values: ["black", "white", "blue"] },
    ],
    merchants: ["stride-athletics", "urban-outfit-co", "budget-bazaar"],
    demand: 10,
  },
  {
    key: "trailblaze-gtx",
    title: "Trailblaze GTX Trail Running Shoes",
    brand: "Peak",
    category: "Running Shoes",
    description:
      "Waterproof trail running shoe with an aggressive 4mm lug outsole, rock plate underfoot and a gusseted tongue to keep debris out on technical descents.",
    attributes: {
      gender: "unisex",
      use: "trail running",
      waterproof: true,
      dropMm: 6,
      weightGrams: 310,
      features: ["waterproof membrane", "rock plate", "gusseted tongue"],
    },
    basePriceMinor: 689900,
    axes: [
      { name: "size", values: SHOE_SIZES },
      { name: "color", values: ["black", "olive"] },
    ],
    merchants: ["peak-gear", "stride-athletics"],
    demand: 5,
  },
  {
    key: "pace-lite-flyknit",
    title: "Pace Lite Flyknit Running Shoes",
    brand: "Kova",
    category: "Running Shoes",
    description:
      "Budget-friendly everyday running shoe with a knit upper and compression-moulded foam midsole. A dependable first pair for new runners and gym use.",
    attributes: {
      gender: "unisex",
      use: "road running",
      cushioning: "neutral",
      dropMm: 10,
      weightGrams: 280,
      features: ["knit upper", "padded collar"],
    },
    basePriceMinor: 279900,
    axes: [
      { name: "size", values: SHOE_SIZES },
      { name: "color", values: ["black", "grey", "red"] },
    ],
    merchants: ["budget-bazaar", "urban-outfit-co"],
    demand: 8,
  },
  {
    key: "court-classic-low",
    title: "Court Classic Low Sneakers",
    brand: "Urban",
    category: "Sneakers",
    description:
      "Low-profile leather court sneaker with a vulcanised rubber sole and padded ankle collar. An everyday lifestyle shoe, not built for running.",
    attributes: {
      gender: "unisex",
      use: "lifestyle",
      material: "leather",
      features: ["vulcanised sole", "padded collar"],
    },
    basePriceMinor: 349900,
    axes: [
      { name: "size", values: SHOE_SIZES },
      { name: "color", values: ["white", "black"] },
    ],
    merchants: ["urban-outfit-co", "budget-bazaar"],
    demand: 7,
  },
  {
    key: "tempo-race-elite",
    title: "Tempo Race Elite Carbon Running Shoes",
    brand: "Stride",
    category: "Running Shoes",
    description:
      "Carbon-plated racing shoe with a high-stack nitrogen-infused foam midsole. Engineered for tempo sessions, time trials and race day.",
    attributes: {
      gender: "unisex",
      use: "racing",
      carbonPlate: true,
      dropMm: 8,
      weightGrams: 210,
      features: ["carbon plate", "race-day foam"],
    },
    basePriceMinor: 1249900,
    axes: [
      { name: "size", values: SHOE_SIZES },
      { name: "color", values: ["black", "orange"] },
    ],
    merchants: ["stride-athletics"],
    demand: 3,
  },
  // ---------------------------------------------------------------- apparel
  {
    key: "dryfit-training-tee",
    title: "DryFit Training T-Shirt",
    brand: "Stride",
    category: "Activewear",
    description:
      "Moisture-wicking training tee with flatlock seams and mesh side panels for high-output sessions.",
    attributes: { gender: "unisex", fabric: "recycled polyester", fit: "regular" },
    basePriceMinor: 99900,
    axes: [
      { name: "size", values: APPAREL_SIZES },
      { name: "color", values: ["black", "navy", "grey"] },
    ],
    merchants: ["stride-athletics", "budget-bazaar", "urban-outfit-co"],
    demand: 12,
  },
  {
    key: "windshell-jacket",
    title: "Windshell Packable Running Jacket",
    brand: "Peak",
    category: "Outerwear",
    description:
      "Ultralight packable windbreaker that stuffs into its own chest pocket. Water-resistant with taped shoulders and reflective trim.",
    attributes: {
      gender: "unisex",
      waterResistant: true,
      packable: true,
      features: ["reflective trim", "packs into pocket"],
    },
    basePriceMinor: 349900,
    axes: [
      { name: "size", values: APPAREL_SIZES },
      { name: "color", values: ["black", "yellow"] },
    ],
    merchants: ["peak-gear", "stride-athletics"],
    demand: 5,
  },
  {
    key: "everyday-hoodie",
    title: "Everyday Fleece Hoodie",
    brand: "Urban",
    category: "Apparel",
    description:
      "Brushed-back fleece hoodie with a kangaroo pocket and ribbed cuffs. Mid-weight, wearable year round.",
    attributes: { gender: "unisex", fabric: "cotton blend", fit: "relaxed" },
    basePriceMinor: 189900,
    axes: [
      { name: "size", values: APPAREL_SIZES },
      { name: "color", values: ["black", "beige", "green"] },
    ],
    merchants: ["urban-outfit-co", "budget-bazaar"],
    demand: 9,
  },
  // ------------------------------------------------------------ electronics
  {
    key: "aurora-anc-headphones",
    title: "Aurora ANC Over-Ear Headphones",
    brand: "Voltix",
    category: "Headphones",
    description:
      "Over-ear headphones with hybrid active noise cancellation, 40-hour battery life, multipoint pairing and a USB-C fast charge.",
    attributes: {
      connectivity: "bluetooth 5.3",
      batteryHours: 40,
      anc: true,
      features: ["multipoint", "USB-C fast charge", "foldable"],
    },
    basePriceMinor: 799900,
    axes: [{ name: "color", values: ["black", "silver"] }],
    merchants: ["voltix-electronics", "budget-bazaar"],
    demand: 8,
  },
  {
    key: "pulse-buds-pro",
    title: "Pulse Buds Pro Wireless Earbuds",
    brand: "Voltix",
    category: "Earbuds",
    description:
      "In-ear true wireless earbuds with adaptive noise cancellation, IPX5 sweat resistance and 28 hours of total playback with the case.",
    attributes: {
      connectivity: "bluetooth 5.3",
      batteryHours: 28,
      anc: true,
      waterResistance: "IPX5",
    },
    basePriceMinor: 399900,
    axes: [{ name: "color", values: ["black", "white"] }],
    merchants: ["voltix-electronics", "urban-outfit-co", "budget-bazaar"],
    demand: 14,
  },
  {
    key: "chrono-fit-watch",
    title: "ChronoFit Smartwatch",
    brand: "Voltix",
    category: "Wearables",
    description:
      "Fitness smartwatch with built-in GPS, heart-rate and SpO2 sensors, 14-day battery and a 1.4-inch AMOLED display.",
    attributes: {
      gps: true,
      batteryDays: 14,
      display: "1.4in AMOLED",
      waterResistance: "5ATM",
      features: ["GPS", "heart rate", "SpO2", "sleep tracking"],
    },
    basePriceMinor: 649900,
    axes: [{ name: "color", values: ["black", "rose gold"] }],
    merchants: ["voltix-electronics"],
    demand: 6,
  },
  {
    key: "powerbank-20k",
    title: "20,000 mAh Fast-Charge Power Bank",
    brand: "Voltix",
    category: "Power Accessories",
    description:
      "20,000 mAh power bank with 65W USB-C power delivery, capable of charging a laptop, and a pass-through charging mode.",
    attributes: { capacityMah: 20000, outputWatts: 65, ports: 3, passThrough: true },
    basePriceMinor: 299900,
    axes: [{ name: "color", values: ["black"] }],
    merchants: ["voltix-electronics", "budget-bazaar", "peak-gear"],
    demand: 11,
  },
  // --------------------------------------------------------------- outdoors
  {
    key: "summit-45-backpack",
    title: "Summit 45L Trekking Backpack",
    brand: "Peak",
    category: "Backpacks",
    description:
      "45-litre trekking pack with an adjustable aluminium frame, ventilated back panel, rain cover and hydration bladder sleeve.",
    attributes: {
      capacityLitres: 45,
      frame: "aluminium",
      rainCover: true,
      features: ["hydration sleeve", "ventilated back", "load lifters"],
    },
    basePriceMinor: 549900,
    axes: [{ name: "color", values: ["black", "blue"] }],
    merchants: ["peak-gear"],
    demand: 4,
  },
  {
    key: "thermo-bottle-1l",
    title: "ThermoSteel 1L Insulated Bottle",
    brand: "Hearth",
    category: "Drinkware",
    description:
      "Double-walled vacuum insulated stainless steel bottle. Keeps drinks hot for 12 hours or cold for 24.",
    attributes: { capacityMl: 1000, material: "stainless steel", insulationHours: 24 },
    basePriceMinor: 149900,
    axes: [{ name: "color", values: ["black", "steel", "teal"] }],
    merchants: ["hearth-and-home", "peak-gear", "budget-bazaar"],
    demand: 10,
  },
  {
    key: "camp-stove-compact",
    title: "Compact Camping Stove",
    brand: "Peak",
    category: "Camping",
    description:
      "Foldable canister-top camping stove with piezo ignition, weighing 118 g and packing into a palm-sized case.",
    attributes: { weightGrams: 118, ignition: "piezo", foldable: true },
    basePriceMinor: 229900,
    axes: [{ name: "color", values: ["silver"] }],
    merchants: ["peak-gear"],
    demand: 3,
  },
  // ------------------------------------------------------------------- home
  {
    key: "ceramic-cookware-set",
    title: "5-Piece Ceramic Non-Stick Cookware Set",
    brand: "Hearth",
    category: "Cookware",
    description:
      "Five-piece ceramic-coated non-stick cookware set with induction-compatible bases and stay-cool bakelite handles.",
    attributes: { pieces: 5, coating: "ceramic", inductionCompatible: true },
    basePriceMinor: 499900,
    axes: [{ name: "color", values: ["grey", "red"] }],
    merchants: ["hearth-and-home"],
    demand: 5,
  },
  {
    key: "storage-bins-set",
    title: "Stackable Storage Bins (Set of 3)",
    brand: "Hearth",
    category: "Storage",
    description:
      "Set of three stackable storage bins in food-grade polypropylene with clip-lock lids and ventilation slots.",
    attributes: { pieces: 3, material: "polypropylene", stackable: true },
    basePriceMinor: 129900,
    axes: [{ name: "color", values: ["clear", "white"] }],
    merchants: ["hearth-and-home", "budget-bazaar"],
    demand: 7,
  },
  {
    key: "desk-lamp-led",
    title: "Adjustable LED Desk Lamp",
    brand: "Hearth",
    category: "Lighting",
    description:
      "Dimmable LED desk lamp with five colour temperatures, a USB charging port and a weighted articulating arm.",
    attributes: { dimmable: true, colourTemperatures: 5, usbPort: true },
    basePriceMinor: 179900,
    axes: [{ name: "color", values: ["white", "black"] }],
    merchants: ["hearth-and-home", "voltix-electronics"],
    demand: 6,
  },
  {
    key: "yoga-mat-6mm",
    title: "6mm Cushioned Yoga Mat",
    brand: "Stride",
    category: "Fitness Accessories",
    description:
      "6 mm high-density TPE yoga mat with an alignment guide, non-slip texture and a carry strap.",
    attributes: { thicknessMm: 6, material: "TPE", nonSlip: true },
    basePriceMinor: 139900,
    axes: [{ name: "color", values: ["purple", "black", "teal"] }],
    merchants: ["stride-athletics", "budget-bazaar", "hearth-and-home"],
    demand: 9,
  },
];

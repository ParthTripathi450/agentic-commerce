import type { MerchantSeed, ProductTemplate } from "./seed-data";

/**
 * A deep footwear catalogue.
 *
 * Exists so the conversational shopping agent can actually be exercised: with
 * ten shoes, any query returns nearly everything and the clarifying questions
 * have nothing to narrow. Depth here means real spread on every axis the agent
 * asks about — type, purpose, colour, size, width, price band and merchant —
 * so that "black marathon shoes under 8000" and "cheap white sneakers" resolve
 * to genuinely different, defensible answers.
 *
 * Brands are invented, matching the rest of the seed. Attributing fabricated
 * specifications and prices to real manufacturers would make the demo data
 * misleading the moment anyone screenshots it.
 */

const SHOE_SIZES = ["6", "7", "8", "9", "10", "11", "12"];
const CORE_SIZES = ["7", "8", "9", "10", "11"];
const FORMAL_SIZES = ["7", "8", "9", "10", "11"];

export const SHOE_MERCHANTS: MerchantSeed[] = [
  {
    slug: "fleetfoot-running",
    name: "Fleetfoot Running Co.",
    description:
      "Specialist running shop staffed by runners. Gait analysis, race-day fitting and honest advice about when your shoes are done.",
    supportEmail: "hello@fleetfoot.test",
    priceIndex: 1.06,
    fulfillmentRateBp: 9720,
    avgDispatchHours: 18,
    policies: {
      returnWindowDays: 30,
      returnsAccepted: true,
      returnPolicyText: "30-day run-in guarantee — return them even after a few road runs.",
      shippingPolicyText: "Dispatched same day on orders before 3pm.",
      freeShippingAboveMinor: 300000,
      flatShippingMinor: 7900,
      standardDeliveryDays: 2,
      warrantyText: "6-month midsole and outsole warranty against manufacturing defects.",
      cancellationText: "Cancel free before dispatch.",
    },
  },
  {
    slug: "sole-republic",
    name: "Sole Republic",
    description:
      "Sneaker boutique. Limited drops, court classics and the occasional very loud colourway.",
    supportEmail: "care@solerepublic.test",
    priceIndex: 1.14,
    fulfillmentRateBp: 9480,
    avgDispatchHours: 26,
    policies: {
      returnWindowDays: 14,
      returnsAccepted: true,
      returnPolicyText: "14-day returns, unworn and in the original box.",
      shippingPolicyText: "Double-boxed to protect the shoe box itself.",
      freeShippingAboveMinor: 500000,
      flatShippingMinor: 9900,
      standardDeliveryDays: 3,
      warrantyText: "Authenticity guaranteed; manufacturing defects replaced.",
      cancellationText: "Cancel free within 12 hours of ordering.",
    },
  },
  {
    slug: "oxford-and-last",
    name: "Oxford & Last",
    description:
      "Goodyear-welted formal footwear, resoleable and built to be repaired rather than replaced.",
    supportEmail: "shop@oxfordandlast.test",
    priceIndex: 1.22,
    fulfillmentRateBp: 9800,
    avgDispatchHours: 34,
    policies: {
      returnWindowDays: 21,
      returnsAccepted: true,
      returnPolicyText: "21-day returns on unworn shoes; try them on carpet first.",
      shippingPolicyText: "Shipped in a cloth bag inside a rigid box.",
      freeShippingAboveMinor: 400000,
      flatShippingMinor: 11900,
      standardDeliveryDays: 4,
      warrantyText: "12-month welt and construction warranty. Resoling available at cost.",
      cancellationText: "Cancel free before the shoe leaves the workshop.",
    },
  },
  {
    slug: "shoe-locker",
    name: "The Shoe Locker",
    description:
      "High-street multi-brand shoe shop. Wide fittings, school shoes and whatever is on offer this week.",
    supportEmail: "help@shoelocker.test",
    priceIndex: 0.92,
    fulfillmentRateBp: 9250,
    avgDispatchHours: 30,
    policies: {
      returnWindowDays: 28,
      returnsAccepted: true,
      returnPolicyText: "28-day returns with a receipt, unworn.",
      shippingPolicyText: "Standard dispatch within 2 working days.",
      freeShippingAboveMinor: 200000,
      flatShippingMinor: 5900,
      standardDeliveryDays: 4,
      warrantyText: "3-month warranty on manufacturing defects.",
      cancellationText: "Cancel free before dispatch.",
    },
  },
  {
    slug: "field-and-court",
    name: "Field & Court",
    description:
      "Team-sport footwear — football, cricket, basketball and indoor court. Studs, cleats and grip.",
    supportEmail: "team@fieldandcourt.test",
    priceIndex: 0.96,
    fulfillmentRateBp: 9350,
    avgDispatchHours: 22,
    policies: {
      returnWindowDays: 15,
      returnsAccepted: true,
      returnPolicyText: "15-day returns provided the studs are unmarked.",
      shippingPolicyText: "Dispatched within 24 hours on weekdays.",
      freeShippingAboveMinor: 250000,
      flatShippingMinor: 6900,
      standardDeliveryDays: 3,
      warrantyText: "6-month warranty on stud plates and uppers.",
      cancellationText: "Cancel free before dispatch.",
    },
  },
];

/** Compact spec — expanded into a full ProductTemplate below. */
type ShoeSpec = {
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

const SHOES: ShoeSpec[] = [
  // ------------------------------------------------------- road running
  {
    key: "arcus-tempo-5",
    title: "Arcus Tempo 5 Road Running Shoes",
    brand: "Arcus",
    category: "Running Shoes",
    description:
      "Daily trainer with a nitrogen-infused foam midsole and a 6mm drop. Light enough for tempo work, cushioned enough for a 20 km long run.",
    priceMinor: 749900,
    colors: ["black", "white", "cobalt"],
    merchants: ["fleetfoot-running", "stride-athletics"],
    demand: 11,
    attributes: {
      gender: "unisex", use: "road running", cushioning: "neutral", dropMm: 6,
      weightGrams: 232, upper: "engineered mesh", width: "regular",
      features: ["breathable", "rocker geometry", "reflective detailing"],
    },
  },
  {
    key: "arcus-meridian-marathon",
    title: "Arcus Meridian Carbon Marathon Racer",
    brand: "Arcus",
    category: "Running Shoes",
    description:
      "Carbon-plated marathon racing shoe. A full-length plate over supercritical foam returns energy at pace; intended for race day and key sessions, not daily mileage.",
    priceMinor: 1899900,
    colors: ["orange", "white"],
    sizes: CORE_SIZES,
    merchants: ["fleetfoot-running"],
    demand: 7,
    attributes: {
      gender: "unisex", use: "marathon racing", cushioning: "responsive", dropMm: 8,
      weightGrams: 198, plate: "carbon fibre", upper: "ultralight knit", width: "regular",
      features: ["carbon plate", "race day", "supercritical foam"],
    },
  },
  {
    key: "nimbra-cloudstep-9",
    title: "Nimbra Cloudstep 9 Max Cushion Running Shoes",
    brand: "Nimbra",
    category: "Running Shoes",
    description:
      "Maximum-cushion trainer for high-mileage weeks and recovery runs. A broad, stable base and a plush 38mm stack take the sting out of concrete.",
    priceMinor: 999900,
    colors: ["grey", "navy", "plum"],
    merchants: ["fleetfoot-running", "stride-athletics", "budget-bazaar"],
    demand: 10,
    attributes: {
      gender: "unisex", use: "road running", cushioning: "max", dropMm: 5,
      weightGrams: 288, stackHeightMm: 38, upper: "soft knit", width: "regular",
      features: ["max cushion", "recovery runs", "wide base"],
    },
  },
  {
    key: "nimbra-anchor-stability",
    title: "Nimbra Anchor Stability Running Shoes",
    brand: "Nimbra",
    category: "Running Shoes",
    description:
      "Support trainer for runners who overpronate. Guide rails firm up the medial side without the harsh feel of an old-fashioned motion-control shoe.",
    priceMinor: 829900,
    colors: ["black", "teal"],
    merchants: ["fleetfoot-running", "peak-gear"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "road running", cushioning: "stability", dropMm: 10,
      weightGrams: 301, support: "overpronation", upper: "engineered mesh", width: "wide",
      features: ["guide rails", "arch support", "wide fit available"],
    },
  },
  {
    key: "vantor-dash-lite",
    title: "Vantor Dash Lite Budget Running Shoes",
    brand: "Vantor",
    category: "Running Shoes",
    description:
      "Honest entry-level running shoe for beginners and short distances. Compression-moulded EVA, a mesh upper and nothing you are paying for twice.",
    priceMinor: 249900,
    colors: ["black", "white", "red"],
    merchants: ["budget-bazaar", "shoe-locker"],
    demand: 12,
    attributes: {
      gender: "unisex", use: "road running", cushioning: "neutral", dropMm: 10,
      weightGrams: 265, upper: "mesh", width: "regular",
      features: ["beginner friendly", "lightweight", "everyday"],
    },
  },
  {
    key: "vantor-park-5k",
    title: "Vantor Park 5K Running Shoes",
    brand: "Vantor",
    category: "Running Shoes",
    description:
      "Built for parkrun distances and couch-to-5K plans. Flexible forefoot, cushioned heel and a hard-wearing rubber outsole.",
    priceMinor: 329900,
    colors: ["blue", "grey", "pink"],
    merchants: ["shoe-locker", "budget-bazaar", "stride-athletics"],
    demand: 11,
    attributes: {
      gender: "unisex", use: "road running", cushioning: "neutral", dropMm: 9,
      weightGrams: 258, upper: "mesh", width: "regular",
      features: ["5k", "beginner friendly", "durable outsole"],
    },
  },
  {
    key: "solene-aria-womens",
    title: "Solene Aria Women's Running Shoes",
    brand: "Solene",
    category: "Running Shoes",
    description:
      "Built on a women's-specific last with a narrower heel and a softer top-loaded foam. Neutral daily trainer for road and treadmill.",
    priceMinor: 679900,
    colors: ["lilac", "white", "coral"],
    sizes: ["5", "6", "7", "8", "9"],
    merchants: ["fleetfoot-running", "sole-republic"],
    demand: 9,
    attributes: {
      gender: "women", use: "road running", cushioning: "neutral", dropMm: 8,
      weightGrams: 218, last: "women's specific", upper: "engineered mesh", width: "narrow",
      features: ["narrow heel", "treadmill", "lightweight"],
    },
  },
  {
    key: "torvi-ultra-100",
    title: "Torvi Ultra 100 Long Distance Running Shoes",
    brand: "Torvi",
    category: "Running Shoes",
    description:
      "Ultramarathon shoe with a roomy toe box for feet that swell after hour six, a 34mm stack and a drainage-friendly upper.",
    priceMinor: 1249900,
    colors: ["olive", "black"],
    merchants: ["fleetfoot-running", "peak-gear"],
    demand: 6,
    attributes: {
      gender: "unisex", use: "ultra running", cushioning: "max", dropMm: 4,
      weightGrams: 295, upper: "quick-drain mesh", width: "wide", toeBox: "roomy",
      features: ["ultramarathon", "wide toe box", "quick drying"],
    },
  },

  // ------------------------------------------------------------- trail
  {
    key: "torvi-scree-trail",
    title: "Torvi Scree Trail Running Shoes",
    brand: "Torvi",
    category: "Trail Shoes",
    description:
      "Technical trail shoe with 5mm lugs, a rock plate and a toe bumper. Grips wet rock and loose scree without turning to mush on road sections.",
    priceMinor: 899900,
    colors: ["olive", "orange", "slate"],
    merchants: ["peak-gear", "fleetfoot-running"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "trail running", cushioning: "neutral", dropMm: 6,
      lugDepthMm: 5, weightGrams: 312, upper: "ripstop mesh", width: "regular",
      features: ["rock plate", "toe bumper", "aggressive lugs"],
    },
  },
  {
    key: "peak-fell-gtx",
    title: "Peak Fell GTX Waterproof Trail Shoes",
    brand: "Peak",
    category: "Trail Shoes",
    description:
      "Waterproof-membrane trail shoe for winter fell running and muddy bridleways. Gusseted tongue keeps grit out on long descents.",
    priceMinor: 1099900,
    colors: ["black", "moss"],
    merchants: ["peak-gear"],
    demand: 6,
    attributes: {
      gender: "unisex", use: "trail running", waterproof: true, dropMm: 8,
      lugDepthMm: 6, weightGrams: 340, upper: "waterproof membrane", width: "regular",
      features: ["waterproof", "gusseted tongue", "winter"],
    },
  },

  // --------------------------------------------------------- sneakers
  {
    key: "sole-court-77",
    title: "Sole Court 77 Retro Sneakers",
    brand: "Solene",
    category: "Sneakers",
    description:
      "Low-profile court sneaker in full-grain leather with a vulcanised rubber sole. The one that goes with everything.",
    priceMinor: 649900,
    colors: ["white", "black", "green", "navy"],
    merchants: ["sole-republic", "urban-outfit-co"],
    demand: 13,
    attributes: {
      gender: "unisex", use: "casual", upper: "full-grain leather", sole: "vulcanised rubber",
      style: "retro court", width: "regular",
      features: ["everyday", "leather", "flat sole"],
    },
  },
  {
    key: "sole-canvas-classic",
    title: "Sole Canvas Classic Low-Top Sneakers",
    brand: "Solene",
    category: "Sneakers",
    description:
      "Cotton canvas low-top with a cushioned footbed. Cheap enough to get muddy at a festival and still wear to work on Monday.",
    priceMinor: 219900,
    colors: ["white", "black", "red", "mustard"],
    merchants: ["urban-outfit-co", "budget-bazaar", "shoe-locker"],
    demand: 14,
    attributes: {
      gender: "unisex", use: "casual", upper: "cotton canvas", sole: "rubber",
      style: "low top", width: "regular",
      features: ["everyday", "machine washable", "budget"],
    },
  },
  {
    key: "draxen-chunky-90",
    title: "Draxen Chunky 90 Dad Sneakers",
    brand: "Draxen",
    category: "Sneakers",
    description:
      "Deliberately oversized silhouette with layered mesh and suede overlays on a 4cm chunky sole. Comfortable, unsubtle.",
    priceMinor: 799900,
    colors: ["white", "grey", "beige"],
    merchants: ["sole-republic", "urban-outfit-co"],
    demand: 10,
    attributes: {
      gender: "unisex", use: "casual", upper: "mesh and suede", sole: "chunky EVA",
      style: "dad sneaker", width: "regular",
      features: ["chunky sole", "streetwear", "layered upper"],
    },
  },
  {
    key: "draxen-highline",
    title: "Draxen Highline High-Top Sneakers",
    brand: "Draxen",
    category: "Sneakers",
    description:
      "Padded-collar high-top in tumbled leather. Ankle coverage without the weight of a basketball shoe.",
    priceMinor: 719900,
    colors: ["black", "white", "burgundy"],
    merchants: ["sole-republic"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "casual", upper: "tumbled leather", style: "high top",
      width: "regular", features: ["ankle support", "padded collar", "streetwear"],
    },
  },
  {
    key: "vantor-slip-easy",
    title: "Vantor Slip-Easy Laceless Sneakers",
    brand: "Vantor",
    category: "Sneakers",
    description:
      "Elasticated laceless slip-on for airports, school runs and anyone tired of bending down.",
    priceMinor: 189900,
    colors: ["black", "grey", "navy"],
    merchants: ["budget-bazaar", "shoe-locker"],
    demand: 12,
    attributes: {
      gender: "unisex", use: "casual", closure: "slip-on", upper: "knit",
      width: "regular", features: ["laceless", "travel", "budget"],
    },
  },
  {
    key: "solene-knit-glide",
    title: "Solene Knit Glide Everyday Sneakers",
    brand: "Solene",
    category: "Sneakers",
    description:
      "Seamless knit upper over a light foam sole. Sock-like fit that suits wide feet and long days standing up.",
    priceMinor: 459900,
    colors: ["white", "charcoal", "sage"],
    merchants: ["urban-outfit-co", "sole-republic", "shoe-locker"],
    demand: 11,
    attributes: {
      gender: "unisex", use: "casual", upper: "seamless knit", width: "wide",
      features: ["breathable", "all day comfort", "wide fit"],
    },
  },

  // ----------------------------------------------------------- cleats
  {
    key: "field-strike-fg",
    title: "Field Strike FG Firm Ground Football Boots",
    brand: "Torvi",
    category: "Football Boots",
    description:
      "Firm-ground football boot with a moulded 12-stud plate and a textured synthetic upper for grip on the ball in the wet.",
    priceMinor: 599900,
    colors: ["black", "volt", "crimson"],
    merchants: ["field-and-court"],
    demand: 9,
    attributes: {
      gender: "unisex", use: "football", surface: "firm ground", studs: "moulded",
      studCount: 12, upper: "textured synthetic", width: "regular",
      features: ["firm ground", "grip texture", "moulded studs"],
    },
  },
  {
    key: "field-strike-sg",
    title: "Field Strike SG Soft Ground Football Boots",
    brand: "Torvi",
    category: "Football Boots",
    description:
      "Soft-ground boot with six replaceable metal studs for heavy winter pitches. Comes with a stud key.",
    priceMinor: 749900,
    colors: ["black", "white"],
    sizes: CORE_SIZES,
    merchants: ["field-and-court"],
    demand: 6,
    attributes: {
      gender: "unisex", use: "football", surface: "soft ground", studs: "replaceable metal",
      studCount: 6, upper: "kangaroo-alternative leather", width: "regular",
      features: ["soft ground", "metal studs", "stud key included"],
    },
  },
  {
    key: "field-astro-turf",
    title: "Field Astro Turf Trainers",
    brand: "Torvi",
    category: "Football Boots",
    description:
      "Dimpled rubber outsole for 3G and astroturf. Spreads load across the foot instead of concentrating it on studs.",
    priceMinor: 419900,
    colors: ["black", "blue"],
    merchants: ["field-and-court", "shoe-locker"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "football", surface: "astroturf", studs: "dimpled rubber",
      upper: "synthetic", width: "regular",
      features: ["astroturf", "3G", "training"],
    },
  },
  {
    key: "field-crease-cricket",
    title: "Field Crease Cricket Spikes",
    brand: "Torvi",
    category: "Cricket Shoes",
    description:
      "Cricket shoe with replaceable front spikes and a reinforced toe for bowlers dragging their landing foot.",
    priceMinor: 529900,
    colors: ["white", "navy"],
    sizes: CORE_SIZES,
    merchants: ["field-and-court"],
    demand: 5,
    attributes: {
      gender: "unisex", use: "cricket", studs: "replaceable spikes",
      reinforcement: "toe drag guard", width: "regular",
      features: ["bowling", "spikes", "toe guard"],
    },
  },

  // ------------------------------------------------------- basketball
  {
    key: "draxen-rimline-hi",
    title: "Draxen Rimline High Basketball Shoes",
    brand: "Draxen",
    category: "Basketball Shoes",
    description:
      "High-top basketball shoe with a herringbone traction pattern, external heel counter and a full-length cushioning unit for hard landings.",
    priceMinor: 949900,
    colors: ["black", "white", "royal"],
    merchants: ["field-and-court", "sole-republic"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "basketball", cut: "high top", traction: "herringbone",
      cushioning: "full length", width: "regular",
      features: ["ankle support", "indoor court", "heel counter"],
    },
  },
  {
    key: "draxen-fastbreak-low",
    title: "Draxen Fastbreak Low Basketball Shoes",
    brand: "Draxen",
    category: "Basketball Shoes",
    description:
      "Low-cut guard shoe built for lateral quickness. Lighter and freer at the ankle than a high-top, at the cost of coverage.",
    priceMinor: 799900,
    colors: ["red", "black", "white"],
    merchants: ["field-and-court"],
    demand: 6,
    attributes: {
      gender: "unisex", use: "basketball", cut: "low top", traction: "herringbone",
      weightGrams: 340, width: "regular",
      features: ["lightweight", "lateral support", "guard"],
    },
  },

  // ----------------------------------------------------------- formal
  {
    key: "oxford-regent-oxford",
    title: "Oxford Regent Leather Oxford Shoes",
    brand: "Cobbleworks",
    category: "Formal Shoes",
    description:
      "Closed-lacing Oxford in calf leather on a Goodyear welt. The correct shoe for a suit, and resoleable when the time comes.",
    priceMinor: 1299900,
    colors: ["black", "oxblood"],
    sizes: FORMAL_SIZES,
    merchants: ["oxford-and-last"],
    demand: 7,
    attributes: {
      gender: "men", use: "formal", construction: "Goodyear welt", upper: "calf leather",
      toe: "cap toe", sole: "leather", width: "regular",
      features: ["resoleable", "business", "closed lacing"],
    },
  },
  {
    key: "oxford-chancery-derby",
    title: "Oxford Chancery Derby Shoes",
    brand: "Cobbleworks",
    category: "Formal Shoes",
    description:
      "Open-lacing Derby with a rounder last, which suits a higher instep and a slightly less formal register than an Oxford.",
    priceMinor: 1149900,
    colors: ["brown", "black"],
    sizes: FORMAL_SIZES,
    merchants: ["oxford-and-last", "urban-outfit-co"],
    demand: 7,
    attributes: {
      gender: "men", use: "formal", construction: "Goodyear welt", upper: "calf leather",
      toe: "plain toe", sole: "leather", width: "wide",
      features: ["resoleable", "high instep", "open lacing"],
    },
  },
  {
    key: "oxford-brogue-heritage",
    title: "Oxford Heritage Full Brogue Shoes",
    brand: "Cobbleworks",
    category: "Formal Shoes",
    description:
      "Full wingtip brogue with hand-punched medallion detailing on a country-weight rubber sole.",
    priceMinor: 1449900,
    colors: ["tan", "dark brown"],
    sizes: FORMAL_SIZES,
    merchants: ["oxford-and-last"],
    demand: 5,
    attributes: {
      gender: "men", use: "formal", construction: "Goodyear welt", upper: "grain leather",
      toe: "wingtip", sole: "rubber", width: "regular",
      features: ["brogue", "country", "hand punched"],
    },
  },
  {
    key: "oxford-loafer-penny",
    title: "Oxford Penny Loafers",
    brand: "Cobbleworks",
    category: "Formal Shoes",
    description:
      "Unlined penny loafer in soft calf. Slips on, dresses down a suit and works without socks in summer.",
    priceMinor: 989900,
    colors: ["burgundy", "black", "tan"],
    sizes: FORMAL_SIZES,
    merchants: ["oxford-and-last", "sole-republic"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "formal", closure: "slip-on", upper: "calf leather",
      lining: "unlined", width: "regular",
      features: ["loafer", "summer", "smart casual"],
    },
  },
  {
    key: "oxford-chelsea-boot",
    title: "Oxford Chelsea Leather Boots",
    brand: "Cobbleworks",
    category: "Formal Shoes",
    description:
      "Elastic-gusset Chelsea boot with a pull tab and a stacked leather heel. Formal enough for the office, tough enough for rain.",
    priceMinor: 1349900,
    colors: ["black", "brown"],
    sizes: FORMAL_SIZES,
    merchants: ["oxford-and-last", "urban-outfit-co"],
    demand: 7,
    attributes: {
      gender: "unisex", use: "formal", closure: "elastic gusset", upper: "calf leather",
      heel: "stacked leather", width: "regular",
      features: ["chelsea boot", "pull tab", "office"],
    },
  },
  {
    key: "vantor-office-flex",
    title: "Vantor Office Flex Formal Shoes",
    brand: "Vantor",
    category: "Formal Shoes",
    description:
      "Budget formal shoe with a cemented sole and a padded footbed. For interviews, weddings and anything you do not do weekly.",
    priceMinor: 259900,
    colors: ["black", "brown"],
    sizes: FORMAL_SIZES,
    merchants: ["budget-bazaar", "shoe-locker"],
    demand: 11,
    attributes: {
      gender: "men", use: "formal", construction: "cemented", upper: "synthetic leather",
      width: "regular", features: ["budget", "interview", "padded footbed"],
    },
  },

  // -------------------------------------------------------- hiking
  {
    key: "peak-summit-boot",
    title: "Peak Summit Waterproof Hiking Boots",
    brand: "Peak",
    category: "Hiking Boots",
    description:
      "Mid-cut waterproof hiking boot with a supportive shank and a deep-lug outsole. Carries a loaded pack over rough ground.",
    priceMinor: 1199900,
    colors: ["brown", "grey"],
    merchants: ["peak-gear"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "hiking", waterproof: true, cut: "mid", lugDepthMm: 5,
      shank: "nylon", weightGrams: 520, width: "wide",
      features: ["waterproof", "ankle support", "backpacking"],
    },
  },
  {
    key: "peak-ridge-approach",
    title: "Peak Ridge Approach Shoes",
    brand: "Peak",
    category: "Hiking Boots",
    description:
      "Low-cut approach shoe with sticky rubber and a climbing zone at the toe. For scrambly walk-ins where boots are overkill.",
    priceMinor: 869900,
    colors: ["slate", "olive"],
    merchants: ["peak-gear", "fleetfoot-running"],
    demand: 6,
    attributes: {
      gender: "unisex", use: "hiking", cut: "low", rubber: "sticky",
      weightGrams: 395, width: "regular",
      features: ["approach", "climbing zone", "scrambling"],
    },
  },

  // ------------------------------------------------------- training
  {
    key: "arcus-grid-trainer",
    title: "Arcus Grid Cross Training Shoes",
    brand: "Arcus",
    category: "Training Shoes",
    description:
      "Flat, stable gym shoe for lifting and circuits. A firm heel for squats and enough forefoot flex for box jumps.",
    priceMinor: 569900,
    colors: ["black", "white", "lime"],
    merchants: ["stride-athletics", "fleetfoot-running", "shoe-locker"],
    demand: 10,
    attributes: {
      gender: "unisex", use: "cross training", dropMm: 4, sole: "flat stable",
      weightGrams: 310, width: "regular",
      features: ["lifting", "gym", "rope guard"],
    },
  },
  {
    key: "arcus-anvil-lifter",
    title: "Arcus Anvil Weightlifting Shoes",
    brand: "Arcus",
    category: "Training Shoes",
    description:
      "Raised-heel weightlifting shoe with a rigid TPU heel wedge and a metatarsal strap. Improves squat depth and ankle position.",
    priceMinor: 899900,
    colors: ["black", "red"],
    sizes: CORE_SIZES,
    merchants: ["stride-athletics"],
    demand: 4,
    attributes: {
      gender: "unisex", use: "weightlifting", heelLiftMm: 20, sole: "rigid TPU",
      closure: "metatarsal strap", width: "regular",
      features: ["squat", "raised heel", "olympic lifting"],
    },
  },
  {
    key: "solene-studio-flex",
    title: "Solene Studio Flex Gym Trainers",
    brand: "Solene",
    category: "Training Shoes",
    description:
      "Light, flexible studio shoe for HIIT, dance and aerobics classes. Pivot point under the forefoot for turning on gym floors.",
    priceMinor: 429900,
    colors: ["white", "blush", "black"],
    sizes: ["5", "6", "7", "8", "9"],
    merchants: ["stride-athletics", "urban-outfit-co"],
    demand: 9,
    attributes: {
      gender: "women", use: "studio training", dropMm: 6, weightGrams: 215,
      width: "narrow", features: ["HIIT", "pivot point", "flexible"],
    },
  },

  // -------------------------------------------------------- walking
  {
    key: "nimbra-stroll-comfort",
    title: "Nimbra Stroll Comfort Walking Shoes",
    brand: "Nimbra",
    category: "Walking Shoes",
    description:
      "Cushioned walking shoe with a removable orthotic-friendly insole and a wide, stable platform. Built for hours on your feet.",
    priceMinor: 549900,
    colors: ["black", "grey", "navy"],
    merchants: ["shoe-locker", "budget-bazaar", "stride-athletics"],
    demand: 12,
    attributes: {
      gender: "unisex", use: "walking", cushioning: "max", width: "wide",
      insole: "removable orthotic friendly", weightGrams: 300,
      features: ["all day comfort", "orthotic friendly", "wide fit"],
    },
  },
  {
    key: "nimbra-commute-waterproof",
    title: "Nimbra Commute Waterproof Walking Shoes",
    brand: "Nimbra",
    category: "Walking Shoes",
    description:
      "Waterproof everyday walking shoe with a reflective heel strip for dark commutes and a sealed seam construction.",
    priceMinor: 689900,
    colors: ["black", "charcoal"],
    merchants: ["shoe-locker", "peak-gear"],
    demand: 8,
    attributes: {
      gender: "unisex", use: "walking", waterproof: true, width: "regular",
      features: ["waterproof", "reflective", "commuting"],
    },
  },
  {
    key: "vantor-everyday-walk",
    title: "Vantor Everyday Walking Shoes",
    brand: "Vantor",
    category: "Walking Shoes",
    description:
      "Plain, comfortable, inexpensive walking shoe. Mesh upper, EVA midsole, no story attached.",
    priceMinor: 199900,
    colors: ["black", "white", "grey"],
    merchants: ["budget-bazaar"],
    demand: 13,
    attributes: {
      gender: "unisex", use: "walking", width: "regular", weightGrams: 285,
      features: ["budget", "everyday", "lightweight"],
    },
  },

  // --------------------------------------------------------- kids
  {
    key: "vantor-sprout-kids",
    title: "Vantor Sprout Kids' Running Shoes",
    brand: "Vantor",
    category: "Kids Shoes",
    description:
      "Hook-and-loop kids' running shoe that a five-year-old can fasten alone. Washable upper, non-marking sole.",
    priceMinor: 149900,
    colors: ["blue", "pink", "green"],
    sizes: ["10C", "11C", "12C", "13C", "1Y", "2Y"],
    merchants: ["budget-bazaar", "shoe-locker"],
    demand: 10,
    attributes: {
      gender: "kids", use: "school", closure: "hook and loop", width: "regular",
      features: ["easy fasten", "washable", "non-marking"],
    },
  },
  {
    key: "solene-scholar-kids",
    title: "Solene Scholar Kids' School Shoes",
    brand: "Solene",
    category: "Kids Shoes",
    description:
      "Black leather school shoe with a scuff-resistant toe and a padded ankle. Survives a term, usually.",
    priceMinor: 229900,
    colors: ["black"],
    sizes: ["10C", "11C", "12C", "13C", "1Y", "2Y", "3Y"],
    merchants: ["shoe-locker", "oxford-and-last"],
    demand: 9,
    attributes: {
      gender: "kids", use: "school", upper: "leather", width: "wide",
      features: ["scuff resistant", "school uniform", "padded ankle"],
    },
  },

  // -------------------------------------------------------- sandals
  {
    key: "peak-trailsandal",
    title: "Peak Trail Sport Sandals",
    brand: "Peak",
    category: "Sandals",
    description:
      "Adjustable strap sandal with a grippy lugged sole for river crossings and campsite wear.",
    priceMinor: 349900,
    colors: ["black", "olive"],
    merchants: ["peak-gear", "budget-bazaar"],
    demand: 7,
    attributes: {
      gender: "unisex", use: "outdoor", closure: "adjustable straps", quickDry: true,
      width: "regular", features: ["quick drying", "grippy sole", "adjustable"],
    },
  },
  {
    key: "solene-linen-slide",
    title: "Solene Linen Slide Sandals",
    brand: "Solene",
    category: "Sandals",
    description:
      "Moulded footbed slide with a linen-wrapped strap. For the ten metres between the pool and the sun lounger.",
    priceMinor: 159900,
    colors: ["sand", "black", "white"],
    merchants: ["urban-outfit-co", "budget-bazaar"],
    demand: 9,
    attributes: {
      gender: "unisex", use: "casual", closure: "slide", width: "regular",
      features: ["poolside", "moulded footbed", "summer"],
    },
  },
];

export const SHOE_PRODUCTS: ProductTemplate[] = SHOES.map((s) => ({
  key: s.key,
  title: s.title,
  brand: s.brand,
  category: s.category,
  description: s.description,
  attributes: s.attributes,
  basePriceMinor: s.priceMinor,
  axes: [
    { name: "size", values: s.sizes ?? SHOE_SIZES },
    { name: "color", values: s.colors },
  ],
  merchants: s.merchants,
  demand: s.demand,
}));

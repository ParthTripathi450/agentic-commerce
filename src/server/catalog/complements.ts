/**
 * Which categories genuinely go WITH which.
 *
 * Cross-sell was falling back to embedding similarity, which returns more of
 * the same thing — offering another pair of formal shoes to someone who just
 * bought formal shoes. Similarity answers "what else is like this?", and after
 * a purchase that is the wrong question. The right one is "what does this
 * person now need?", and those are different categories by definition.
 *
 * Co-purchase from real orders is the better source and is used first, but it
 * is far too sparse to cover a 57-category catalogue: 136 of 5,289 orders hold
 * more than one item, and the pairs that exist cover only Activewear and
 * Running Shoes. This map is the honest stand-in — stated domain knowledge,
 * not a statistic dressed up as one — and it is also what seeds realistic
 * multi-item baskets so the co-purchase data can eventually replace it.
 */

export const COMPLEMENTS: Record<string, string[]> = {
  // Footwear → what you wear with it, and what keeps it going.
  "Running Shoes": ["Socks", "Activewear", "Base Layers", "T-Shirts", "Fitness Accessories"],
  "Trail Shoes": ["Socks", "Base Layers", "Outdoor Gear", "Backpacks", "Jackets"],
  "Court Shoes": ["Socks", "Activewear", "T-Shirts", "Fitness Accessories"],
  "Training Shoes": ["Activewear", "Fitness Accessories", "T-Shirts", "Socks"],
  "Walking Shoes": ["Socks", "Trousers", "Jackets", "Backpacks"],
  "Hiking Boots": ["Socks", "Outdoor Gear", "Backpacks", "Jackets", "Base Layers"],
  "Formal Shoes": ["Shirts", "Suits", "Trousers", "Socks", "Accessories"],
  Sneakers: ["T-Shirts", "Jeans", "Socks", "Hoodies"],
  "Football Boots": ["Socks", "Activewear", "Fitness Accessories"],
  "Cricket Shoes": ["Socks", "Activewear"],
  "Basketball Shoes": ["Socks", "Activewear", "T-Shirts"],
  "Kids Shoes": ["Socks", "T-Shirts"],
  Sandals: ["Bath Linen", "T-Shirts", "Drinkware"],

  // Apparel → the layers and footwear around it.
  "T-Shirts": ["Hoodies", "Jeans", "Trousers", "Sneakers", "Activewear"],
  Shirts: ["Trousers", "Suits", "Formal Shoes", "Accessories"],
  Hoodies: ["T-Shirts", "Jeans", "Sneakers", "Trousers"],
  Knitwear: ["Shirts", "Trousers", "Coats", "Formal Shoes"],
  Jackets: ["Base Layers", "Knitwear", "Outdoor Gear", "Hiking Boots"],
  Coats: ["Knitwear", "Shirts", "Accessories", "Formal Shoes"],
  "Base Layers": ["Jackets", "Socks", "Outdoor Gear", "Trail Shoes"],
  Jeans: ["T-Shirts", "Sneakers", "Hoodies", "Shirts"],
  Trousers: ["Shirts", "Formal Shoes", "Knitwear", "Accessories"],
  Activewear: ["Running Shoes", "Socks", "T-Shirts", "Fitness Accessories"],
  Dresses: ["Accessories", "Coats", "Formal Shoes"],
  Suits: ["Shirts", "Formal Shoes", "Accessories"],
  Socks: ["Running Shoes", "Formal Shoes", "Sneakers", "Hiking Boots"],
  Accessories: ["Coats", "Knitwear", "Shirts"],

  // Everything else.
  Headphones: ["Earbuds", "Speakers", "Backpacks"],
  Earbuds: ["Activewear", "Running Shoes", "Speakers"],
  Speakers: ["Outdoor Gear", "Drinkware", "Headphones"],
  Backpacks: ["Drinkware", "Outdoor Gear", "Base Layers", "Jackets"],
  Luggage: ["Accessories", "Drinkware", "Backpacks"],
  Cookware: ["Kitchen Knives", "Kitchen Appliances", "Drinkware"],
  "Kitchen Knives": ["Cookware", "Kitchen Appliances"],
  "Kitchen Appliances": ["Cookware", "Kitchen Knives", "Drinkware"],
  Drinkware: ["Backpacks", "Outdoor Gear", "Cookware"],
  "Bath Linen": ["Bedding", "Bath Linen"],
  Bedding: ["Bath Linen", "Accessories"],
  "Fitness Accessories": ["Activewear", "Training Shoes", "Drinkware", "T-Shirts"],
  "Outdoor Gear": ["Hiking Boots", "Backpacks", "Jackets", "Base Layers", "Drinkware"],
  Stationery: ["Backpacks", "Accessories"],
  Storage: ["Bedding", "Bath Linen"],
  "Pet Furniture": ["Storage"],
  Apparel: ["Sneakers", "Running Shoes", "Socks"],
};

/**
 * Categories that go with this one, never including itself.
 *
 * The self-exclusion is the whole point: suggesting another pair of shoes to
 * someone who has just bought shoes is the bug this replaces.
 */
export function complementsFor(category: string): string[] {
  return (COMPLEMENTS[category] ?? []).filter((c) => c !== category);
}

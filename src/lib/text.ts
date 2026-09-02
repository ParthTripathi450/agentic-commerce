/**
 * Normalises typography in model output.
 *
 * Models emit narrow no-break spaces, non-breaking hyphens and similar
 * lookalikes ("Velocity Run 3"). They render fine but break exact string
 * matching against catalog data, so they are folded to ASCII equivalents at the
 * point the text enters the system. Em dashes and ellipses are legitimate
 * punctuation and are left alone.
 */
export function normalizeTypography(input: string): string {
  return input
    .replace(/[     ]/g, " ") // exotic spaces → space
    .replace(/[‐‑]/g, "-") // non-breaking hyphens → hyphen
    .replace(/[‘’]/g, "'") // smart single quotes
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

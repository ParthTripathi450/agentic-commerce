/**
 * All monetary amounts are integers in the currency's MINOR unit (paise for
 * INR). Nothing in this codebase stores money as a float.
 */

export const MINOR_PER_MAJOR = 100;

export function toMinor(major: number): number {
  return Math.round(major * MINOR_PER_MAJOR);
}

export function toMajor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

const symbols: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function formatMoney(minor: number, currency = "INR"): string {
  const symbol = symbols[currency] ?? `${currency} `;
  const major = toMajor(minor);
  const formatted = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
  return `${symbol}${formatted}`;
}

/** Applies basis points (1 bp = 0.01%) to a minor-unit amount. */
export function applyBp(minor: number, bp: number): number {
  return Math.round((minor * bp) / 10_000);
}

export function bpToPercent(bp: number): number {
  return bp / 100;
}

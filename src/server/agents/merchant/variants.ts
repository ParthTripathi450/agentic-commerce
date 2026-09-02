/**
 * Variant expansion.
 *
 * Kept in its own module with no auth or database imports so it can be tested
 * directly — importing the "use server" action file pulls in next-auth, which
 * does not load under Vitest.
 */

/** Cap on generated variants, so a 10×5 axis pair cannot create 50 SKUs by accident. */
export const MAX_VARIANTS = 24;

export type ComboResult =
  | { ok: true; combos: Record<string, string>[] }
  | { ok: false; count: number };

/**
 * Cartesian product of the option values the merchant kept.
 *
 * A size×colour pair silently generating 50 SKUs is the kind of mistake that is
 * tedious to undo by hand, so the caller is asked to trim instead.
 */
export function buildVariantCombos(
  axes: Record<string, string[]>,
  max = MAX_VARIANTS,
): ComboResult {
  let combos: Record<string, string>[] = [{}];
  for (const [axis, values] of Object.entries(axes)) {
    const kept = values.filter(Boolean);
    if (kept.length === 0) continue;
    combos = combos.flatMap((combo) => kept.map((v) => ({ ...combo, [axis]: v })));
  }
  return combos.length > max ? { ok: false, count: combos.length } : { ok: true, combos };
}

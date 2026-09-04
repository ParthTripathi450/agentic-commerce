import { DEFAULT_AXES, type AxisWeights } from "@/server/agents/customer/affinity";
import { evaluateForYou, prepareCases, type PreparedCases } from "./for-you-eval";

/**
 * Fits the affinity axis weights instead of arguing about them.
 *
 * The six numbers in `DEFAULT_AXES` — how much brand counts against category,
 * quality, merchant, colour and budget — were typed by hand. This searches for
 * better ones against the for-you eval, which is the whole difference between a
 * profile that is asserted to be good and one that is measured.
 *
 * **Cross-validated, because six parameters and thirty-five shoppers is a ratio
 * that memorises.** Weights are chosen on training folds and scored on shoppers
 * the search never saw. Both numbers are reported: a large gap between them is
 * the search fitting individuals rather than learning taste, and it is the
 * single most important thing to look at here.
 *
 * **Coordinate descent, not gradient descent.** The objective is MRR over a
 * ranking — a step function, not differentiable — so there is no gradient to
 * follow. Sweeping one axis at a time over a small grid is the honest method
 * for six parameters, and it runs in seconds on a laptop, which is the other
 * constraint (§1).
 *
 * **Nothing is applied automatically.** These orders are generated, so a fitted
 * set encodes the seed's habits rather than human taste. The fitter reports,
 * and a person decides whether the numbers deserve to ship.
 */

export type FitResult = {
  baseline: { train: number; test: number };
  fitted: { train: number; test: number };
  axes: AxisWeights;
  folds: number;
  shoppers: number;
  /** True when the gain survives on shoppers the search never saw. */
  generalises: boolean;
};

const AXIS_KEYS: (keyof AxisWeights)[] = [
  "brand",
  "category",
  "quality",
  "merchant",
  "colour",
  "budget",
];

/** The values each axis is tried at. Coarse on purpose — see the note on overfitting. */
const GRID = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.3];

/** Splits shoppers into k folds deterministically, so a re-run reproduces the result. */
function foldsOf(userIds: string[], k: number): string[][] {
  const sorted = [...userIds].sort();
  const buckets: string[][] = Array.from({ length: k }, () => []);
  sorted.forEach((id, i) => buckets[i % k].push(id));
  return buckets;
}

async function mrrFor(
  prepared: PreparedCases,
  axes: AxisWeights,
  only: Set<string>,
): Promise<number> {
  const result = await evaluateForYou({ preloaded: prepared, axes, only });
  return result.affinity.mrr;
}

/**
 * One pass of coordinate descent: sweep each axis, keep the best value found.
 *
 * Repeated until a full sweep changes nothing, which for six coarse axes is
 * typically two or three passes.
 */
async function descend(
  prepared: PreparedCases,
  train: Set<string>,
  start: AxisWeights,
  maxPasses = 4,
): Promise<AxisWeights> {
  let best = { ...start };
  let bestScore = await mrrFor(prepared, best, train);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (const key of AXIS_KEYS) {
      for (const value of GRID) {
        if (value === best[key]) continue;
        const candidate = { ...best, [key]: value };
        const score = await mrrFor(prepared, candidate, train);
        if (score > bestScore + 1e-9) {
          best = candidate;
          bestScore = score;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return best;
}

export async function fitAxisWeights(options: { folds?: number } = {}): Promise<FitResult> {
  const k = options.folds ?? 5;
  const prepared = await prepareCases();
  const usable = prepared.cases.filter((c) => prepared.tastes.has(c.userId)).map((c) => c.userId);

  const folds = foldsOf(usable, k);
  const all = new Set(usable);

  let baselineTest = 0;
  let fittedTest = 0;
  const perFoldAxes: AxisWeights[] = [];

  for (const heldOut of folds) {
    const test = new Set(heldOut);
    const train = new Set(usable.filter((id) => !test.has(id)));
    if (train.size === 0 || test.size === 0) continue;

    const tuned = await descend(prepared, train, DEFAULT_AXES);
    perFoldAxes.push(tuned);

    baselineTest += await mrrFor(prepared, DEFAULT_AXES, test);
    fittedTest += await mrrFor(prepared, tuned, test);
  }

  const usedFolds = perFoldAxes.length || 1;

  /*
   * The reported weights are the AVERAGE across folds, not the best single
   * fold.
   *
   * Picking the fold that scored highest would be choosing the luckiest split
   * and calling it a result — the same mistake as reporting a training score.
   */
  const axes = Object.fromEntries(
    AXIS_KEYS.map((key) => [
      key,
      Number((perFoldAxes.reduce((sum, a) => sum + a[key], 0) / usedFolds).toFixed(3)),
    ]),
  ) as AxisWeights;

  return {
    baseline: {
      train: await mrrFor(prepared, DEFAULT_AXES, all),
      test: Number((baselineTest / usedFolds).toFixed(4)),
    },
    fitted: {
      train: await mrrFor(prepared, axes, all),
      test: Number((fittedTest / usedFolds).toFixed(4)),
    },
    axes,
    folds: usedFolds,
    shoppers: usable.length,
    generalises: fittedTest / usedFolds > baselineTest / usedFolds,
  };
}

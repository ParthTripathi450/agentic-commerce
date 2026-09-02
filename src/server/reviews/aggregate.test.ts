import { describe, expect, it } from "vitest";

/**
 * The running-average arithmetic used by submitReviewAction.
 *
 * Extracted here as pure functions mirroring the SQL, because getting this
 * wrong silently corrupts every product's rating — and rating is 0.20 of the
 * ranking weight, so a corrupted aggregate reorders search results.
 */
function addReview(ratingBp: number, count: number, newRating: number) {
  const nextCount = count + 1;
  return {
    ratingBp: Math.round((ratingBp * count + newRating) / nextCount),
    ratingCount: nextCount,
  };
}

function editReview(ratingBp: number, count: number, delta: number) {
  return {
    ratingBp: Math.round((ratingBp * count + delta) / Math.max(count, 1)),
    ratingCount: count,
  };
}

describe("rating aggregate", () => {
  it("moves the average toward a new review", () => {
    // 4.0 from 10 reviews, then a 5.0 arrives.
    const result = addReview(4000, 10, 5000);
    expect(result.ratingCount).toBe(11);
    expect(result.ratingBp).toBe(4091); // (40000 + 5000) / 11
  });

  it("barely moves a heavily-reviewed product", () => {
    const before = 4600;
    const after = addReview(before, 900, 1000);
    // One 1-star among 900 reviews should shift the average by a hair.
    expect(Math.abs(after.ratingBp - before)).toBeLessThan(10);
  });

  it("seeds the first review as the average itself", () => {
    const result = addReview(0, 0, 4500);
    expect(result.ratingBp).toBe(4500);
    expect(result.ratingCount).toBe(1);
  });

  it("an edit shifts the mean without changing the count", () => {
    const start = addReview(4000, 10, 5000); // 4091 from 11
    // Reviewer changes their 5.0 to a 3.0: delta of -2000.
    const edited = editReview(start.ratingBp, start.ratingCount, -2000);
    expect(edited.ratingCount).toBe(11); // unchanged
    expect(edited.ratingBp).toBeLessThan(start.ratingBp);
  });

  it("never produces a rating outside the 1–5 range for valid input", () => {
    let state = { ratingBp: 0, ratingCount: 0 };
    for (const rating of [1000, 5000, 3000, 4500, 2000, 5000]) {
      state = addReview(state.ratingBp, state.ratingCount, rating);
      expect(state.ratingBp).toBeGreaterThanOrEqual(1000);
      expect(state.ratingBp).toBeLessThanOrEqual(5000);
    }
    expect(state.ratingCount).toBe(6);
  });
});

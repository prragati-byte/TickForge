import { describe, expect, it } from "vitest";
import { maxDrawdownPct, pctOfCents, periodReturnPct, scenarioOutcomes, volatilityAxis } from "./behavior";

describe("periodReturnPct (features 11 and 14)", () => {
  it("is last over first, in percent", () => {
    expect(periodReturnPct([100, 90, 110])).toBeCloseTo(10);
    expect(periodReturnPct([200, 100])).toBeCloseTo(-50);
  });
  it("needs at least two prices", () => {
    expect(periodReturnPct([100])).toBeNull();
    expect(periodReturnPct([])).toBeNull();
  });
});

describe("maxDrawdownPct (feature 14)", () => {
  it("measures the biggest fall from an earlier peak", () => {
    // peak 120, then 90: (90 - 120) / 120 = -25%. The later 100 -> 95 fall is smaller.
    expect(maxDrawdownPct([100, 120, 90, 100, 95])).toBeCloseTo(-25);
  });
  it("is 0 when the price only rises", () => {
    expect(maxDrawdownPct([1, 2, 3])).toBe(0);
  });
});

describe("volatilityAxis (feature 12)", () => {
  it("is wider than the data when the stock is calm", () => {
    const calm = [100, 101, 100, 101, 100, 101];
    const axis = volatilityAxis(calm);
    expect(axis.min).toBeLessThan(95);
    expect(axis.max).toBeGreaterThan(105);
  });

  it("never clips prices that leave the volatility band", () => {
    const spike = [100, 100, 100, 100, 100, 160];
    const axis = volatilityAxis(spike);
    expect(axis.min).toBeLessThanOrEqual(100);
    expect(axis.max).toBeGreaterThanOrEqual(160);
  });

  it("falls back to the data range when there is too little data", () => {
    expect(volatilityAxis([100, 105])).toEqual({ min: 100, max: 105 });
  });
});

describe("scenarioOutcomes (feature 13)", () => {
  // 31 prices rising exactly 1% a day, so every 5-day return is 1.01^5 - 1.
  const rising = Array.from({ length: 31 }, (_, i) => 100 * 1.01 ** i);
  const fiveDay = (1.01 ** 5 - 1) * 100;

  it("reports the same gain for every window of a steady rise", () => {
    const s = scenarioOutcomes(rising, 5, "BUY");
    expect(s).not.toBeNull();
    expect(s!.windows).toBe(26);
    expect(s!.median).toBeCloseTo(fiveDay, 6);
    expect(s!.p5).toBeCloseTo(fiveDay, 6);
    expect(s!.p95).toBeCloseTo(fiveDay, 6);
    expect(s!.chanceOfLoss).toBe(0);
  });

  it("flips the sign for a sell", () => {
    const s = scenarioOutcomes(rising, 5, "SELL");
    expect(s!.median).toBeCloseTo(-fiveDay, 6);
    expect(s!.chanceOfLoss).toBe(100);
  });

  it("counts every window in the histogram and orders the percentiles", () => {
    const wobble = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 3));
    const s = scenarioOutcomes(wobble, 3, "BUY")!;
    expect(s.bins.reduce((a, b) => a + b, 0)).toBe(s.windows);
    expect(s.p5).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.p95);
    expect(s.minPct).toBeLessThanOrEqual(s.p5);
  });

  it("returns null when the history is too short", () => {
    expect(scenarioOutcomes([100, 101, 102], 1, "BUY")).toBeNull();
    expect(scenarioOutcomes(rising.slice(0, 8), 5, "BUY")).toBeNull();
  });
});

describe("pctOfCents", () => {
  it("applies a percent to an order value and rounds to a cent", () => {
    expect(pctOfCents(10, 1_895_000)).toBe(189_500);
    expect(pctOfCents(-2.5, 10_000)).toBe(-250);
    expect(pctOfCents(0.333, 100)).toBe(0);
  });
});

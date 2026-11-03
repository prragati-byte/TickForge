// Calculations behind the behaviour-aware features. All of them use real price history
// (closing prices from the market-data service) and plain arithmetic, so they can be checked by hand.

/** Return over the whole series, in percent. null if there are fewer than 2 prices. */
export function periodReturnPct(closes: number[]): number | null {
  if (closes.length < 2 || closes[0] === 0) return null;
  return ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
}

/** Largest peak-to-trough fall, in percent (0 or negative). */
export function maxDrawdownPct(closes: number[]): number {
  let peak = closes[0] ?? 0;
  let worst = 0;
  for (const price of closes) {
    if (price > peak) peak = price;
    if (peak > 0) worst = Math.min(worst, ((price - peak) / peak) * 100);
  }
  return worst;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

function barReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

/**
 * Y-axis range scaled from the stock's own volatility (feature 12).
 *
 * Over n bars a price typically wanders about sigma * sqrt(n) (sigma = std dev of bar-to-bar returns).
 * The axis covers three of those either side of the average price, so an ordinary wiggle looks like
 * one. The data is never clipped: if the prices go outside that band, the axis grows to fit them.
 */
export function volatilityAxis(closes: number[]): { min: number; max: number } {
  const dataMin = Math.min(...closes);
  const dataMax = Math.max(...closes);
  const returns = barReturns(closes);
  if (returns.length < 2) return { min: dataMin, max: dataMax };
  const centre = closes.reduce((a, b) => a + b, 0) / closes.length;
  const half = 3 * stdev(returns) * Math.sqrt(returns.length) * centre;
  return { min: Math.min(dataMin, centre - half), max: Math.max(dataMax, centre + half) };
}

export type Scenario = {
  windows: number; // how many past holding periods were looked at
  holdBars: number;
  p5: number; // percent return, 5% of past periods were worse than this
  median: number;
  p95: number;
  chanceOfLoss: number; // percent of past periods that lost money for this side
  bins: number[]; // histogram counts, worst return on the left
  minPct: number;
  maxPct: number;
};

function percentile(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * What happened to a position in this stock over every past holding period of `holdBars` bars (feature 13).
 * Returns are for the order's side: a SELL gains when the price falls.
 * null if the history is too short to say anything.
 */
export function scenarioOutcomes(closes: number[], holdBars: number, side: "BUY" | "SELL", binCount = 12): Scenario | null {
  const returns: number[] = [];
  for (let i = 0; i + holdBars < closes.length; i++) {
    if (closes[i] <= 0) continue;
    const r = (closes[i + holdBars] / closes[i] - 1) * 100;
    returns.push(side === "BUY" ? r : -r);
  }
  if (returns.length < 10) return null;

  returns.sort((a, b) => a - b);
  const minPct = returns[0];
  const maxPct = returns[returns.length - 1];
  const width = (maxPct - minPct) / binCount || 1;
  const bins = new Array<number>(binCount).fill(0);
  for (const r of returns) bins[Math.min(binCount - 1, Math.floor((r - minPct) / width))] += 1;

  return {
    windows: returns.length,
    holdBars,
    p5: percentile(returns, 0.05),
    median: percentile(returns, 0.5),
    p95: percentile(returns, 0.95),
    chanceOfLoss: (returns.filter((r) => r < 0).length / returns.length) * 100,
    bins,
    minPct,
    maxPct,
  };
}

/** Percent return applied to an order value in cents, rounded to a whole cent. */
export const pctOfCents = (pct: number, cents: number) => Math.round((pct / 100) * cents);

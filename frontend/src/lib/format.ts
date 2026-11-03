// Number formatting. Engine and exchange-api prices are integer cents; only the UI turns them into dollars.

const group = (n: number) => n.toLocaleString("en-US");

/** 18950 -> "$189.50", -5 -> "-$0.05". Works on the integer, so there is no floating-point rounding. */
export function dollars(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}$${group(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** Like dollars() but with an explicit "+" for gains: +$12.00. */
export function signedDollars(cents: number): string {
  return cents > 0 ? `+${dollars(cents)}` : dollars(cents);
}

/** "189.5" or "189.50" typed by a person -> 18950 cents. Returns null for anything that is not a positive price. */
export function parseCents(text: string): number | null {
  const match = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

/** 1500 -> "1.5 ms", 7 -> "7.0 µs". */
export function fmtUs(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(1)} s`;
  if (us >= 1000) return `${(us / 1000).toFixed(us >= 10_000 ? 0 : 1)} ms`;
  return `${us < 10 ? us.toFixed(1) : us.toFixed(0)} µs`;
}

export const fmtInt = (n: number) => group(Math.round(n));

export const fmtPct = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

export const DASH = "–";

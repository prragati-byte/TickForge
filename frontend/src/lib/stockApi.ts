export type PricePoint = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StockSnapshot = {
  symbol: string;
  currency: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  marketState: string;
  updatedAt: string;
  history: PricePoint[];
};

/** The ranges the market-data API accepts for quotes, each with the one bar size it allows. */
export type QuoteRange = "1d" | "1mo" | "1y";
const QUOTE_INTERVAL: Record<QuoteRange, string> = { "1d": "5m", "1mo": "1d", "1y": "1d" };

/** network = API unreachable, http = API answered with an error, contract = unexpected payload */
export class StockApiError extends Error {
  kind: "network" | "http" | "contract";
  constructor(kind: "network" | "http" | "contract", message: string) {
    super(message);
    this.kind = kind;
  }
}

const API_URL = (import.meta.env.VITE_STOCK_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new StockApiError("network", "Unable to reach the stock API");
  }

  if (!response.ok) {
    let detail = `Stock API returned ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (isObject(body) && isString(body.detail)) detail = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new StockApiError("http", detail);
  }

  const data: unknown = await response.json();
  if (!isObject(data)) throw new StockApiError("contract", "Stock API returned invalid JSON");
  if (isString(data.error)) throw new StockApiError("http", data.error);
  return data;
}

export async function getStockSnapshot(symbol: string, range: QuoteRange = "1d", signal?: AbortSignal): Promise<StockSnapshot> {
  const url = `${API_URL}/api/stocks/${encodeURIComponent(symbol)}?range=${range}&interval=${QUOTE_INTERVAL[range]}`;
  const data = (await requestJson(url, signal)) as Partial<StockSnapshot>;

  if (
    !isString(data.symbol) ||
    !isString(data.currency) ||
    !isNumber(data.price) ||
    !isNumber(data.previousClose) ||
    !isNumber(data.change) ||
    !isNumber(data.changePercent) ||
    !isNumber(data.volume) ||
    !isString(data.marketState) ||
    !isString(data.updatedAt) ||
    !Array.isArray(data.history)
  ) {
    throw new StockApiError("contract", "Stock API response does not match the TickForge contract");
  }

  const history = data.history.filter(
    (point): point is PricePoint =>
      !!point &&
      isString(point.timestamp) &&
      isNumber(point.open) &&
      isNumber(point.high) &&
      isNumber(point.low) &&
      isNumber(point.close) &&
      isNumber(point.volume),
  );

  if (history.length === 0) throw new StockApiError("contract", "Stock API returned no valid OHLCV history");
  return { ...data, history } as StockSnapshot;
}

// ---------------------------------------------------------------------------------------------
// Journey (GET /api/stocks/{symbol}/journey?range=...)
// ---------------------------------------------------------------------------------------------

export type JourneyRange = "1d" | "5d" | "1mo" | "6mo" | "1y" | "max";

export type JourneyStamp = { time: string; label: string };
export type JourneyPoint = JourneyStamp & { price: number };
export type JourneySwing = { percent: number; start: JourneyPoint; end: JourneyPoint };
export type JourneyEvent = {
  kind: "open" | "rise" | "fall" | "high" | "low" | "volume" | "close" | "split";
  time: string;
  endTime?: string;
  label: string;
  text: string;
};
export type JourneyBar = PricePoint & { label: string };

/** "Since listing" block, only present for range=max. */
export type JourneyLongTerm = {
  firstTraded: JourneyPoint;
  yearsListed: number;
  totalReturnPercent: number;
  cagrPercent: number | null;
  growthOf1000: number;
  allTimeHigh: JourneyPoint;
  allTimeLow: JourneyPoint;
  fromAllTimeHighPercent: number;
  years: { year: number; percent: number; partial: boolean }[];
  bestYear: { year: number; percent: number; partial: boolean } | null;
  worstYear: { year: number; percent: number; partial: boolean } | null;
  drawdowns: {
    percent: number;
    start: JourneyPoint;
    bottom: JourneyPoint;
    recovered: boolean;
    recoveredAt: JourneyStamp | null;
    daysToBottom: number;
    daysToRecover: number | null;
  }[];
  splits: (JourneyStamp & { barTime: string; ratio: number; text: string })[];
  dividends: { count: number; totalPerShare: number; last: (JourneyStamp & { amount: number }) | null; byYear: { year: number; amount: number }[] };
  notes: string[];
};

export type JourneyData = {
  symbol: string;
  range: JourneyRange;
  interval: string;
  timezone: string;
  currency: string;
  barCount: number;
  periodStart: JourneyStamp;
  periodEnd: JourneyStamp;
  open: number;
  close: number;
  change: number;
  changePercent: number;
  high: JourneyPoint;
  low: JourneyPoint;
  rangePercent: number;
  gapPercent: number | null;
  maxDrawdown: (JourneySwing & { recovered: boolean; recoveredAt: JourneyStamp | null }) | null;
  maxRunUp: JourneySwing | null;
  legs: (JourneySwing & { direction: "rise" | "fall" })[];
  biggestBar: { up: (JourneyStamp & { percent: number }) | null; down: (JourneyStamp & { percent: number }) | null };
  volume: { total: number; averagePerBar: number; spikes: (JourneyStamp & { volume: number; multiple: number })[] };
  vwap: number | null;
  volatility: { perBarPercent: number | null; barLabel: string };
  bars: { up: number; down: number; flat: number };
  yearHigh: number | null;
  yearLow: number | null;
  timeline: JourneyEvent[];
  history: JourneyBar[];
  longTerm: JourneyLongTerm | null;
  storyMethod: string;
  dataNote: string;
  updatedAt: string;
};

const EVENT_KINDS = ["open", "rise", "fall", "high", "low", "volume", "close", "split"];
const bad = (what: string) => new StockApiError("contract", `Journey response is missing or invalid: ${what}`);

function stamp(value: unknown, what: string): JourneyStamp {
  if (!isObject(value) || !isString(value.time) || !isString(value.label)) throw bad(what);
  return { time: value.time, label: value.label };
}
function point(value: unknown, what: string): JourneyPoint {
  if (!isObject(value) || !isNumber(value.price)) throw bad(what);
  return { ...stamp(value, what), price: value.price };
}
function swing(value: unknown, what: string): JourneySwing {
  if (!isObject(value) || !isNumber(value.percent)) throw bad(what);
  return { percent: value.percent, start: point(value.start, `${what}.start`), end: point(value.end, `${what}.end`) };
}
const orNull = <T,>(value: unknown, parse: (v: unknown) => T): T | null => (value === null || value === undefined ? null : parse(value));
const numOrNull = (value: unknown): number | null => (isNumber(value) ? value : null);
const list = <T,>(value: unknown, what: string, parse: (v: unknown, what: string) => T): T[] => {
  if (!Array.isArray(value)) throw bad(what);
  return value.map((item, i) => parse(item, `${what}[${i}]`));
};

function yearReturn(value: unknown, what: string) {
  if (!isObject(value) || !isNumber(value.year) || !isNumber(value.percent) || typeof value.partial !== "boolean") throw bad(what);
  return { year: value.year, percent: value.percent, partial: value.partial };
}

export function parseLongTerm(value: unknown): JourneyLongTerm {
  if (!isObject(value)) throw bad("longTerm");
  for (const key of ["yearsListed", "totalReturnPercent", "growthOf1000", "fromAllTimeHighPercent"] as const) {
    if (!isNumber(value[key])) throw bad(`longTerm.${key}`);
  }
  const div = value.dividends;
  if (!isObject(div) || !isNumber(div.count) || !isNumber(div.totalPerShare)) throw bad("longTerm.dividends");
  return {
    firstTraded: point(value.firstTraded, "longTerm.firstTraded"),
    yearsListed: value.yearsListed as number,
    totalReturnPercent: value.totalReturnPercent as number,
    cagrPercent: numOrNull(value.cagrPercent),
    growthOf1000: value.growthOf1000 as number,
    allTimeHigh: point(value.allTimeHigh, "longTerm.allTimeHigh"),
    allTimeLow: point(value.allTimeLow, "longTerm.allTimeLow"),
    fromAllTimeHighPercent: value.fromAllTimeHighPercent as number,
    years: list(value.years, "longTerm.years", yearReturn),
    bestYear: orNull(value.bestYear, (v) => yearReturn(v, "longTerm.bestYear")),
    worstYear: orNull(value.worstYear, (v) => yearReturn(v, "longTerm.worstYear")),
    drawdowns: list(value.drawdowns, "longTerm.drawdowns", (d, what) => {
      if (!isObject(d) || !isNumber(d.percent) || !isNumber(d.daysToBottom)) throw bad(what);
      return {
        percent: d.percent,
        start: point(d.start, `${what}.start`),
        bottom: point(d.bottom, `${what}.bottom`),
        recovered: d.recovered === true,
        recoveredAt: orNull(d.recoveredAt, (s) => stamp(s, `${what}.recoveredAt`)),
        daysToBottom: d.daysToBottom,
        daysToRecover: numOrNull(d.daysToRecover),
      };
    }),
    splits: list(value.splits, "longTerm.splits", (s, what) => {
      if (!isObject(s) || !isString(s.barTime) || !isNumber(s.ratio) || !isString(s.text)) throw bad(what);
      return { ...stamp(s, what), barTime: s.barTime, ratio: s.ratio, text: s.text };
    }),
    dividends: {
      count: div.count,
      totalPerShare: div.totalPerShare,
      last: orNull(div.last, (l) => {
        if (!isObject(l) || !isNumber(l.amount)) throw bad("longTerm.dividends.last");
        return { ...stamp(l, "longTerm.dividends.last"), amount: l.amount };
      }),
      byYear: list(div.byYear, "longTerm.dividends.byYear", (y, what) => {
        if (!isObject(y) || !isNumber(y.year) || !isNumber(y.amount)) throw bad(what);
        return { year: y.year, amount: y.amount };
      }),
    },
    notes: list(value.notes, "longTerm.notes", (n, what) => {
      if (!isString(n)) throw bad(what);
      return n;
    }),
  };
}

export function parseJourney(data: unknown, symbol: string, range: JourneyRange): JourneyData {
  if (!isObject(data)) throw bad("body");
  if (!isString(data.symbol) || data.symbol.toUpperCase() !== symbol.toUpperCase()) throw bad("symbol does not match the request");
  if (data.range !== range) throw bad("range does not match the request");
  for (const key of ["interval", "timezone", "currency", "updatedAt", "storyMethod", "dataNote"] as const) {
    if (!isString(data[key])) throw bad(key);
  }
  for (const key of ["barCount", "open", "close", "change", "changePercent", "rangePercent"] as const) {
    if (!isNumber(data[key])) throw bad(key);
  }

  if (!Array.isArray(data.history) || data.history.length === 0) throw bad("history");
  const history: JourneyBar[] = data.history.map((bar, i) => {
    if (
      !isObject(bar) ||
      !isString(bar.timestamp) ||
      !isString(bar.label) ||
      !isNumber(bar.open) ||
      !isNumber(bar.high) ||
      !isNumber(bar.low) ||
      !isNumber(bar.close) ||
      !isNumber(bar.volume)
    ) {
      throw bad(`history[${i}]`);
    }
    return { timestamp: bar.timestamp, label: bar.label, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  });

  if (!Array.isArray(data.timeline)) throw bad("timeline");
  const timeline: JourneyEvent[] = data.timeline.map((event, i) => {
    if (!isObject(event) || !isString(event.kind) || !EVENT_KINDS.includes(event.kind) || !isString(event.time) || !isString(event.label) || !isString(event.text)) {
      throw bad(`timeline[${i}]`);
    }
    return { kind: event.kind as JourneyEvent["kind"], time: event.time, label: event.label, text: event.text, ...(isString(event.endTime) ? { endTime: event.endTime } : {}) };
  });

  const volume = data.volume;
  if (!isObject(volume) || !isNumber(volume.total) || !isNumber(volume.averagePerBar) || !Array.isArray(volume.spikes)) throw bad("volume");
  const bars = data.bars;
  if (!isObject(bars) || !isNumber(bars.up) || !isNumber(bars.down) || !isNumber(bars.flat)) throw bad("bars");
  const volatility = data.volatility;
  if (!isObject(volatility) || !isString(volatility.barLabel)) throw bad("volatility");
  const biggest = isObject(data.biggestBar) ? data.biggestBar : {};
  const barMove = (v: unknown) =>
    orNull(v, (x) => {
      if (!isObject(x) || !isNumber(x.percent)) throw bad("biggestBar");
      return { ...stamp(x, "biggestBar"), percent: x.percent };
    });

  return {
    symbol: data.symbol,
    range,
    interval: data.interval as string,
    timezone: data.timezone as string,
    currency: data.currency as string,
    barCount: data.barCount as number,
    periodStart: stamp(data.periodStart, "periodStart"),
    periodEnd: stamp(data.periodEnd, "periodEnd"),
    open: data.open as number,
    close: data.close as number,
    change: data.change as number,
    changePercent: data.changePercent as number,
    high: point(data.high, "high"),
    low: point(data.low, "low"),
    rangePercent: data.rangePercent as number,
    gapPercent: numOrNull(data.gapPercent),
    maxDrawdown: orNull(data.maxDrawdown, (v) => {
      const base = swing(v, "maxDrawdown");
      const x = v as Record<string, unknown>;
      return { ...base, recovered: x.recovered === true, recoveredAt: orNull(x.recoveredAt, (s) => stamp(s, "recoveredAt")) };
    }),
    maxRunUp: orNull(data.maxRunUp, (v) => swing(v, "maxRunUp")),
    legs: (Array.isArray(data.legs) ? data.legs : []).map((leg, i) => {
      const base = swing(leg, `legs[${i}]`);
      const direction = (leg as Record<string, unknown>).direction;
      if (direction !== "rise" && direction !== "fall") throw bad(`legs[${i}].direction`);
      return { ...base, direction };
    }),
    biggestBar: { up: barMove(biggest.up), down: barMove(biggest.down) },
    volume: {
      total: volume.total,
      averagePerBar: volume.averagePerBar,
      spikes: volume.spikes.map((s, i) => {
        if (!isObject(s) || !isNumber(s.volume) || !isNumber(s.multiple)) throw bad(`volume.spikes[${i}]`);
        return { ...stamp(s, `volume.spikes[${i}]`), volume: s.volume, multiple: s.multiple };
      }),
    },
    vwap: numOrNull(data.vwap),
    volatility: { perBarPercent: numOrNull(volatility.perBarPercent), barLabel: volatility.barLabel },
    bars: { up: bars.up, down: bars.down, flat: bars.flat },
    yearHigh: numOrNull(data.yearHigh),
    yearLow: numOrNull(data.yearLow),
    timeline,
    history,
    longTerm: range === "max" ? parseLongTerm(data.longTerm) : null,
    storyMethod: data.storyMethod as string,
    dataNote: data.dataNote as string,
    updatedAt: data.updatedAt as string,
  };
}

export async function getJourney(symbol: string, range: JourneyRange, signal?: AbortSignal): Promise<JourneyData> {
  const data = await requestJson(`${API_URL}/api/stocks/${encodeURIComponent(symbol)}/journey?range=${range}`, signal);
  return parseJourney(data, symbol, range);
}

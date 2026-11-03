import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getJourney, StockApiError, type JourneyData, type JourneyEvent, type JourneyLongTerm, type JourneyRange } from "@/lib/stockApi";

const RANGES: { id: JourneyRange; label: string }[] = [
  { id: "1d", label: "1D" },
  { id: "5d", label: "5D" },
  { id: "1mo", label: "1M" },
  { id: "6mo", label: "6M" },
  { id: "1y", label: "1Y" },
];

const KIND_STYLE: Record<JourneyEvent["kind"], { dot: string; tag: string; name: string }> = {
  open: { dot: "bg-muted", tag: "text-muted", name: "OPEN" },
  rise: { dot: "bg-up", tag: "text-up", name: "RISE" },
  fall: { dot: "bg-down", tag: "text-down", name: "FALL" },
  high: { dot: "bg-up", tag: "text-up", name: "HIGH" },
  low: { dot: "bg-down", tag: "text-down", name: "LOW" },
  volume: { dot: "bg-accent", tag: "text-accent", name: "VOLUME" },
  close: { dot: "bg-accent", tag: "text-accent", name: "CLOSE" },
  split: { dot: "bg-accent", tag: "text-accent", name: "SPLIT" },
};

// Attributes that need a trade ledger. Yahoo does not say who bought or sold, so these stay empty on purpose.
const LEDGER_FIELDS = ["Bought", "Sold", "Net position", "Avg buy price", "Avg sell price", "Realized P&L", "Unrealized P&L", "Win rate", "Best trade", "Worst trade"];

// Same format as the story sentences written by the API: "$1,234.50" for USD, "1,234.50 INR" otherwise.
const money = (value: number, currency: string) => {
  const digits = Math.abs(value) < 1 ? 4 : 2; // split-adjusted early prices can be a few cents
  const text = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
};
const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const tone = (value: number) => (value >= 0 ? "text-up" : "text-down");
const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const DASH = "—";
// Split-adjusted prices from decades ago can be a few cents, so show more digits below $1.
const px = (value: number) => value.toFixed(Math.abs(value) < 1 ? 4 : 2);
const duration = (days: number) => (days >= 365 ? `${(days / 365.25).toFixed(1)} yrs` : `${days} days`);
const splitRatio = (ratio: number) => (ratio >= 1 ? `${ratio}:1` : `1:${Math.round(1 / ratio)}`);

type Focus = { from: string; to: string } | null;

function Tile({ label, value, sub, valueClass = "text-strong" }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="text-xs font-semibold text-faint">{label}</div>
      <div className={`mt-1.5 font-mono text-lg font-semibold leading-tight ${valueClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs leading-snug text-faint">{sub}</div>}
    </div>
  );
}

function JourneyChart({ data, focus, log }: { data: JourneyData; focus: Focus; log: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const bars = data.history;
  const n = bars.length;
  const indexOf = useMemo(() => new Map(bars.map((bar, i) => [bar.timestamp, i])), [bars]);
  const low = Math.min(...bars.map((b) => b.low));
  const high = Math.max(...bars.map((b) => b.high));
  const span = high - low || 1;
  // Log scale: equal vertical distance = equal % move, so a 1980s rally is as visible as a 2020s one.
  const logLow = Math.log(Math.max(low, Math.min(...bars.map((b) => b.low).filter((v) => v > 0)), 1e-9));
  const logSpan = Math.log(Math.max(high, 1e-9)) - logLow || 1;
  const maxVolume = Math.max(1, ...bars.map((b) => b.volume));
  const spikeTimes = useMemo(() => new Set(data.volume.spikes.map((s) => s.time)), [data.volume.spikes]);

  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const unit = (price: number) => (log ? (Math.log(Math.max(price, 1e-9)) - logLow) / logSpan : (price - low) / span);
  const y = (price: number) => 72 - unit(price) * 66; // price zone: 6..72, volume zone: 82..100
  const priceAt = (line: number) => (log ? Math.exp(logLow + ((72 - line) / 66) * logSpan) : low + ((72 - line) / 66) * span);
  const linePoints = bars.map((b, i) => `${x(i)},${y(b.close)}`).join(" ");
  const up = data.close >= data.open;
  const accent = up ? "var(--up)" : "var(--down)";

  const band = (from: string, to: string) => {
    const a = indexOf.get(from);
    const b = indexOf.get(to);
    if (a === undefined || b === undefined) return null;
    const left = x(Math.min(a, b));
    return { left, width: Math.max(Math.abs(x(b) - x(a)), 0.8) };
  };
  const longTerm = data.longTerm;
  const lastTime = bars[n - 1].timestamp;
  // MAX shows each of the biggest falls (peak to recovery); the shorter ranges show the single biggest fall and rise.
  const fallBands = longTerm
    ? longTerm.drawdowns.map((d) => band(d.start.time, d.recoveredAt?.time ?? lastTime)).filter((b) => b !== null)
    : data.maxDrawdown
      ? [band(data.maxDrawdown.start.time, data.maxDrawdown.end.time)].filter((b) => b !== null)
      : [];
  const runUpBand = !longTerm && data.maxRunUp ? band(data.maxRunUp.start.time, data.maxRunUp.end.time) : null;
  const splitMarks = (longTerm?.splits ?? [])
    .map((s) => ({ ...s, i: indexOf.get(s.barTime) }))
    .filter((s): s is typeof s & { i: number } => s.i !== undefined);
  const focusBand = focus ? band(focus.from, focus.to) : null;

  const highIndex = indexOf.get(data.high.time);
  const lowIndex = indexOf.get(data.low.time);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const inner = rect.width - 24; // plot area is inset 12px each side
    if (inner <= 0) return;
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left - 12) / inner));
    setHover(n === 1 ? 0 : Math.round(frac * (n - 1)));
  };

  const hovered = hover !== null ? bars[hover] : null;
  const hoverFrac = hover !== null ? x(hover) / 100 : 0;
  const summary = `${data.symbol} ${data.range} journey: opened at ${money(data.open, data.currency)}, closed at ${money(data.close, data.currency)}, high ${money(data.high.price, data.currency)} at ${data.high.label}, low ${money(data.low.price, data.currency)} at ${data.low.label}.`;

  return (
    <div>
      <div
        ref={boxRef}
        role="img"
        aria-label={summary}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        className="relative h-80 touch-pan-y overflow-hidden rounded-xl border border-line bg-canvas/60"
      >
        <div className="absolute inset-x-3 bottom-7 top-10">
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`journey-fill-${data.symbol}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
                <stop offset="100%" stopColor={accent} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[6, 28, 50, 72].map((line) => (
              <line key={line} x1="0" x2="100" y1={line} y2={line} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {runUpBand && <rect data-testid="runup-band" x={runUpBand.left} y="2" width={runUpBand.width} height="72" fill="var(--up)" opacity="0.1" />}
            {fallBands.map((b) => (
              <rect key={b.left} data-testid="drawdown-band" x={b.left} y="2" width={b.width} height="72" fill="var(--down)" opacity="0.13" />
            ))}
            {splitMarks.map((s) => (
              <line key={s.time} data-testid="split-mark" x1={x(s.i)} x2={x(s.i)} y1="2" y2="76" stroke="var(--accent)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            ))}
            {n > 1 && <polygon points={`0,76 ${linePoints} 100,76`} fill={`url(#journey-fill-${data.symbol})`} />}
            <polyline points={linePoints} fill="none" stroke={accent} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            {bars.map((b, i) => (
              <rect
                key={b.timestamp}
                data-testid={spikeTimes.has(b.timestamp) ? "volume-spike" : undefined}
                x={x(i) - Math.max((100 / n) * 0.35, 0.15)}
                y={100 - (b.volume / maxVolume) * 18}
                width={Math.max((100 / n) * 0.7, 0.3)}
                height={(b.volume / maxVolume) * 18}
                fill={spikeTimes.has(b.timestamp) ? "var(--accent)" : "var(--accent)"}
                opacity={spikeTimes.has(b.timestamp) ? 0.9 : 0.35}
              />
            ))}
            {focusBand && <rect data-testid="focus-band" x={focusBand.left} y="0" width={focusBand.width} height="100" fill="var(--accent)" opacity="0.22" />}
          </svg>

          {[6, 28, 50, 72].map((line) => (
            <span key={line} className="pointer-events-none absolute right-0 -translate-y-1/2 rounded bg-canvas/70 px-1 font-mono text-xs text-faint" style={{ top: `${line}%` }}>
              {px(priceAt(line))}
            </span>
          ))}
          {splitMarks.map((s) => (
            <span key={s.time} title={`${s.text} split, ${s.label}`} className="pointer-events-none absolute top-0 -translate-x-1/2 -translate-y-full rounded bg-accent/15 px-1 font-mono text-xs font-semibold text-accent" style={{ left: `${x(s.i)}%` }}>
              {splitRatio(s.ratio)}
            </span>
          ))}
          {highIndex !== undefined && (
            <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full" style={{ left: `${x(highIndex)}%`, top: `${y(data.high.price)}%` }}>
              <span data-testid="marker-high" className="whitespace-nowrap rounded bg-up/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-up">High {px(data.high.price)}</span>
            </div>
          )}
          {lowIndex !== undefined && (
            <div className="pointer-events-none absolute z-10 -translate-x-1/2" style={{ left: `${x(lowIndex)}%`, top: `${y(data.low.price)}%` }}>
              <span data-testid="marker-low" className="whitespace-nowrap rounded bg-down/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-down">Low {px(data.low.price)}</span>
            </div>
          )}
          {[{ i: 0, price: bars[0].open }, { i: n - 1, price: bars[n - 1].close }].map((dot) => (
            <div key={dot.i} className="pointer-events-none absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-line" style={{ left: `${x(dot.i)}%`, top: `${y(dot.price)}%`, background: accent }} />
          ))}
        </div>

        {hovered && (
          <>
            <div className="pointer-events-none absolute bottom-7 top-10 z-20 w-px bg-faint/60" style={{ left: `calc(12px + (100% - 24px) * ${hoverFrac})` }} />
            <div
              className="pointer-events-none absolute top-12 z-30 min-w-40 rounded-md border border-line-strong bg-surface/95 px-2.5 py-2 font-mono text-xs"
              style={hoverFrac > 0.55 ? { right: `calc(100% - 12px - (100% - 24px) * ${hoverFrac} + 8px)` } : { left: `calc(12px + (100% - 24px) * ${hoverFrac} + 8px)` }}
            >
              <div className="mb-1 font-semibold text-fg">{hovered.label}</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 text-muted">
                <span>O</span><span className="text-right text-fg">{px(hovered.open)}</span>
                <span>H</span><span className="text-right text-fg">{px(hovered.high)}</span>
                <span>L</span><span className="text-right text-fg">{px(hovered.low)}</span>
                <span>C</span><span className="text-right text-fg">{px(hovered.close)}</span>
                <span>Vol</span><span className="text-right text-fg">{hovered.volume.toLocaleString()}</span>
              </div>
            </div>
          </>
        )}

        <div className="pointer-events-none absolute inset-x-3 bottom-2 flex justify-between font-mono text-xs text-faint">
          <span>{data.periodStart.label}</span>
          <span>{data.periodEnd.label}</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-3 rounded-sm bg-down/30" /> {longTerm ? `${longTerm.drawdowns.length} biggest falls, peak to recovery` : "Biggest fall"}</span>
        {!longTerm && <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-3 rounded-sm bg-up/25" /> Biggest rise</span>}
        {splitMarks.length > 0 && <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-0 border-l border-dashed border-accent" /> Stock split</span>}
        <span>{log ? "Log scale" : "Linear scale"}</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-3 rounded-sm bg-accent" /> Volume spike</span>
        <span className="ml-auto">{n} bars · hover the chart, or hover a timeline row to highlight it</span>
      </div>
    </div>
  );
}

function YearlyReturns({ years }: { years: JourneyLongTerm["years"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...years.map((y) => Math.abs(y.percent)));
  const w = 100 / years.length;
  const shown = hover !== null ? years[hover] : null;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-xs font-semibold text-faint">Return by calendar year</div>
        <div className="font-mono text-xs text-muted" aria-live="polite">
          {shown ? (
            <>
              {shown.year}: <span className={tone(shown.percent)}>{pct(shown.percent)}</span>
              {shown.partial && <span className="text-faint"> (partial year)</span>}
            </>
          ) : (
            "Hover a bar"
          )}
        </div>
      </div>
      <svg className="h-36 w-full" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Yearly returns from ${years[0]?.year} to ${years[years.length - 1]?.year}`} onPointerLeave={() => setHover(null)}>
        <line x1="0" x2="100" y1="50" y2="50" stroke="var(--line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {years.map((y, i) => {
          const h = (Math.abs(y.percent) / top) * 48;
          return (
            <rect
              key={y.year}
              data-testid="year-bar"
              x={i * w + w * 0.15}
              width={w * 0.7}
              y={y.percent >= 0 ? 50 - h : 50}
              height={Math.max(h, 0.4)}
              fill={y.percent >= 0 ? "var(--up)" : "var(--down)"}
              opacity={hover === i ? 1 : y.partial ? 0.35 : 0.75}
              onPointerEnter={() => setHover(i)}
            >
              <title>{`${y.year}: ${pct(y.percent)}${y.partial ? " (partial year)" : ""}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-xs text-faint">
        <span>{years[0]?.year}</span>
        <span>Faded bars are partial years · scale ±{top.toFixed(0)}%</span>
        <span>{years[years.length - 1]?.year}</span>
      </div>
    </div>
  );
}

function SinceListing({ lt, currency, lastLabel, onFocus }: { lt: JourneyLongTerm; currency: string; lastLabel: string; onFocus: (f: Focus) => void }) {
  const yearTile = (label: string, y: JourneyLongTerm["bestYear"]) => (
    <Tile label={label} value={y ? pct(y.percent) : DASH} valueClass={y ? tone(y.percent) : "text-strong"} sub={y ? `Calendar ${y.year} (full years only)` : "Needs a full calendar year"} />
  );
  return (
    <section data-testid="since-listing" aria-label="Since listing" className="space-y-4 rounded-xl border border-accent/20 bg-accent/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-accent">Since listing</div>
        <span className="rounded border border-line-strong bg-raised px-1.5 py-1 font-mono text-xs font-semibold text-muted">WEEKLY BARS · ADJUSTED PRICES</span>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-raised lg:grid-cols-4">
        <Tile label="First traded (per Yahoo)" value={lt.firstTraded.label} sub={`${lt.yearsListed.toFixed(1)} years of history · first price ${money(lt.firstTraded.price, currency)} adjusted`} />
        <Tile label="Total return" value={pct(lt.totalReturnPercent)} valueClass={tone(lt.totalReturnPercent)} sub="First open to latest close, dividends reinvested" />
        <Tile label="Yearly growth (CAGR)" value={lt.cagrPercent !== null ? pct(lt.cagrPercent) : DASH} valueClass={lt.cagrPercent !== null ? tone(lt.cagrPercent) : "text-strong"} sub={lt.cagrPercent !== null ? "Compound annual growth rate" : "Needs at least one year of history"} />
        <Tile label="$1,000 at the start" value={money(lt.growthOf1000, currency)} valueClass={tone(lt.growthOf1000 - 1000)} sub={`Worth this at ${lastLabel}, before taxes and fees`} />
        <Tile label="All-time high" value={money(lt.allTimeHigh.price, currency)} sub={`${lt.allTimeHigh.label} · latest close is ${pct(lt.fromAllTimeHighPercent)} from it`} />
        <Tile label="All-time low" value={money(lt.allTimeLow.price, currency)} sub={lt.allTimeLow.label} />
        {yearTile("Best year", lt.bestYear)}
        {yearTile("Worst year", lt.worstYear)}
      </div>

      {lt.years.length > 0 && <YearlyReturns years={lt.years} />}

      <div>
        <div className="mb-2 text-xs font-semibold text-faint">The {lt.drawdowns.length} biggest falls</div>
        {lt.drawdowns.length === 0 ? (
          <p className="text-xs text-faint">The price never closed below an earlier close.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[36rem] text-left text-xs">
              <thead className="bg-surface text-xs text-faint">
                <tr>
                  <th className="px-3 py-2 font-semibold">Fall</th>
                  <th className="px-3 py-2 font-semibold">Peak</th>
                  <th className="px-3 py-2 font-semibold">Bottom</th>
                  <th className="px-3 py-2 font-semibold">Back to peak</th>
                  <th className="px-3 py-2 text-right font-semibold">Peak to bottom</th>
                  <th className="px-3 py-2 text-right font-semibold">Peak to recovery</th>
                </tr>
              </thead>
              <tbody>
                {lt.drawdowns.map((d) => {
                  const f = { from: d.start.time, to: d.recoveredAt?.time ?? d.bottom.time };
                  return (
                    <tr
                      key={d.start.time}
                      tabIndex={0}
                      onMouseEnter={() => onFocus(f)}
                      onMouseLeave={() => onFocus(null)}
                      onFocus={() => onFocus(f)}
                      onBlur={() => onFocus(null)}
                      className="border-t border-line font-mono text-fg outline-none transition hover:bg-raised/50 focus-visible:bg-raised/70"
                    >
                      <td className="px-3 py-2 font-semibold text-down">{pct(d.percent)}</td>
                      <td className="px-3 py-2">{d.start.label} <span className="text-faint">{px(d.start.price)}</span></td>
                      <td className="px-3 py-2">{d.bottom.label} <span className="text-faint">{px(d.bottom.price)}</span></td>
                      <td className="px-3 py-2">{d.recoveredAt ? d.recoveredAt.label : <span className="text-warn">Not yet</span>}</td>
                      <td className="px-3 py-2 text-right">{duration(d.daysToBottom)}</td>
                      <td className="px-3 py-2 text-right">{d.daysToRecover !== null ? duration(d.daysToRecover) : DASH}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">Weekly closes. Hover a row to highlight that fall on the chart.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-semibold text-faint">Stock splits</div>
          {lt.splits.length === 0 ? (
            <p className="text-xs text-faint">No splits in Yahoo's history for this symbol.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-fg">
              {lt.splits.map((s) => (
                <li key={s.time} className="flex justify-between gap-3 rounded border border-line bg-surface/60 px-2.5 py-1.5">
                  <span>{s.label}</span>
                  <span className="font-semibold text-accent">{s.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-faint">Dividends</div>
          {lt.dividends.count === 0 || !lt.dividends.last ? (
            <p className="text-xs text-faint">No dividends in Yahoo's history for this symbol.</p>
          ) : (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-raised">
              <Tile label="Payments" value={String(lt.dividends.count)} sub={`In ${lt.dividends.byYear.length} of ${lt.years.length} calendar years`} />
              <Tile label="Latest" value={money(lt.dividends.last.amount, currency)} sub={`Per share, ${lt.dividends.last.label}`} />
              <Tile label="Total per share" value={money(lt.dividends.totalPerShare, currency)} sub="Split-adjusted, all years" />
              <Tile label="First paid" value={String(lt.dividends.byYear[0]?.year ?? DASH)} sub="Earliest year in Yahoo's data" />
            </div>
          )}
        </div>
      </div>

      <ul className="space-y-1 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-warn/80">
        {lt.notes.map((note) => (
          <li key={note}>• {note}</li>
        ))}
      </ul>
    </section>
  );
}

function Journey({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<JourneyRange>("1d");
  const [data, setData] = useState<JourneyData | null>(null);
  const [status, setStatus] = useState<"loading" | "online" | "stale" | "error">("loading");
  const [error, setError] = useState<{ kind: StockApiError["kind"]; message: string } | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [log, setLog] = useState(false);

  // Clear on symbol/range change; keep the last good data if a later refresh fails.
  useEffect(() => {
    let controller: AbortController | null = null;
    let hasData = false;
    setData(null);
    setStatus("loading");
    setError(null);
    setFocus(null);

    const load = async () => {
      if (document.hidden && hasData) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await getJourney(symbol, range, controller.signal);
        hasData = true;
        setData(next);
        setStatus("online");
        setError(null);
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        const known = failure instanceof StockApiError ? failure : new StockApiError("network", "Unable to reach the stock API");
        setError({ kind: known.kind, message: known.message });
        if (hasData) {
          setStatus("stale");
        } else {
          setData(null);
          setStatus("error");
        }
      }
    };

    load();
    const poll = range === "1d" || range === "5d" ? window.setInterval(load, 60_000) : undefined;
    return () => {
      controller?.abort();
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [symbol, range]);

  // Never render data that belongs to another symbol/range, even for one frame.
  const current = data && data.symbol.toUpperCase() === symbol.toUpperCase() && data.range === range ? data : null;
  const c = current?.currency ?? "USD";
  const chip =
    status === "online"
      ? "border-up/20 bg-up/10 text-up"
      : status === "error"
        ? "border-down/20 bg-down/10 text-down"
        : "border-warn/20 bg-warn/10 text-warn";

  const yearPosition =
    current && current.yearHigh !== null && current.yearLow !== null && current.yearHigh > current.yearLow
      ? Math.min(100, Math.max(0, ((current.close - current.yearLow) / (current.yearHigh - current.yearLow)) * 100))
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex rounded-lg border border-line bg-canvas/70 p-1" role="group" aria-label="Journey range">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={range === item.id}
              onClick={() => {
                setRange(item.id);
                setLog(item.id === "max"); // decades of growth only read well on a log scale; the user can switch back
              }}
              className={`cursor-pointer rounded px-3 py-1.5 text-xs font-semibold transition ${range === item.id ? "bg-line-strong text-strong" : "text-faint hover:text-fg"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex rounded-lg border border-line bg-canvas/70 p-1" role="group" aria-label="Price scale">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={log === value}
              onClick={() => setLog(value)}
              className={`cursor-pointer rounded px-2.5 py-1.5 text-xs font-semibold transition ${log === value ? "bg-line-strong text-strong" : "text-faint hover:text-fg"}`}
            >
              {value ? "Log" : "Linear"}
            </button>
          ))}
        </div>
        <div className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${chip}`}>
          <span className={`size-1.5 rounded-full ${status === "online" ? "bg-up" : status === "error" ? "bg-down" : "animate-pulse bg-warn"}`} />
          Journey {status}
        </div>
      </div>

      {!current ? (
        <div className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center">
          <div className={`mb-4 size-10 rounded-xl border ${status === "loading" ? "animate-pulse border-warn/30 bg-warn/10" : "border-down/30 bg-down/10"}`} />
          <div className="text-sm font-semibold text-fg">
            {status === "loading" ? `Loading the ${symbol} journey` : error?.kind === "network" ? "Python stock API unavailable" : `Couldn't load the ${symbol} journey`}
          </div>
          <div className="mt-2 max-w-xl text-xs leading-relaxed text-faint">
            {status === "loading"
              ? "Fetching price history and working out the highs, lows and swings."
              : error?.kind === "network"
                ? "Start the Python service (uvicorn main:app in market-data/). If it is already running, restart it: the journey endpoint is part of the latest market-data code."
                : error?.message}
          </div>
        </div>
      ) : (
        <div className="space-y-6 p-4">
          {status === "stale" && error && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
              Showing last good data. The latest refresh failed: {error.message}
            </div>
          )}

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-raised lg:grid-cols-6">
            <Tile label="Period change" value={money(current.close, c)} valueClass={tone(current.change)} sub={`${pct(current.changePercent)} from ${money(current.open, c)} · ${current.periodStart.label} to ${current.periodEnd.label}`} />
            <Tile label="Low / high" value={`${current.low.price.toFixed(2)} – ${current.high.price.toFixed(2)}`} sub={`${current.rangePercent.toFixed(2)}% range · low ${current.low.label}, high ${current.high.label}`} />
            <Tile
              label="Biggest fall"
              value={current.maxDrawdown ? pct(current.maxDrawdown.percent) : "No pullback"}
              valueClass={current.maxDrawdown ? "text-down" : "text-fg"}
              sub={current.maxDrawdown ? `${current.maxDrawdown.start.label} to ${current.maxDrawdown.end.label} · ${current.maxDrawdown.recovered && current.maxDrawdown.recoveredAt ? `recovered ${current.maxDrawdown.recoveredAt.label}` : "not recovered"}` : "The price never closed below an earlier close."}
            />
            <Tile
              label="Biggest rise"
              value={current.maxRunUp ? pct(current.maxRunUp.percent) : "No rise"}
              valueClass={current.maxRunUp ? "text-up" : "text-fg"}
              sub={current.maxRunUp ? `${current.maxRunUp.start.label} to ${current.maxRunUp.end.label}` : "The price never closed above a later low."}
            />
            <Tile label="Volume" value={compact(current.volume.total)} sub={`${compact(current.volume.averagePerBar)} average per ${current.interval} bar`} />
            <Tile
              label="VWAP"
              value={current.vwap !== null ? money(current.vwap, c) : DASH}
              sub={current.vwap !== null ? `Close is ${current.close >= current.vwap ? "above" : "below"} VWAP by ${Math.abs(((current.close - current.vwap) / current.vwap) * 100).toFixed(2)}%` : "No volume reported."}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <JourneyChart data={current} focus={focus} log={log} />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-faint">The story, in order</div>
                <span className="rounded border border-line-strong bg-raised px-1.5 py-1 font-mono text-xs font-semibold text-muted">{current.storyMethod.toUpperCase()}</span>
              </div>
              <ol className="max-h-80 space-y-1 overflow-y-auto pr-1">
                {current.timeline.map((event, index) => {
                  const style = KIND_STYLE[event.kind];
                  return (
                    <li key={`${event.kind}-${event.time}-${index}`}>
                      <button
                        type="button"
                        onMouseEnter={() => setFocus({ from: event.time, to: event.endTime ?? event.time })}
                        onMouseLeave={() => setFocus(null)}
                        onFocus={() => setFocus({ from: event.time, to: event.endTime ?? event.time })}
                        onBlur={() => setFocus(null)}
                        className="flex w-full cursor-default items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-line-strong hover:bg-raised/50 focus-visible:border-line-strong"
                      >
                        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
                        <span>
                          <span className="flex items-center gap-2 font-mono text-xs text-faint">
                            <span className={`font-semibold ${style.tag}`}>{style.name}</span>
                            {event.label}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-fg">{event.text}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          {current.longTerm && <SinceListing lt={current.longTerm} currency={c} lastLabel={current.periodEnd.label} onFocus={setFocus} />}

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-raised lg:grid-cols-4">
            <Tile label="Up / down / flat bars" value={`${current.bars.up} / ${current.bars.down} / ${current.bars.flat}`} sub={`${current.interval} bars, close versus open`} />
            <Tile label="Volatility" value={current.volatility.perBarPercent !== null ? `${current.volatility.perBarPercent.toFixed(3)}%` : DASH} sub={`Std dev of close-to-close change per ${current.volatility.barLabel} bar`} />
            <Tile label="Biggest up bar" value={current.biggestBar.up ? pct(current.biggestBar.up.percent) : DASH} valueClass="text-up" sub={current.biggestBar.up?.label ?? "No rising bar"} />
            <Tile label="Biggest down bar" value={current.biggestBar.down ? pct(current.biggestBar.down.percent) : DASH} valueClass="text-down" sub={current.biggestBar.down?.label ?? "No falling bar"} />
            <Tile label="Gap vs previous close" value={current.gapPercent !== null ? pct(current.gapPercent) : DASH} valueClass={current.gapPercent !== null ? tone(current.gapPercent) : "text-strong"} sub={current.gapPercent !== null ? "Opening price against yesterday's close" : "Only defined for the 1D view"} />
            <Tile
              label="52-week range"
              value={current.yearLow !== null && current.yearHigh !== null ? `${current.yearLow.toFixed(2)} – ${current.yearHigh.toFixed(2)}` : DASH}
              sub={yearPosition !== null ? `Close sits at ${yearPosition.toFixed(0)}% of that range` : "Not provided by Yahoo for this symbol"}
            />
            <Tile
              label="Volume spikes"
              value={String(current.volume.spikes.length)}
              sub={current.volume.spikes.length > 0 ? `Strongest ${Math.max(...current.volume.spikes.map((s) => s.multiple)).toFixed(1)}x the average bar` : "No bar stood out from the rest"}
            />
            <Tile label="Bars analysed" value={String(current.barCount)} sub={`Times in ${current.timezone}`} />
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-faint">Trading activity</div>
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-1 font-mono text-xs font-semibold text-accent">NEEDS LEDGER</span>
            </div>
            <div data-testid="ledger" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-dashed border-line-strong bg-raised/60 sm:grid-cols-5">
              {LEDGER_FIELDS.map((field) => (
                <div key={field} className="bg-surface/60 px-4 py-3">
                  <div className="text-xs font-semibold text-faint">{field}</div>
                  <div className="mt-1.5 font-mono text-lg font-semibold text-faint">{DASH}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-faint">
              Yahoo publishes total volume only, not who bought or sold, so these stay empty on purpose. They fill in once the paper-trading ledger records fills from the order ticket.
            </p>
          </div>

          <p className="text-xs leading-relaxed text-faint">{current.dataNote}</p>
        </div>
      )}
    </div>
  );
}

export default memo(Journey);

import { memo, useMemo, useRef, useState } from "react";
import { Segmented } from "@/components/ui";
import { volatilityAxis } from "@/lib/behavior";
import type { StockSnapshot } from "@/lib/stockApi";

type Mode = "line" | "candles";
type Scale = "volatility" | "fit";

const fmtTime = (iso: string, daily: boolean) =>
  daily ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Price chart with a line or candlestick view. The Y axis is scaled from the stock's volatility unless "Fit to data" is chosen. */
export const PriceChart = memo(function PriceChart({ snapshot, daily }: { snapshot: StockSnapshot; daily: boolean }) {
  const [mode, setMode] = useState<Mode>("line");
  const [scale, setScale] = useState<Scale>("volatility");
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const points = snapshot.history;
  const n = points.length;
  const closes = useMemo(() => points.map((p) => p.close), [points]);

  const fit = useMemo(() => ({ min: Math.min(...points.map((p) => p.low)), max: Math.max(...points.map((p) => p.high)) }), [points]);
  const axis = scale === "volatility" ? volatilityAxis(closes) : fit;
  const lo = Math.min(axis.min, fit.min);
  const hi = Math.max(axis.max, fit.max);
  const span = hi - lo || 1;
  const y = (v: number) => 96 - ((v - lo) / span) * 92;
  const x = (i: number) => (mode === "candles" ? ((i + 0.5) / n) * 100 : n === 1 ? 50 : (i / (n - 1)) * 100);

  const up = snapshot.history[n - 1].close >= snapshot.history[0].open;
  const color = up ? "var(--up)" : "var(--down)";
  const line = points.map((p, i) => `${x(i)},${y(p.close)}`).join(" ");

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(mode === "candles" ? Math.min(n - 1, Math.floor(frac * n)) : Math.round(frac * (n - 1)));
  };
  const p = hover !== null ? points[hover] : null;
  const hoverLeft = hover !== null ? x(hover) : 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Chart type" value={mode} options={[{ value: "line", label: "Line" }, { value: "candles", label: "Candles" }]} onChange={setMode} />
        <Segmented label="Price axis" value={scale} options={[{ value: "volatility", label: "Volatility scale" }, { value: "fit", label: "Fit to data" }]} onChange={setScale} />
      </div>
      <div
        ref={boxRef}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${snapshot.symbol} price chart, ${n} points, from ${snapshot.currency} ${lo.toFixed(2)} to ${hi.toFixed(2)}`}
        className="relative h-64 touch-pan-y rounded-md border border-line bg-canvas"
      >
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[25, 50, 75].map((g) => <line key={g} x1="0" x2="100" y1={g} y2={g} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
          {mode === "line" ? (
            <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          ) : (
            points.map((c, i) => {
              const rising = c.close >= c.open;
              const w = Math.max((100 / n) * 0.6, 0.2);
              return (
                <g key={c.timestamp} stroke={rising ? "var(--up)" : "var(--down)"} fill={rising ? "var(--up)" : "var(--down)"}>
                  <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  <rect x={x(i) - w / 2} y={y(Math.max(c.open, c.close))} width={w} height={Math.max(0.5, Math.abs(y(c.open) - y(c.close)))} stroke="none" />
                </g>
              );
            })
          )}
        </svg>
        <span className="pointer-events-none absolute right-2 top-1 rounded-sm bg-canvas/80 px-1 font-mono text-xs text-faint">{hi.toFixed(2)}</span>
        <span className="pointer-events-none absolute bottom-6 right-2 rounded-sm bg-canvas/80 px-1 font-mono text-xs text-faint">{lo.toFixed(2)}</span>
        <div className="pointer-events-none absolute inset-x-2 bottom-1 flex justify-between font-mono text-xs text-faint">
          <span>{fmtTime(points[0].timestamp, daily)}</span>
          <span>{fmtTime(points[n - 1].timestamp, daily)}</span>
        </div>
        {p && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style={{ left: `${hoverLeft}%` }} />
            <div
              className="pointer-events-none absolute top-6 min-w-36 rounded-md border border-line-strong bg-surface px-2.5 py-2 font-mono text-xs"
              style={hoverLeft > 55 ? { right: `${100 - hoverLeft + 2}%` } : { left: `${hoverLeft + 2}%` }}
            >
              <div className="mb-1 text-strong">{fmtTime(p.timestamp, daily)}</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 text-muted">
                <span>Open</span><span className="text-right text-fg">{p.open.toFixed(2)}</span>
                <span>High</span><span className="text-right text-fg">{p.high.toFixed(2)}</span>
                <span>Low</span><span className="text-right text-fg">{p.low.toFixed(2)}</span>
                <span>Close</span><span className="text-right text-fg">{p.close.toFixed(2)}</span>
                <span>Volume</span><span className="text-right text-fg">{p.volume.toLocaleString()}</span>
              </div>
            </div>
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        {scale === "volatility"
          ? "The axis spans the range this stock normally wanders over this window, so an ordinary move does not fill the chart. Prices outside it still fit."
          : "The axis is stretched to the highest and lowest price shown, which makes small moves look large."}
      </p>
    </div>
  );
});

// The "Market" section: real prices from the market-data service, an S&P 500 browser, and the Journey view.
import { useEffect, useMemo, useState } from "react";
import { WhyChip } from "@/features/research/Papers";
import Journey from "@/features/journey/Journey";
import { Badge, Notice, Panel, Segmented, buttonClass, inputClass } from "@/components/ui";
import { maxDrawdownPct, periodReturnPct } from "@/lib/behavior";
import { DASH, fmtPct } from "@/lib/format";
import { getStockSnapshot, StockApiError, type QuoteRange, type StockSnapshot } from "@/lib/stockApi";
import { scrollToSection } from "@/lib/scroll";
import { PriceChart } from "./PriceChart";
import { sp500 } from "./sp500";

type LoadState = "loading" | "online" | "stale" | "error";

// Feature 11: the same stock seen through a daily window and through longer ones.
const WINDOWS: { value: QuoteRange; label: string; blurb: string }[] = [
  { value: "1d", label: "Daily", blurb: "today, 5-minute bars" },
  { value: "1mo", label: "30 days", blurb: "the last month, daily bars" },
  { value: "1y", label: "1 year", blurb: "the last year, daily bars" },
];

function useQuote(symbol: string, range: QuoteRange) {
  const [snapshot, setSnapshot] = useState<StockSnapshot | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<StockApiError | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let hasData = false;
    setSnapshot(null);
    setState("loading");
    setError(null);

    const load = async () => {
      if (document.hidden && hasData) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await getStockSnapshot(symbol, range, controller.signal);
        hasData = true;
        setSnapshot(next);
        setState("online");
        setError(null);
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setError(failure instanceof StockApiError ? failure : new StockApiError("network", "Unable to reach the stock API"));
        if (hasData) setState("stale");
        else setState("error");
      }
    };
    load();
    const poll = window.setInterval(load, 30_000);
    return () => {
      controller?.abort();
      window.clearInterval(poll);
    };
  }, [symbol, range]);

  return { snapshot, state, error };
}

function QuotePanel({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<QuoteRange>("1d");
  const { snapshot, state, error } = useQuote(symbol, range);
  const window_ = WINDOWS.find((w) => w.value === range)!;
  const closes = useMemo(() => snapshot?.history.map((p) => p.close) ?? [], [snapshot]);

  // Feature 14: return and worst fall shown together, for whichever window is selected.
  const windowReturn = periodReturnPct(closes);
  const windowDrawdown = maxDrawdownPct(closes);

  return (
    <Panel
      title={`${symbol} price`}
      description={`Real prices from Yahoo Finance via market-data: ${window_.blurb}.`}
      action={
        <>
          <WhyChip slug="benartzi-thaler-1995-myopic-loss-aversion" />
          <Segmented label="Evaluation window" value={range} options={WINDOWS} onChange={setRange} />
        </>
      }
    >
      {snapshot ? (
        <div className="grid gap-px bg-line lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="space-y-4 bg-surface p-4">
            <div>
              <div className="font-mono text-3xl font-medium text-strong">{snapshot.currency} {snapshot.price.toFixed(2)}</div>
              <div className={`font-mono text-sm ${snapshot.change >= 0 ? "text-up" : "text-down"}`}>
                {snapshot.change >= 0 ? "+" : ""}{snapshot.change.toFixed(2)} ({fmtPct(snapshot.changePercent)}) vs previous close
              </div>
              <div className="mt-1 text-xs text-muted">Updated {new Date(snapshot.updatedAt).toLocaleTimeString()}</div>
            </div>
            {state === "stale" && error && <Notice tone="error" title="Showing the last good data">The latest refresh failed: {error.message}</Notice>}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted">Return, {window_.label.toLowerCase()}</dt><dd className={`font-mono ${windowReturn !== null && windowReturn < 0 ? "text-down" : "text-up"}`}>{windowReturn !== null ? fmtPct(windowReturn) : DASH}</dd></div>
              <div><dt className="text-xs text-muted">Worst fall in that window</dt><dd className="font-mono text-down">{fmtPct(windowDrawdown)}</dd></div>
              <div><dt className="text-xs text-muted">Previous close</dt><dd className="font-mono text-strong">{snapshot.previousClose.toFixed(2)}</dd></div>
              <div><dt className="text-xs text-muted">Volume</dt><dd className="font-mono text-strong">{snapshot.volume.toLocaleString()}</dd></div>
              <div><dt className="text-xs text-muted">Market</dt><dd className="font-mono text-strong">{snapshot.marketState}</dd></div>
              <div><dt className="text-xs text-muted">Data points</dt><dd className="font-mono text-strong">{snapshot.history.length}</dd></div>
            </dl>
            <p className="text-xs text-muted">A single day shows noise. Switch to 30 days or 1 year to see the same price in context.</p>
          </div>
          <div className="bg-surface p-4">
            <PriceChart key={`${snapshot.symbol}-${range}`} snapshot={snapshot} daily={range !== "1d"} />
          </div>
        </div>
      ) : state === "loading" ? (
        <Notice tone="loading" title={`Loading ${symbol}`}>Waiting for prices from the market-data service.</Notice>
      ) : (
        <Notice tone="error" title={error?.kind === "network" ? "market-data is not reachable" : `Could not load ${symbol}`}>
          {error?.kind === "network"
            ? "Start the stack with ./build.sh, or run uvicorn app.main:app --port 8000 in services/market-data. The address is set by VITE_STOCK_API_URL."
            : error?.message}
        </Notice>
      )}
    </Panel>
  );
}

function Universe({ selected, onSelect }: { selected: string; onSelect: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sector, setSector] = useState("All sectors");
  const [query, setQuery] = useState("");
  const sectors = useMemo(() => ["All sectors", ...Array.from(new Set(sp500.map((s) => s.sector))).sort()], []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sp500.filter((s) => (sector === "All sectors" || s.sector === sector) && (q === "" || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
  }, [sector, query]);

  return (
    <Panel
      title="S&P 500 stocks"
      description={`${sp500.length} stocks in ${sectors.length - 1} sectors. Pick one to load its price and journey.`}
      action={<button type="button" className={buttonClass} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide list" : "Browse stocks"}</button>}
    >
      <div className="border-b border-line px-4 py-3 text-sm text-muted">Selected: <span className="font-mono text-strong">{selected}</span></div>
      {open && (
        <>
          <div className="space-y-2 border-b border-line p-4">
            <input className={inputClass} placeholder="Search symbol or company" aria-label="Search stocks" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className={inputClass} aria-label="Sector" value={sector} onChange={(e) => setSector(e.target.value)}>
              {sectors.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {visible.length === 0 && <li className="px-4 py-6 text-sm text-muted">No stock matches that search.</li>}
            {visible.map((stock) => (
              <li key={stock.symbol}>
                <button
                  type="button"
                  aria-pressed={selected === stock.symbol}
                  onClick={() => onSelect(stock.symbol)}
                  className={`flex w-full items-baseline justify-between gap-3 border-b border-line px-4 py-2 text-left text-sm hover:bg-raised ${selected === stock.symbol ? "bg-raised" : ""}`}
                >
                  <span className="font-mono font-medium text-strong">{stock.symbol}</span>
                  <span className="truncate text-muted">{stock.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="px-4 py-2 text-xs text-muted">{visible.length} shown</div>
        </>
      )}
    </Panel>
  );
}

export function MarketSection() {
  const [symbol, setSymbol] = useState("AAPL");
  return (
    <>
      <section id="market" className="scroll-mt-20 space-y-4 py-8">
        <h2 className="text-xl font-semibold text-strong">Market</h2>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <QuotePanel symbol={symbol} />
          <Universe selected={symbol} onSelect={setSymbol} />
        </div>
      </section>
      <section id="journey" className="scroll-mt-20 space-y-4 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold text-strong">Journey</h2>
          <span className="text-sm text-muted">
            Showing <span className="font-mono text-strong">{symbol}</span>{" "}
            <button type="button" className="text-accent underline underline-offset-2" onClick={() => scrollToSection("market")}>change stock</button>
          </span>
        </div>
        <Panel
          title={`${symbol} journey`}
          description="How the price moved: when it rose, when it fell, and the numbers behind it. Rule-based text, real Yahoo history."
          action={<Badge kind="live" label="REAL DATA" />}
        >
          <Journey symbol={symbol} />
        </Panel>
      </section>
    </>
  );
}

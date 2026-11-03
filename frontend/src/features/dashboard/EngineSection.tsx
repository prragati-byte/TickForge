// The "Engine" section: live numbers from the matching engine, its order book and latency histogram.
import { useState } from "react";
import { WhyChip } from "@/features/research/Papers";
import { DASH, dollars, fmtInt, fmtUs } from "@/lib/format";
import { EXCHANGE_SYMBOLS, useOrderBook, type ExchangeHealth, type LiveTrade } from "@/lib/exchangeApi";
import type { EngineStats } from "@/lib/telemetry";
import { Badge, Notice, Panel, Stat } from "@/components/ui";
import { OrderTicket } from "./OrderTicket";

type Props = {
  stats: EngineStats | null;
  linkLive: boolean;
  health: ExchangeHealth | null;
  trades: LiveTrade[];
};

const BOOK_DEPTH = 8;
const HIST_BUCKETS = 16;

function Metrics({ stats }: { stats: EngineStats | null }) {
  const live = stats !== null;
  const items: [string, string][] = [
    ["Orders per second", live ? fmtInt(stats.ordersPerSec) : DASH],
    ["Trades per second", live ? fmtInt(stats.tradesPerSec) : DASH],
    ["Average latency", live ? fmtUs(stats.avgLatencyUs) : DASH],
    ["p99 latency", live ? `≤ ${fmtUs(stats.p99LatencyUs)}` : DASH],
    ["Queue depth", live ? fmtInt(stats.queueDepth) : DASH],
    ["CPU", live ? `${stats.cpuPct.toFixed(0)}%` : DASH],
    ["Memory", live && stats.rssMb > 0 ? `${stats.rssMb.toFixed(1)} MB` : DASH],
    ["Threads", live ? String(stats.threads) : DASH],
  ];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
      {items.map(([label, value]) => (
        <div key={label} className="bg-surface">
          <Stat label={label} value={value} live={live} />
        </div>
      ))}
    </div>
  );
}

/** Where an order travels, with the real counter at each step. */
function OrderPath({ stats, health }: { stats: EngineStats | null; health: ExchangeHealth | null }) {
  const live = stats !== null;
  const steps: [string, string, string][] = [
    ["Producers", live ? fmtInt(stats.submitted) : DASH, `orders sent by ${live ? stats.producers.length : "the"} connection(s)`],
    ["Queue", live ? fmtInt(stats.queueDepth) : DASH, "orders waiting for the matcher"],
    ["Matcher", live ? fmtInt(stats.processed) : DASH, "orders matched so far"],
    ["Trades", live ? fmtInt(stats.tradesTotal) : DASH, "fills produced"],
    ["Database", health ? fmtInt(health.trades) : DASH, "trades saved by exchange-api"],
  ];
  return (
    <Panel
      title="Order path"
      description="Producer threads, the lock-free queue, one matching thread, then storage. Counters are live."
      action={<WhyChip slug="michael-scott-1996" />}
    >
      <ol className="grid divide-y divide-line sm:grid-cols-5 sm:divide-x sm:divide-y-0">
        {steps.map(([name, value, note]) => (
          <li key={name} className="px-4 py-3">
            <div className="text-xs text-muted">{name}</div>
            <div className={`font-mono text-lg font-medium ${live || name === "Database" ? "text-strong" : "text-faint"}`}>{value}</div>
            <div className="text-xs text-faint">{note}</div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function BookSide({ levels, side, max }: { levels: [number, number][]; side: "bid" | "ask"; max: number }) {
  const shown = levels.slice(0, BOOK_DEPTH);
  // asks are drawn with the best (lowest) price at the bottom, next to the spread
  const rows = side === "ask" ? [...shown].reverse() : shown;
  return (
    <div role="rowgroup" aria-label={side === "ask" ? "Sell orders" : "Buy orders"}>
      {rows.length === 0 && <div className="px-4 py-2 text-sm text-faint">No resting {side === "ask" ? "sell" : "buy"} orders</div>}
      {rows.map(([price, qty]) => (
        <div key={price} role="row" className="relative flex items-center justify-between px-4 py-1 font-mono text-sm">
          <span aria-hidden="true" className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-down/10" : "bg-up/10"}`} style={{ width: `${(qty / max) * 100}%` }} />
          <span className={`relative ${side === "ask" ? "text-down" : "text-up"}`}>{dollars(price)}</span>
          <span className="relative text-fg">{fmtInt(qty)}</span>
        </div>
      ))}
    </div>
  );
}

function OrderBookPanel({ symbol, onSymbol, trades, linkLive }: { symbol: string; onSymbol: (s: string) => void; trades: LiveTrade[]; linkLive: boolean }) {
  const book = useOrderBook(symbol);
  const last = trades.find((t) => t.symbol === symbol);
  const max = Math.max(1, ...(book ? [...book.asks, ...book.bids].map(([, q]) => q) : []));
  const spread = book && book.asks[0] && book.bids[0] ? book.asks[0][0] - book.bids[0][0] : null;

  return (
    <Panel
      title="Order book"
      description="Price-time priority. Prices are whole cents; the book comes from the engine."
      action={
        <>
          <WhyChip slug="gould-2013-limit-order-books" />
          <Badge kind={book && linkLive ? "live" : "sample"} label={book && linkLive ? "LIVE" : "NO DATA"} />
        </>
      }
    >
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <label htmlFor="book-symbol" className="text-xs text-muted">Symbol</label>
        <select id="book-symbol" value={symbol} onChange={(e) => onSymbol(e.target.value)} className="rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-sm text-strong">
          {EXCHANGE_SYMBOLS.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {!book ? (
        <Notice tone="empty" title="No order book yet">
          {linkLive ? "Waiting for the first snapshot from the engine." : "exchange-api is not reachable. Start the stack with ./build.sh and the book appears here."}
        </Notice>
      ) : (
        <div role="table" aria-label={`${symbol} order book`}>
          <div role="row" className="flex justify-between px-4 py-1.5 text-xs text-muted">
            <span>Price</span><span>Shares</span>
          </div>
          <BookSide levels={book.asks} side="ask" max={max} />
          <div className="flex items-center justify-between border-y border-line bg-canvas px-4 py-2 text-sm">
            <span className="text-muted">Spread <span className="font-mono text-strong">{spread !== null ? dollars(spread) : DASH}</span></span>
            <span className="text-muted">Last <span className="font-mono text-strong">{last ? dollars(last.price) : DASH}</span></span>
          </div>
          <BookSide levels={book.bids} side="bid" max={max} />
        </div>
      )}
    </Panel>
  );
}

function LatencyPanel({ stats, linkLive }: { stats: EngineStats | null; linkLive: boolean }) {
  const hist = stats?.latHist ?? [];
  const shown = hist.slice(0, HIST_BUCKETS - 1).concat(hist.slice(HIST_BUCKETS - 1).reduce((a, b) => a + b, 0));
  const total = shown.reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...shown);
  return (
    <Panel
      title="Latency histogram"
      description="Time from the queue to a finished match, since the engine started."
      action={<><WhyChip slug="dean-barroso-2013-tail-at-scale" /><Badge kind={stats && total > 0 ? "live" : "sample"} label={stats && total > 0 ? "LIVE" : "NO DATA"} /></>}
    >
      {stats && total > 0 ? (
        <div className="p-4">
          <div className="flex h-36 items-end gap-1 border-b border-line-strong" role="img" aria-label={`Latency histogram, ${fmtInt(total)} samples, p50 up to ${fmtUs(stats.p50LatencyUs)}, p99 up to ${fmtUs(stats.p99LatencyUs)}`}>
            {shown.map((count, i) => (
              <div key={i} className="flex h-full flex-1 flex-col justify-end" title={`${i === HIST_BUCKETS - 1 ? "at least" : "under"} ${fmtUs(2 ** (i === HIST_BUCKETS - 1 ? i - 1 : i))}: ${fmtInt(count)} orders`}>
                <div className="w-full rounded-t-sm bg-accent" style={{ height: `${Math.max(count > 0 ? 2 : 0, (count / peak) * 100)}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-1 font-mono text-xs text-faint">
            {shown.map((_, i) => <div key={i} className="flex-1 text-center">{i % 5 === 0 ? fmtUs(2 ** i).replace(" ", "") : ""}</div>)}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            {([["p50", `≤ ${fmtUs(stats.p50LatencyUs)}`], ["p99", `≤ ${fmtUs(stats.p99LatencyUs)}`], ["Average", fmtUs(stats.avgLatencyUs)], ["Samples", fmtInt(total)]] as const).map(([label, value]) => (
              <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="font-mono text-strong">{value}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">Buckets double in width (1, 2, 4 … µs), so percentiles are bucket upper bounds. WAL write time is not included.</p>
        </div>
      ) : (
        <Notice title="No latency samples yet">
          {linkLive ? "The engine has not matched any orders. Press Start to let the virtual traders send orders." : "Not connected to exchange-api, so there is nothing to measure."}
        </Notice>
      )}
    </Panel>
  );
}

export function EngineSection({ stats, linkLive, health, trades }: Props) {
  const [symbol, setSymbol] = useState("AAPL");
  return (
    <section id="engine" className="scroll-mt-20 space-y-4 py-8">
      <h2 className="text-xl font-semibold text-strong">Engine</h2>
      <Metrics stats={stats} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <OrderBookPanel symbol={symbol} onSymbol={setSymbol} trades={trades} linkLive={linkLive} />
        <OrderTicket symbol={symbol} onSymbol={setSymbol} online={health?.engine === "connected"} />
      </div>
      <OrderPath stats={stats} health={health} />
      <LatencyPanel stats={stats} linkLive={linkLive} />
    </section>
  );
}

// Order ticket with a "review" step. Before the order is sent, the review shows what happened in
// the past to a position like this one: return next to the worst fall (feature 14) and the spread of
// outcomes over a holding period (feature 13). It comes from real Yahoo history, not from a forecast.
import { useEffect, useState } from "react";
import { WhyChip } from "@/features/research/Papers";
import { Badge, Panel, Segmented, buttonClass, inputClass, primaryButtonClass } from "@/components/ui";
import { DASH, dollars, fmtPct, parseCents, signedDollars } from "@/lib/format";
import { maxDrawdownPct, pctOfCents, periodReturnPct, scenarioOutcomes, type Scenario } from "@/lib/behavior";
import { EXCHANGE_SYMBOLS, OrderRejected, REJECT_TEXT, postOrder, type TradeSide } from "@/lib/exchangeApi";
import { getStockSnapshot } from "@/lib/stockApi";

const HOLDS = [
  { value: 1, label: "1 day" },
  { value: 5, label: "1 week" },
  { value: 21, label: "1 month" },
];

type History = { state: "loading" } | { state: "error" } | { state: "ready"; closes: number[] };

function Histogram({ scenario }: { scenario: Scenario }) {
  const peak = Math.max(...scenario.bins);
  const width = (scenario.maxPct - scenario.minPct) / scenario.bins.length;
  return (
    <div>
      <div className="flex h-20 items-end gap-0.5 border-b border-line-strong" role="img" aria-label={`Spread of ${scenario.windows} past outcomes from ${fmtPct(scenario.minPct, 1)} to ${fmtPct(scenario.maxPct, 1)}`}>
        {scenario.bins.map((count, i) => {
          const loss = scenario.minPct + width * (i + 0.5) < 0;
          return <div key={i} className={`flex-1 rounded-t-sm ${loss ? "bg-down" : "bg-up"}`} style={{ height: `${(count / peak) * 100}%` }} title={`${count} past periods`} />;
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-faint">
        <span>{fmtPct(scenario.minPct, 1)}</span>
        <span>{fmtPct(scenario.maxPct, 1)}</span>
      </div>
    </div>
  );
}

function Review({ symbol, side, qty, priceCents, onBack, onSend, sending }: {
  symbol: string; side: TradeSide; qty: number; priceCents: number; onBack: () => void; onSend: () => void; sending: boolean;
}) {
  const [history, setHistory] = useState<History>({ state: "loading" });
  const [hold, setHold] = useState(5);
  const value = qty * priceCents;

  useEffect(() => {
    const controller = new AbortController();
    setHistory({ state: "loading" });
    getStockSnapshot(symbol, "1y", controller.signal)
      .then((snap) => setHistory({ state: "ready", closes: snap.history.map((p) => p.close) }))
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setHistory({ state: "error" });
      });
    return () => controller.abort();
  }, [symbol]);

  const closes = history.state === "ready" ? history.closes : [];
  const yearReturn = periodReturnPct(closes);
  const drawdown = maxDrawdownPct(closes);
  const scenario = history.state === "ready" ? scenarioOutcomes(closes, hold, side) : null;

  return (
    <div className="space-y-4 p-4" aria-live="polite">
      <p className="text-sm text-strong">
        <span className={side === "BUY" ? "text-up" : "text-down"}>{side === "BUY" ? "Buy" : "Sell"}</span> {qty.toLocaleString()} {symbol} at {dollars(priceCents)}
        <span className="text-muted"> · order value </span><span className="font-mono">{dollars(value)}</span>
      </p>

      {history.state === "loading" && <p className="text-sm text-muted">Loading a year of price history…</p>}
      {history.state === "error" && <p className="text-sm text-muted">Price history is not available right now (is market-data running on port 8000?). You can still send the order.</p>}

      {history.state === "ready" && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
            <div className="bg-surface px-3 py-2">
              <div className="text-xs text-muted">Past year: return</div>
              <div className={`font-mono text-base ${yearReturn !== null && yearReturn < 0 ? "text-down" : "text-up"}`}>{yearReturn !== null ? fmtPct(yearReturn, 1) : DASH}</div>
            </div>
            <div className="bg-surface px-3 py-2">
              <div className="text-xs text-muted">Past year: worst fall from a peak</div>
              <div className="font-mono text-base text-down">{fmtPct(drawdown, 1)}</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-strong">If you held it for</span>
              <Segmented label="Holding period" value={hold} options={HOLDS} onChange={setHold} />
            </div>
            {scenario ? (
              <>
                <Histogram scenario={scenario} />
                <p className="text-sm text-fg">
                  In {scenario.windows} past periods of this length, a position like this ended between{" "}
                  <span className="font-mono text-down">{signedDollars(pctOfCents(scenario.p5, value))}</span> and{" "}
                  <span className="font-mono text-up">{signedDollars(pctOfCents(scenario.p95, value))}</span> in 90% of cases (middle:{" "}
                  <span className="font-mono">{signedDollars(pctOfCents(scenario.median, value))}</span>), and lost money in{" "}
                  <span className="font-mono">{scenario.chanceOfLoss.toFixed(0)}%</span> of them.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">Not enough history to show outcomes for this holding period.</p>
            )}
            <p className="text-xs text-muted">Past results, applied to this order value. They are not a forecast.</p>
          </div>
        </>
      )}

      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={onBack} disabled={sending}>Edit order</button>
        <button type="button" className={primaryButtonClass} onClick={onSend} disabled={sending}>{sending ? "Sending…" : "Confirm and send"}</button>
      </div>
    </div>
  );
}

export function OrderTicket({ symbol, onSymbol, online }: { symbol: string; onSymbol: (s: string) => void; online: boolean }) {
  const [side, setSide] = useState<TradeSide>("BUY");
  const [qty, setQty] = useState("100");
  const [price, setPrice] = useState("189.50");
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const qtyNumber = Number(qty);
  const priceCents = parseCents(price);
  const qtyOk = Number.isInteger(qtyNumber) && qtyNumber >= 1 && qtyNumber <= 100_000;
  const problem = !qtyOk ? "Quantity must be a whole number from 1 to 100,000." : priceCents === null ? "Price must be a positive amount like 189.50." : null;

  const send = async () => {
    if (priceCents === null) return;
    setSending(true);
    try {
      const id = await postOrder({ symbol, side, price: priceCents, qty: qtyNumber });
      setMessage({ ok: true, text: `Order ${id} accepted by the engine: ${side} ${qtyNumber} ${symbol} at ${dollars(priceCents)}.` });
      setReviewing(false);
    } catch (e) {
      const text = e instanceof OrderRejected ? REJECT_TEXT[e.reason] ?? `Rejected: ${e.reason}.` : e instanceof Error ? e.message : "The order could not be sent.";
      setMessage({ ok: false, text });
      setReviewing(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Panel
      title="Order ticket"
      description="Sends a limit order to the engine as a manual trader."
      action={<><WhyChip slug="kaufmann-2013-graphical-displays" /><Badge kind="simulated" label="PAPER MONEY" /></>}
    >
      {reviewing && priceCents !== null ? (
        <Review symbol={symbol} side={side} qty={qtyNumber} priceCents={priceCents} onBack={() => setReviewing(false)} onSend={send} sending={sending} />
      ) : (
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            if (!problem) setReviewing(true);
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="Side" value={side} options={[{ value: "BUY", label: "Buy" }, { value: "SELL", label: "Sell" }]} onChange={setSide} />
            <div className="flex items-center gap-2">
              <label htmlFor="ticket-symbol" className="text-xs text-muted">Symbol</label>
              <select id="ticket-symbol" value={symbol} onChange={(e) => onSymbol(e.target.value)} className="rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-sm text-strong">
                {EXCHANGE_SYMBOLS.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-muted">Shares
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">Limit price (USD)
              <input className={`${inputClass} mt-1`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
          </div>
          {problem && <p className="text-sm text-down">{problem}</p>}
          <button type="submit" className={primaryButtonClass} disabled={!online || problem !== null}>Review order</button>
          {!online && <p className="text-sm text-muted">The engine is not connected, so orders cannot be sent. Start the stack with ./build.sh.</p>}
          {message && <p role="status" className={`text-sm ${message.ok ? "text-up" : "text-down"}`}>{message.text}</p>}
        </form>
      )}
    </Panel>
  );
}

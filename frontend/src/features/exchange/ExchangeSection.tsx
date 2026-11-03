// The "Exchange" section: the 24 virtual traders and the trades they made (cash and shares come from real fills).
import { Notice, Panel } from "@/components/ui";
import { DASH, dollars, fmtInt, signedDollars } from "@/lib/format";
import type { ExchangeHealth, LiveTrade, Trader } from "@/lib/exchangeApi";

type Props = { online: boolean; health: ExchangeHealth | null; traders: Trader[]; trades: LiveTrade[] };

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function TradersPanel({ online, traders }: { online: boolean; traders: Trader[] }) {
  return (
    <Panel
      title="Virtual traders"
      description="24 accounts that trade by simple rules. Cash, shares and profit change only when one of their orders is filled."
    >
      {traders.length === 0 ? (
        <Notice title="No trader data">{online ? "Waiting for the first update." : "exchange-api is not reachable. Start the stack with ./build.sh."}</Notice>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-medium">Trader</th>
                <th className="px-3 py-2 text-left font-medium">Strategy</th>
                <th className="px-3 py-2 text-right font-medium">Cash</th>
                <th className="px-3 py-2 text-right font-medium">Total value</th>
                <th className="px-3 py-2 text-right font-medium">Realized profit</th>
                <th className="px-3 py-2 text-right font-medium">Fills</th>
                <th className="px-4 py-2 text-left font-medium">Last order</th>
              </tr>
            </thead>
            <tbody>
              {traders.map((t) => (
                <tr key={t.trader_id} className="border-b border-line last:border-0 hover:bg-raised">
                  <td className="px-4 py-1.5"><span className="font-mono text-faint">{String(t.trader_id).padStart(2, "0")}</span> <span className="text-strong">{t.name}</span></td>
                  <td className="px-3 py-1.5 text-muted">{t.strategy}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{dollars(t.cash)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{dollars(t.equity)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${t.realized_pnl > 0 ? "text-up" : t.realized_pnl < 0 ? "text-down" : "text-muted"}`}>{signedDollars(t.realized_pnl)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{t.trades}</td>
                  <td className="max-w-48 truncate px-4 py-1.5 font-mono text-muted">{t.last_action || DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function TradeFeed({ online, trades, traders }: { online: boolean; trades: LiveTrade[]; traders: Trader[] }) {
  const name = (id: number) => (id === 0 ? "Manual" : traders.find((t) => t.trader_id === id)?.name ?? `Trader ${id}`);
  return (
    <Panel title="Trades" description="Newest first. Every trade is also saved by the Rust database." action={<span className="font-mono text-xs text-muted">{trades.length} shown</span>}>
      {trades.length === 0 ? (
        <Notice title="No trades yet">{online ? "Press Start so the virtual traders send orders." : "exchange-api is not reachable."}</Notice>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-medium">Trade</th>
                <th className="px-3 py-2 text-left font-medium">Symbol</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Shares</th>
                <th className="px-3 py-2 text-left font-medium">Buyer</th>
                <th className="px-3 py-2 text-left font-medium">Seller</th>
                <th className="px-4 py-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 100).map((t) => (
                <tr key={t.trade_id} className="border-b border-line last:border-0 hover:bg-raised">
                  <td className="px-4 py-1.5 font-mono text-faint">{t.trade_id}</td>
                  <td className="px-3 py-1.5 font-mono text-strong">{t.symbol}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{dollars(t.price)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmtInt(t.qty)}</td>
                  <td className="px-3 py-1.5 text-muted">{name(t.buyer_id)}</td>
                  <td className="px-3 py-1.5 text-muted">{name(t.seller_id)}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-faint">{timeOf(t.ts_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ExchangeSection({ online, health, traders, trades }: Props) {
  return (
    <section id="exchange" className="scroll-mt-20 space-y-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xl font-semibold text-strong">Exchange</h2>
        <p className="text-sm text-muted">
          exchange-api {online ? "is reachable" : "is not reachable"}
          {health && <> · engine {health.engine} · {fmtInt(health.trades)} trades saved</>}
        </p>
      </div>
      <TradersPanel online={online} traders={traders} />
      <TradeFeed online={online} trades={trades} traders={traders} />
    </section>
  );
}

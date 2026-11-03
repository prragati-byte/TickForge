import { useEffect, useState } from "react";
import { getExchangeHealth, getRecentTrades, getTraders, watchTraders, watchTrades, type ExchangeHealth, type LiveTrade, type Trader } from "@/lib/exchangeApi";

const MAX_TRADES = 200;

/** Health, the 24 traders and the recent trades from exchange-api. `online` is false until the first answer. */
export function useExchange() {
  const [health, setHealth] = useState<ExchangeHealth | null>(null);
  const [online, setOnline] = useState(false);
  const [traders, setTraders] = useState<Trader[]>([]);
  const [trades, setTrades] = useState<LiveTrade[]>([]);

  useEffect(() => {
    const poll = async () => {
      try {
        setHealth(await getExchangeHealth());
        setOnline(true);
      } catch {
        setOnline(false);
        setHealth(null);
      }
    };
    poll();
    const timer = window.setInterval(poll, 5000);

    getRecentTrades(50).then(setTrades).catch(() => {});
    getTraders().then(setTraders).catch(() => {});
    const stopTrades = watchTrades(
      (trade) => setTrades((prev) => [trade, ...prev].slice(0, MAX_TRADES)),
      (history) => setTrades(history),
    );
    const stopTraders = watchTraders(setTraders);
    return () => {
      window.clearInterval(timer);
      stopTrades();
      stopTraders();
    };
  }, []);

  return { health, online, traders, trades };
}

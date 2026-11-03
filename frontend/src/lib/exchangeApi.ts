// REST and WebSocket helpers for exchange-api (port 8001). Prices are integer cents.
import { useEffect, useState } from "react";

const EXCHANGE_URL = (import.meta.env.VITE_EXCHANGE_API_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
const EXCHANGE_WS = EXCHANGE_URL.replace(/^http/, "ws");

export const EXCHANGE_SYMBOLS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "JPM", "BRK-B", "AMD"] as const;

export type TradeSide = "BUY" | "SELL";

export type LiveTrade = {
  trade_id: number;
  symbol: string;
  price: number; // cents
  qty: number;
  buyer_id: number;
  seller_id: number;
  ts_ms: number;
};

export type Trader = {
  trader_id: number;
  name: string;
  strategy: string;
  cash: number; // cents
  holdings: Record<string, number>;
  realized_pnl: number; // cents
  equity: number; // cents, at the last trade prices
  trades: number;
  last_action: string;
};

export type OrderBook = { symbol: string; bids: [number, number][]; asks: [number, number][] };

export type ExchangeHealth = { status: string; engine: "connected" | "disconnected"; trades: number };

export class OrderRejected extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

async function exchangeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${EXCHANGE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`exchange-api ${res.status}`);
  return res.json() as Promise<T>;
}

export const getExchangeHealth = () => exchangeFetch<ExchangeHealth>("/health");
export const getTraders = async () => (await exchangeFetch<{ traders: Trader[] }>("/traders")).traders;
export const getRecentTrades = async (limit = 50) => (await exchangeFetch<{ trades: LiveTrade[] }>(`/trades?limit=${limit}`)).trades;
export const getOrderBook = (symbol: string) => exchangeFetch<OrderBook>(`/orderbook?symbol=${encodeURIComponent(symbol)}`);

/** Send a manual order (trader_id 0). Throws OrderRejected with the engine's reason, or Error if the API is down. */
export async function postOrder(order: { symbol: string; side: TradeSide; price: number; qty: number }): Promise<number> {
  const res = await fetch(`${EXCHANGE_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trader_id: 0, ...order }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { detail?: { reason?: string } };
    throw new OrderRejected(body.detail?.reason ?? "rejected");
  }
  if (!res.ok) throw new Error(res.status === 503 ? "The matching engine is not reachable." : `exchange-api ${res.status}`);
  return ((await res.json()) as { order_id: number }).order_id;
}

/** Plain-English text for the engine's reject reasons. */
export const REJECT_TEXT: Record<string, string> = {
  max_qty: "The quantity is above the engine limit.",
  price_band: "The price is too far from the last trade price.",
  unknown_symbol: "The engine does not know this symbol.",
  bad_request: "The engine could not read the order.",
  unknown_order: "That order is not on the book.",
};

/** Keep one WebSocket open (with retry) and hand every parsed JSON message to `onMessage`. Returns a close function. */
function watch(path: string, onMessage: (data: unknown) => void): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let closed = false;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    socket = new WebSocket(`${EXCHANGE_WS}${path}`);
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data as string));
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (closed) return;
      attempt += 1;
      timer = window.setTimeout(open, Math.min(5000, 1000 * attempt));
    };
    socket.onerror = () => socket?.close();
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    socket?.close();
  };
}

export function watchTrades(onTrade: (trade: LiveTrade) => void, onHistory: (trades: LiveTrade[]) => void): () => void {
  return watch("/ws/trades", (data) => {
    const d = data as { type?: string; trades?: LiveTrade[]; trade_id?: number };
    if (d.type === "history" && Array.isArray(d.trades)) onHistory(d.trades);
    else if (d.trade_id !== undefined) onTrade(d as LiveTrade);
  });
}

export function watchTraders(onUpdate: (traders: Trader[]) => void): () => void {
  return watch("/ws/traders", (data) => {
    const d = data as { traders?: Trader[] };
    if (Array.isArray(d.traders)) onUpdate(d.traders);
  });
}

/** Live order book for one symbol from /ws/orderbook. `null` until the first snapshot arrives. */
export function useOrderBook(symbol: string): OrderBook | null {
  const [book, setBook] = useState<OrderBook | null>(null);
  useEffect(() => {
    setBook(null);
    return watch(`/ws/orderbook?symbol=${encodeURIComponent(symbol)}`, (data) => {
      const d = data as Partial<OrderBook>;
      if (d.symbol === symbol && Array.isArray(d.bids) && Array.isArray(d.asks)) setBook(d as OrderBook);
    });
  }, [symbol]);
  return book;
}

// Live engine numbers from exchange-api (/ws/telemetry). Prices are integer cents.
import { useCallback, useEffect, useRef, useState } from "react";

export type EngineState = "closed" | "running" | "paused" | "stopped";
export type LinkState = "connecting" | "live" | "offline";

/** price is in cents */
export type BookLevel = { price: number; qty: number };
/** price is in cents; buy and sell are virtual trader ids (0 = a manual order) */
export type EngineTrade = { id: number; price: number; qty: number; buy: number; sell: number };

export type EngineStats = {
  uptime: number;
  speed: number;
  submitted: number;
  processed: number;
  queueDepth: number;
  ordersPerSec: number;
  tradesTotal: number;
  tradesPerSec: number;
  avgLatencyUs: number;
  p50LatencyUs: number;
  p99LatencyUs: number;
  cpuPct: number;
  rssMb: number;
  threads: number;
  latHist: number[];
  producers: number[];
  bids: BookLevel[];
  asks: BookLevel[];
};

export type TelemetryMessage =
  | { type: "status"; state: EngineState; error: string }
  | { type: "stats"; stats: EngineStats; trades: EngineTrade[] };

export type TelemetryCommand =
  | { cmd: "start" | "pause" | "stop" | "reset" }
  | { cmd: "speed"; value: 1 | 10 | 100 }
  | { cmd: "order"; side: "BUY" | "SELL"; qty: number; price: number };

export const TELEMETRY_URL: string = import.meta.env.VITE_TELEMETRY_URL || "ws://127.0.0.1:8001/ws/telemetry";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numArray = (value: unknown): number[] => (Array.isArray(value) ? value.map(num) : []);

function levels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  const out: BookLevel[] = [];
  for (const item of value) {
    if (Array.isArray(item) && item.length === 2) out.push({ price: num(item[0]), qty: num(item[1]) });
  }
  return out;
}

function parseStats(d: Record<string, unknown>): EngineStats {
  const book = (d.book && typeof d.book === "object" ? d.book : {}) as Record<string, unknown>;
  return {
    uptime: num(d.uptime_s),
    speed: num(d.speed),
    submitted: num(d.submitted),
    processed: num(d.processed),
    queueDepth: num(d.queue_depth),
    ordersPerSec: num(d.orders_per_sec),
    tradesTotal: num(d.trades_total),
    tradesPerSec: num(d.trades_per_sec),
    avgLatencyUs: num(d.avg_latency_us),
    p50LatencyUs: num(d.p50_latency_us),
    p99LatencyUs: num(d.p99_latency_us),
    cpuPct: num(d.cpu_pct),
    rssMb: num(d.rss_mb),
    threads: num(d.threads),
    latHist: numArray(d.lat_hist),
    producers: numArray(d.producers),
    bids: levels(book.bids),
    asks: levels(book.asks),
  };
}

function parseTrades(value: unknown): EngineTrade[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ id: num(t.id), price: num(t.price), qty: num(t.qty), buy: num(t.buy), sell: num(t.sell) }));
}

/** Turn one WebSocket text frame into a typed message. Returns null for anything that is not a known message. */
export function parseTelemetry(raw: string): TelemetryMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  if (d.type === "status") {
    const state = d.state;
    if (state !== "closed" && state !== "running" && state !== "paused" && state !== "stopped") return null;
    return { type: "status", state, error: typeof d.error === "string" ? d.error : "" };
  }
  if (d.type === "stats") return { type: "stats", stats: parseStats(d), trades: parseTrades(d.trades) };
  return null;
}

const MAX_TRADES = 12;

export function useTelemetry() {
  const [link, setLink] = useState<LinkState>("connecting");
  const [engineState, setEngineState] = useState<EngineState>("closed");
  const [engineError, setEngineError] = useState("");
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [trades, setTrades] = useState<EngineTrade[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(TELEMETRY_URL);
      } catch {
        setLink("offline");
        attempt += 1;
        retryTimer = window.setTimeout(connect, Math.min(5000, 1000 * attempt));
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        setLink("live");
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = parseTelemetry(event.data);
        if (!message) return;
        if (message.type === "status") {
          setEngineState(message.state);
          setEngineError(message.error);
          if (message.state === "closed") {
            setStats(null);
            setTrades([]);
          }
        } else {
          setStats(message.stats);
          if (message.trades.length > 0) {
            // the server sends oldest first; the tape shows newest first
            setTrades((prev) => [...message.trades.reverse(), ...prev].slice(0, MAX_TRADES));
          }
        }
      };

      // Handle a dropped / failed connection exactly once. Some browsers fire only `error`
      // (never `close`) when the server is unreachable, so both events lead here.
      let dropped = false;
      const handleDrop = () => {
        if (dropped) return;
        dropped = true;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setLink("offline");
        setEngineState("closed");
        setStats(null);
        attempt += 1;
        retryTimer = window.setTimeout(connect, Math.min(5000, 1000 * attempt));
      };
      socket.onclose = handleDrop;
      socket.onerror = handleDrop;
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((command: TelemetryCommand): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  return { link, engineState, engineError, stats, trades, send };
}

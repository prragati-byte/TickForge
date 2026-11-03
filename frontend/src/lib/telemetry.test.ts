import { describe, expect, it } from "vitest";
import { parseTelemetry } from "./telemetry";

// The exact shape exchange-api sends (docs/CONTRACTS.md section 5).
const STATS = {
  type: "stats",
  uptime_s: 12.5,
  speed: 10,
  submitted: 4100,
  processed: 4090,
  queue_depth: 10,
  orders_per_sec: 812,
  trades_total: 903,
  trades_per_sec: 140,
  avg_latency_us: 9.2,
  p50_latency_us: 7,
  p99_latency_us: 41,
  cpu_pct: 8.1,
  rss_mb: 14.2,
  threads: 4,
  lat_hist: [0, 12, 340],
  producers: [2100, 2000],
  book: { bids: [[18950, 40], [18940, 500]], asks: [[18960, 70]] },
  trades: [{ id: 903, price: 18950, qty: 60, buy: 7, sell: 12 }],
};

describe("parseTelemetry", () => {
  it("reads a status message", () => {
    expect(parseTelemetry('{"type":"status","state":"running","error":""}')).toEqual({ type: "status", state: "running", error: "" });
    expect(parseTelemetry('{"type":"status","state":"closed","error":"engine not reachable"}')).toEqual({
      type: "status", state: "closed", error: "engine not reachable",
    });
  });

  it("reads every field of a stats message, keeping prices in cents", () => {
    const message = parseTelemetry(JSON.stringify(STATS));
    expect(message?.type).toBe("stats");
    if (message?.type !== "stats") return;
    expect(message.stats).toEqual({
      uptime: 12.5, speed: 10, submitted: 4100, processed: 4090, queueDepth: 10, ordersPerSec: 812,
      tradesTotal: 903, tradesPerSec: 140, avgLatencyUs: 9.2, p50LatencyUs: 7, p99LatencyUs: 41,
      cpuPct: 8.1, rssMb: 14.2, threads: 4, latHist: [0, 12, 340], producers: [2100, 2000],
      bids: [{ price: 18950, qty: 40 }, { price: 18940, qty: 500 }],
      asks: [{ price: 18960, qty: 70 }],
    });
    expect(message.trades).toEqual([{ id: 903, price: 18950, qty: 60, buy: 7, sell: 12 }]);
  });

  it("turns missing or wrong-typed fields into zero or empty lists", () => {
    const message = parseTelemetry('{"type":"stats","uptime_s":"x","lat_hist":"no","book":null,"trades":[1,null]}');
    expect(message?.type).toBe("stats");
    if (message?.type !== "stats") return;
    expect(message.stats.uptime).toBe(0);
    expect(message.stats.latHist).toEqual([]);
    expect(message.stats.bids).toEqual([]);
    expect(message.trades).toEqual([]);
  });

  it("ignores malformed book levels", () => {
    const message = parseTelemetry(JSON.stringify({ type: "stats", book: { bids: [[1], [2, 3], "x"], asks: [] } }));
    if (message?.type !== "stats") throw new Error("expected stats");
    expect(message.stats.bids).toEqual([{ price: 2, qty: 3 }]);
  });

  it("returns null for anything that is not a known message", () => {
    for (const raw of ["not json", "null", "42", '{"type":"hello"}', '{"type":"status","state":"exploded"}', "[]"]) {
      expect(parseTelemetry(raw)).toBeNull();
    }
  });
});

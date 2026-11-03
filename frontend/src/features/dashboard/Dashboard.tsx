// The dashboard page: header, simulation controls and the sections (engine, market, exchange, journey).
import { Icon } from "@/components/Icon";
import { Badge, Panel, Segmented, buttonClass } from "@/components/ui";
import { ExchangeSection } from "@/features/exchange/ExchangeSection";
import { useExchange } from "@/features/exchange/useExchange";
import { MarketSection } from "@/features/market/MarketSection";
import { Link, researchPath } from "@/lib/router";
import { scrollToSection, useActiveSection } from "@/lib/scroll";
import { TELEMETRY_URL, useTelemetry, type EngineState } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";
import { EngineSection } from "./EngineSection";

const NAV = [
  { id: "engine", label: "Engine" },
  { id: "market", label: "Market" },
  { id: "journey", label: "Journey" },
  { id: "exchange", label: "Exchange" },
  { id: "status", label: "Status" },
];
const NAV_IDS = NAV.map((n) => n.id);

const STATE_TEXT: Record<EngineState, string> = {
  closed: "Engine not connected",
  running: "Virtual traders running",
  paused: "Virtual traders paused",
  stopped: "Virtual traders stopped",
};

const PLANNED = [
  "Kernel bypass networking (AF_XDP)",
  "Multi-node replication",
];

export default function Dashboard() {
  const { link, engineState, engineError, stats, send } = useTelemetry();
  const { health, online, traders, trades } = useExchange();
  const active = useActiveSection(NAV_IDS);
  const { theme, toggle } = useTheme();

  const live = link === "live";
  const engineUp = live && engineState !== "closed";
  const running = engineState === "running";

  const linkText = live ? (engineUp ? "Live engine data" : "exchange-api up, engine down") : link === "connecting" ? "Connecting…" : "Offline";
  const linkTone = engineUp ? "bg-up" : link === "connecting" ? "bg-warn animate-pulse" : "bg-down";

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 lg:px-8">
          <button type="button" className="text-lg font-semibold tracking-tight text-strong" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            TickForge
          </button>
          <nav aria-label="Sections" className="order-last flex w-full gap-1 overflow-x-auto md:order-none md:w-auto">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={active === item.id ? "true" : undefined}
                onClick={() => scrollToSection(item.id)}
                className={`rounded-md px-3 py-1.5 text-sm ${active === item.id ? "bg-raised text-strong" : "text-muted hover:text-strong"}`}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-2 text-sm text-muted" title={`Telemetry: ${TELEMETRY_URL}`}>
              <span className={`size-2 rounded-full ${linkTone}`} aria-hidden="true" />
              {linkText}
            </span>
            <Link to={researchPath.home} className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-strong hover:bg-raised">
              How&rsquo;z that!
            </Link>
            <button type="button" onClick={toggle} className={`${buttonClass} !px-2`} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 lg:px-8">
        <div className="flex flex-wrap items-center gap-3 border-b border-line py-4" role="region" aria-label="Simulation controls">
          <div className="mr-auto">
            <p className="text-sm font-medium text-strong">{STATE_TEXT[live ? engineState : "closed"]}</p>
            <p className="text-sm text-muted">
              {engineUp
                ? "Orders come from 24 virtual traders using paper money. Numbers below are live."
                : "Start the stack with ./build.sh to see live data. Nothing below is invented while it is offline."}
            </p>
            {engineError && <p className="text-sm text-down">{engineError}</p>}
          </div>
          <Badge kind={engineUp ? "live" : "sample"} label={engineUp ? "LIVE" : "OFFLINE"} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonClass} disabled={!engineUp || running} onClick={() => send({ cmd: "start" })}><Icon name="play" />Start</button>
            <button type="button" className={buttonClass} disabled={!engineUp || !running} onClick={() => send({ cmd: "pause" })}><Icon name="pause" />Pause</button>
            <button type="button" className={buttonClass} disabled={!engineUp || engineState === "stopped"} onClick={() => send({ cmd: "stop" })}><Icon name="stop" />Stop</button>
            <button type="button" className={buttonClass} disabled={!engineUp} onClick={() => send({ cmd: "reset" })} title="Gives every virtual trader the starting cash and shares again"><Icon name="reset" />Reset traders</button>
            <Segmented
              label="Trader speed"
              value={stats?.speed ?? 1}
              options={[{ value: 1, label: "1x" }, { value: 10, label: "10x" }, { value: 100, label: "100x" }]}
              onChange={(value) => send({ cmd: "speed", value: value as 1 | 10 | 100 })}
            />
          </div>
        </div>

        <EngineSection stats={stats} linkLive={live} health={health} trades={trades} />
        <MarketSection />
        <ExchangeSection online={online} health={health} traders={traders} trades={trades} />

        <section id="status" className="scroll-mt-20 space-y-4 py-8">
          <h2 className="text-xl font-semibold text-strong">Status</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Running now" description="Read from the live services, not from a list.">
              <dl className="divide-y divide-line text-sm">
                {([
                  ["exchange-api (port 8001)", online ? "reachable" : "not reachable", online],
                  ["Matching engine (port 9100)", health?.engine === "connected" ? "connected" : "not connected", health?.engine === "connected"],
                  ["Trades saved in the database", health ? String(health.trades) : "unknown", health !== null],
                  ["Virtual traders", traders.length > 0 ? `${traders.length} accounts` : "no data", traders.length > 0],
                ] as const).map(([label, value, ok]) => (
                  <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <dt className="text-muted">{label}</dt>
                    <dd className={`font-mono ${ok ? "text-up" : "text-faint"}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
            <Panel title="Planned, not built" action={<Badge kind="planned" />}>
              <ul className="divide-y divide-line text-sm">
                {PLANNED.map((item) => <li key={item} className="px-4 py-2.5 text-muted">{item}</li>)}
              </ul>
            </Panel>
          </div>
        </section>

        <footer className="border-t border-line py-6 text-sm text-muted">
          TickForge is a university project. Orders use paper money, and the virtual traders and their start prices are simulated.
        </footer>
      </main>
    </div>
  );
}

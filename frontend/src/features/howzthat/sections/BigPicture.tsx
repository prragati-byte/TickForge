import { ABSTRACT, OBJECTIVE, type Status, THEMES } from "../content";
import { Card, Section, pillFor } from "../parts";
import { Eyebrow } from "@/components/Prose";

export function Connector({ label, dir = "right" }: { label: string; dir?: "right" | "left" }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-xs text-faint lg:flex-col lg:gap-1 lg:py-0">
      <span aria-hidden="true" className="text-faint lg:hidden">↓</span>
      <span className="text-center font-mono leading-tight">{label}</span>
      <span aria-hidden="true" className="hidden text-base text-faint lg:block">{dir === "right" ? "⟶" : "⟵"}</span>
    </div>
  );
}

export function MapBox({ title, sub, items, status = "implemented", className = "" }: { title: string; sub: string; items?: string[]; status?: Status; className?: string }) {
  return (
    <div className={`rounded-xl border p-3 ${status === "planned" ? "border-dashed border-line-strong" : "border-line-strong bg-surface"} ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-strong">{title}</div>
          <div className="text-xs text-muted">{sub}</div>
        </div>
        {status !== "implemented" && pillFor(status)}
      </div>
      {items && (
        <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs text-fg">
          {items.map((item, i) => (
            <li key={item} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true" className="text-faint">→</span>}
              <span className="rounded border border-line-strong bg-canvas/60 px-1.5 py-0.5">{item}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** High-level system map: processes and how they talk. Planned parts are dashed. */
export function SystemMap() {
  return (
    <figure className="rounded-2xl border border-line bg-canvas/50 p-4">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>System map · as built today</Eyebrow>
        <span className="text-xs text-faint">Dashed = not built, partial = built with a stated part missing</span>
      </figcaption>
      <div className="grid gap-2 lg:grid-cols-[1.6fr_6.5rem_1fr_6.5rem_1fr] [&>*]:min-w-0 lg:items-center">
        <MapBox
          title="Matching engine · C++17"
          sub="engine_server, TCP port 9100"
          items={["connection threads", "WAL", "MPSC queue", "matching thread", "order books"]}
          className="lg:col-start-1 lg:row-start-1"
        />
        <div className="lg:col-start-2 lg:row-start-1"><Connector label="TCP :9100 · JSON lines" /></div>
        <MapBox title="exchange-api · FastAPI" sub="orders, 24 traders, live numbers" className="lg:col-start-3 lg:row-start-1" />
        <div className="lg:col-start-4 lg:row-start-1"><Connector label="HTTP + WebSocket :8001" /></div>
        <MapBox title="Browser · React" sub="dashboard and this page" items={["engine panels", "market data", "Journey"]} className="lg:col-start-5 lg:row-span-2 lg:row-start-1 lg:self-stretch" />
        <MapBox title="Yahoo Finance" sub="external price data" className="lg:col-start-1 lg:row-start-2" />
        <div className="lg:col-start-2 lg:row-start-2"><Connector label="yfinance" /></div>
        <MapBox title="Market-data API · FastAPI" sub="whitelist · cache · Journey analytics" className="lg:col-start-3 lg:row-start-2" />
        <div className="lg:col-start-4 lg:row-start-2"><Connector label="HTTP :8000" /></div>
        <MapBox
          title="Trade database · Rust"
          sub="tickforge_db, used by exchange-api in-process; compaction throttling is planned"
          items={["MemTable", "SSTables", "Bloom filter", "compaction"]}
          status="partial"
          className="lg:col-start-1 lg:row-start-3"
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-faint">
        The engine and the market-data API are independent: the engine trades 30 symbols from the virtual traders&apos; orders (paper money), while the API serves real S&amp;P 500 prices. They are never mixed on one chart.
      </p>
    </figure>
  );
}

export function BigPicture() {
  return (
    <Section id="big-picture" lead="What TickForge is, what it is trying to achieve, and the parts it is made of.">
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr] [&>*]:min-w-0">
        <Card>
          <Eyebrow>Abstract</Eyebrow>
          <p className="mt-2 text-sm leading-relaxed text-fg">{ABSTRACT}</p>
        </Card>
        <Card className="border-accent/25 bg-accent/[0.04]">
          <Eyebrow className="text-accent">Engineering objective</Eyebrow>
          <p className="mt-2 text-sm leading-relaxed text-fg">{OBJECTIVE}</p>
        </Card>
      </div>
      <SystemMap />
      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Technical themes</h3>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEMES.map((t) => (
            <li key={t.title}>
              <Card className="h-full">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold text-strong">{t.title}</div>
                  {pillFor(t.status)}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{t.text}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

// ---- 02 ------------------------------------------------------------------------------------------------

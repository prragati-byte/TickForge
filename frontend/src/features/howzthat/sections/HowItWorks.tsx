import { COMPONENTS, ENGINE_FLOW, type FlowNode, MARKET_FLOW, type Problem, STORAGE_FLOW } from "../content";
import { Card, Field, Files, Section, pillFor, scrollToId } from "../parts";
import { Eyebrow } from "@/components/Prose";

export function FlowLane({ title, nodes, planned = false }: { title: string; nodes: FlowNode[]; planned?: boolean }) {
  return (
    <div>
      <Eyebrow className="mb-2">{title}</Eyebrow>
      <ol className="flex flex-col gap-1 lg:flex-row lg:flex-wrap lg:items-stretch" aria-label={title}>
        {nodes.map((n, i) => (
          <li key={`${n.label}-${i}`} className="flex flex-col items-stretch gap-1 lg:flex-row lg:items-center">
            {i > 0 && <span aria-hidden="true" className="text-center text-faint lg:px-0.5">{/* arrow */}<span className="lg:hidden">↓</span><span className="hidden lg:inline">→</span></span>}
            <a
              href={n.component ? `#component-${n.component}` : undefined}
              onClick={(event) => {
                if (!n.component) return;
                event.preventDefault();
                scrollToId(`component-${n.component}`);
              }}
              className={`block rounded-lg border px-2.5 py-1.5 transition hover:border-accent/50 ${
 n.status === "planned" || planned ? "border-dashed border-line-strong text-muted" : "border-line-strong bg-surface text-fg"
 }`}
            >
              <span className="block text-xs font-semibold">{n.label}</span>
              <span className="block text-xs text-faint">{n.detail}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HowItWorks() {
  return (
    <Section
      id="how-tickforge-works"
      lead="From an order being created to a number on screen. Each box links to its component below; dashed boxes are designed but not built."
    >
      <figure className="space-y-5 rounded-2xl border border-line bg-canvas/50 p-4">
        <figcaption className="sr-only">Data flow through TickForge: the engine path, the market-data path, and the storage path.</figcaption>
        <FlowLane title="Engine path · implemented" nodes={ENGINE_FLOW} />
        <FlowLane title="Market-data path · implemented" nodes={MARKET_FLOW} />
        <FlowLane title="Storage path · built, with parts still planned" nodes={STORAGE_FLOW} />
      </figure>

      <ul className="grid gap-3 md:grid-cols-2">
        {COMPONENTS.map((c) => (
          <li key={c.id} id={`component-${c.id}`} className="scroll-mt-20">
            <Card className="h-full" dashed={c.status === "planned"}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-strong">{c.name}</h3>
                {pillFor(c.status)}
              </div>
              <dl className="mt-3 space-y-2.5">
                <Field label="Responsibility">{c.responsibility}</Field>
                {c.problem !== "—" && <Field label="Problem it addresses">{c.problem}</Field>}
                {c.talksTo !== "—" && <Field label="Talks to">{c.talksTo}</Field>}
              </dl>
              {c.files.length > 0 && (
                <div className="mt-3">
                  <Files files={c.files} />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- 05 ------------------------------------------------------------------------------------------------

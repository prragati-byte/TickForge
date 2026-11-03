import { CAPABILITIES, DIFFERENTIATORS, type Differentiator, type Problem, type Status } from "../content";
import { Card, Field, Files, PaperLinks, Section, pillFor } from "../parts";
import { StatusPill } from "@/components/Prose";


export function DifferentiatorItem({ d }: { d: Differentiator }) {
  return (
    <details className="group rounded-xl border border-line bg-surface/60 open:bg-surface/80">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-faint transition group-open:rotate-90 motion-reduce:transition-none">▸</span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-strong">{d.title}</span>
        {pillFor(d.status)}
      </summary>
      <div className="border-t border-line px-4 py-4">
        <dl className="grid gap-4 md:grid-cols-2">
          <Field label="1 · Problem">{d.problem}</Field>
          <Field label="2 · Existing research">{d.research}</Field>
          <Field label="3 · Our approach">{d.approach}</Field>
          <Field label="4 · What we actually built">{d.implementation}</Field>
          <Field label="5 · Difference from prior work">{d.difference}</Field>
          <Field label="6 · Verification">{d.verification}</Field>
          <div className="md:col-span-2">
            <Field label="7 · Limitations">{d.limitations}</Field>
          </div>
        </dl>
        {(d.papers || d.files) && (
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <PaperLinks slugs={d.papers} />
            <Files files={d.files} />
          </div>
        )}
      </div>
    </details>
  );
}

export function Differentiators() {
  const all = DIFFERENTIATORS.flatMap((g) => g.items);
  const count = (s: Status) => all.filter((d) => d.status === s).length;
  return (
    <Section
      id="differentiators"
      lead="The research document proposes these differentiators. Each was checked against the code: most are still plans, and they are labelled that way. Open any item for the seven-part breakdown."
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{all.length} differentiators:</span>
        <StatusPill kind="implemented" label={`${count("implemented")} implemented`} />
        <StatusPill kind="partial" label={`${count("partial")} partially implemented`} />
        <StatusPill kind="planned" label={`${count("planned")} planned`} />
      </div>
      {DIFFERENTIATORS.map((g) => (
        <div key={g.id}>
          <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-fg">
            <span className="grid size-6 place-items-center rounded-md border border-line-strong font-mono text-xs text-accent">{g.letter}</span>
            {g.title}
          </h3>
          <div className="space-y-2">
            {g.items.map((d) => (
              <DifferentiatorItem key={d.id} d={d} />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

// ---- 06 ------------------------------------------------------------------------------------------------

export function Capabilities() {
  const groups: { status: Status; title: string }[] = [
    { status: "implemented", title: "Available now" },
    { status: "partial", title: "Partially implemented" },
    { status: "planned", title: "Planned" },
  ];
  return (
    <Section id="capabilities" lead="What a person can actually do with TickForge, and why it matters. Planned items are listed separately.">
      <div className="grid gap-5 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g.status}>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
              {g.title}
              <StatusPill kind={g.status} label={String(CAPABILITIES.filter((c) => c.status === g.status).length)} />
            </h3>
            <ul className="space-y-2">
              {CAPABILITIES.filter((c) => c.status === g.status).map((c) => (
                <li key={c.title}>
                  <Card dashed={g.status === "planned"}>
                    <div className="text-sm font-semibold text-strong">{c.title}</div>
                    <p className="mt-1 text-xs leading-relaxed text-fg">{c.text}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-faint">{c.why}</p>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---- 07 ------------------------------------------------------------------------------------------------

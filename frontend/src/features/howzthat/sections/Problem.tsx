import { BEHAVIOUR_PROBLEMS, CENTRAL_PROBLEM, type Problem, RESEARCH_AREAS, RESEARCH_GAP, SYSTEM_PROBLEMS } from "../content";
import { Card, Field, PaperLinks, Section, pillFor } from "../parts";
import { Eyebrow } from "@/components/Prose";
import { paperLabel } from "@/features/research/Papers";

export function ProblemList({ title, letter, items }: { title: string; letter: string; items: Problem[] }) {
  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="grid size-6 place-items-center rounded-md border border-line-strong font-mono text-xs text-accent">{letter}</span>
        {title}
      </h3>
      <ul className="space-y-2.5">
        {items.map((p) => (
          <li key={p.title}>
            <Card>
              <div className="text-sm font-semibold text-strong">{p.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{p.text}</p>
              <div className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5 sm:flex-row sm:items-start sm:gap-3">
                <div className="shrink-0">{pillFor(p.status)}</div>
                <p className="text-xs leading-relaxed text-fg"><span className="font-semibold text-fg">TickForge today: </span>{p.today}</p>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProblemStatement() {
  return (
    <Section
      id="problem-statement"
      lead="The research document names two groups of problems. Each card says where TickForge stands today, because listing a problem is not the same as having solved it."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <ProblemList title="Systems problems" letter="A" items={SYSTEM_PROBLEMS} />
        <ProblemList title="User-behaviour problems" letter="B" items={BEHAVIOUR_PROBLEMS} />
      </div>
      <blockquote className="rounded-xl border-l-2 border-accent bg-surface/60 px-5 py-4">
        <Eyebrow className="text-accent">Problem statement in one line</Eyebrow>
        <p className="mt-2 text-base leading-relaxed text-strong">{CENTRAL_PROBLEM}</p>
      </blockquote>
    </Section>
  );
}

// ---- 03 ------------------------------------------------------------------------------------------------

export function ExistingWork() {
  return (
    <Section
      id="existing-work"
      lead="Organised by topic. For each one: the problem studied, what the research found, why it matters here, what it decided in our design, and what is still different or missing."
    >
      <div className="space-y-2.5">
        {RESEARCH_AREAS.map((a) => (
          <details key={a.topic} className="group rounded-xl border border-line bg-surface/60 open:bg-surface/80">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-faint transition group-open:rotate-90 motion-reduce:transition-none">▸</span>
              <span className="text-sm font-semibold text-strong">{a.topic}</span>
              {pillFor(a.status)}
              <span className="ml-auto text-xs text-faint">{a.papers.map((s) => paperLabel(s)).filter(Boolean).join(" · ")}</span>
            </summary>
            <div className="border-t border-line px-4 py-4">
              <dl className="grid gap-4 md:grid-cols-2">
                <Field label="Problem studied">{a.problem}</Field>
                <Field label="What the research found">{a.finding}</Field>
                <Field label="Relevance to TickForge">{a.relevance}</Field>
                <Field label="Design decision it informed">{a.decision}</Field>
                <div className="md:col-span-2">
                  <Field label="Still different, unimplemented or unverified">{a.gap}</Field>
                </div>
              </dl>
              <div className="mt-4 flex flex-col gap-2 text-xs text-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
                <PaperLinks slugs={a.papers} />
                {a.pdfOnly && a.pdfOnly.length > 0 && (
                  <span>Also cited in the research document (no page yet): {a.pdfOnly.join("; ")}.</span>
                )}
              </div>
            </div>
          </details>
        ))}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Comparison</h3>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <caption className="sr-only">Prior work compared with what TickForge implements</caption>
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-semibold">Research / prior work</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Key idea</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Relevance to TickForge</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Our implementation or planned extension</th>
              </tr>
            </thead>
            <tbody>
              {RESEARCH_AREAS.map((a) => (
                <tr key={a.topic} className="border-t border-line align-top text-fg">
                  <th scope="row" className="px-3 py-2.5 text-left font-normal">
                    <div className="font-semibold text-strong">{a.topic}</div>
                    <div className="mt-1"><PaperLinks slugs={a.papers} /></div>
                  </th>
                  <td className="px-3 py-2.5">{a.finding}</td>
                  <td className="px-3 py-2.5">{a.relevance}</td>
                  <td className="px-3 py-2.5">
                    <div className="mb-1.5">{pillFor(a.status)}</div>
                    {a.decision}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Card className="border-accent/25">
        <h3 className="text-sm font-semibold text-strong">The research gap, stated honestly</h3>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-fg">
          {RESEARCH_GAP.map((p) => (
            <p key={p.slice(0, 24)}>{p}</p>
          ))}
        </div>
      </Card>
    </Section>
  );
}

// ---- 04 ------------------------------------------------------------------------------------------------

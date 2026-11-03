import { ACKNOWLEDGMENTS, LIMITATIONS, PDF_REFERENCES, type Problem, ROADMAP } from "../content";
import { Card, Field, Section } from "../parts";
import { Eyebrow, linkClass } from "@/components/Prose";
import { builtPapers, bySlug } from "@/features/research/Papers";
import { citation } from "@/features/research/research";
import { Link, researchPath } from "@/lib/router";

export const STAGE: Record<"next" | "planned" | "later", { label: string; cls: string }> = {
  next: { label: "Next", cls: "border-accent/40 text-accent" },
  planned: { label: "Planned", cls: "border-line-strong text-fg" },
  later: { label: "Later · advanced", cls: "border-line-strong text-muted" },
};

export function Limitations() {
  return (
    <Section id="limitations" lead="Where TickForge stops today, and what would come next, in order. Nothing in this section is in progress in the code right now; the benchmark harness is the next step.">
      <Card>
        <h3 className="text-sm font-semibold text-strong">Current limitations</h3>
        <ul className="mt-2 grid gap-x-6 gap-y-1.5 text-sm text-fg md:grid-cols-2">
          {LIMITATIONS.map((l) => (
            <li key={l} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-faint" />
              {l}
            </li>
          ))}
        </ul>
      </Card>
      <ol className="space-y-2.5">
        {ROADMAP.map((r, i) => (
          <li key={r.title}>
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-faint">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-sm font-semibold text-strong">{r.title}</h3>
                <span className={`ml-auto rounded-full border px-2 py-0.5 text-xs font-semibold ${STAGE[r.stage].cls}`}>{STAGE[r.stage].label}</span>
              </div>
              <dl className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Problem it addresses">{r.problem}</Field>
                <Field label="Why it matters">{r.why}</Field>
                <Field label="Needs first">{r.needs}</Field>
                <Field label="Done when">{r.done}</Field>
              </dl>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---- 10 ------------------------------------------------------------------------------------------------

export function References() {
  const groups: { kind: (typeof PDF_REFERENCES)[number]["kind"][]; title: string }[] = [
    { kind: ["paper"], title: "Academic papers" },
    { kind: ["spec", "doc"], title: "Technical specifications and engineering documents" },
    { kind: ["book"], title: "Books" },
  ];
  return (
    <Section id="references" lead="Everything cited on this page. Citations checked against the publisher or a bibliography page are marked; the rest are copied from the research document and still need checking.">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Papers with a page in the library</h3>
        <ol className="space-y-2 text-sm leading-relaxed text-fg">
          {[...builtPapers].sort((a, b) => a.authors.localeCompare(b.authors)).map((p) => (
            <li key={p.slug} className="flex flex-col gap-1 rounded-lg border border-line bg-surface/50 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="min-w-0 flex-1">
                {citation(p)}{" "}
                {p.doi && <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer" className={`${linkClass} font-mono text-xs`}>doi:{p.doi}</a>}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {p.citationVerified ? <span className="text-xs text-up">Citation checked</span> : <span className="text-xs text-warn">Not yet checked</span>}
                <Link to={researchPath.paper(p.slug)} className={`${linkClass} text-xs`}>Page</Link>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-fg">Reading list and other works cited in the research document</h3>
        <p className="mb-3 mt-1 text-xs text-faint">As written in the research document; not yet checked against the publishers. Links are only given where the document provides one.</p>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <Eyebrow className="mb-2">Reading-list pages</Eyebrow>
            <ul className="space-y-1.5 text-sm text-fg">
              {[...bySlug.values()].filter((p) => p.status === "planned").map((p) => (
                <li key={p.slug}>
                  {citation(p)} <Link to={researchPath.paper(p.slug)} className={`${linkClass} text-xs`}>Page</Link>
                </li>
              ))}
            </ul>
          </div>
          {groups.map((g) => (
            <div key={g.title}>
              <Eyebrow className="mb-2">{g.title}</Eyebrow>
              <ul className="space-y-1.5 text-sm text-fg">
                {PDF_REFERENCES.filter((r) => g.kind.includes(r.kind)).map((r) => (
                  <li key={r.text}>
                    {r.text}{" "}
                    {r.url && <a href={r.url} target="_blank" rel="noreferrer" className={`${linkClass} text-xs`}>link</a>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <Card>
        <h3 className="text-sm font-semibold text-strong">Acknowledgments</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-fg">
          {ACKNOWLEDGMENTS.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

// ---- the overview page ---------------------------------------------------------------------------

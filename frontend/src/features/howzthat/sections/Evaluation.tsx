import { EVIDENCE, EXPERIMENTS, type Experiment, RESULTS } from "../content";
import { Card, Field, Section, scrollToId } from "../parts";
import { StatusPill, linkClass } from "@/components/Prose";

export const EXP_STATE: Record<Experiment["status"], { label: string; kind: "unverified" | "planned" }> = {
  "not-measured": { label: "Not yet measured", kind: "unverified" },
  blocked: { label: "Blocked: prerequisite not built", kind: "planned" },
  optional: { label: "Optional · evaluation planned", kind: "planned" },
};

export const fmt = (v: number | null, unit: string) => (v === null ? null : `${v.toLocaleString("en-US")} ${unit}`);

export function Evaluation() {
  return (
    <Section
      id="evaluation"
      lead="How TickForge's claims should be tested, following the evaluation plan in the research document. No performance experiment has been run yet, so every result cell says so."
    >
      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Evidence that exists today · correctness, not performance</h3>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {EVIDENCE.map((e) => (
            <li key={e.title}>
              <Card className="h-full">
                <div className="text-sm font-semibold text-strong">{e.title}</div>
                <div className="mt-1 font-mono text-xs text-up">{e.result}</div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{e.how}</p>
              </Card>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-faint">Engine checks re-run on Linux on 16 Oct 2026. The engine has not been built or tested on Windows or macOS.</p>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Results</h3>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[36rem] text-left text-xs">
            <caption className="sr-only">Benchmark results; cells are empty until measured</caption>
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-semibold">Metric</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Baseline (mutex)</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">TickForge (lock-free)</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Experiment</th>
              </tr>
            </thead>
            <tbody>
              {RESULTS.map((r) => (
                <tr key={r.metric} className="border-t border-line text-fg">
                  <th scope="row" className="px-3 py-2.5 text-left font-semibold text-strong">{r.metric}</th>
                  {[r.baseline, r.tickforge].map((v, i) => (
                    <td key={i} className="px-3 py-2.5">{fmt(v, r.unit) ?? <span className="italic text-faint">Not yet measured</span>}</td>
                  ))}
                  <td className="px-3 py-2.5">
                    <a href={`#exp-${r.experiment}`} onClick={(e) => { e.preventDefault(); scrollToId(`exp-${r.experiment}`); }} className={linkClass}>
                      {EXPERIMENTS.find((x) => x.id === r.experiment)?.title}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-fg">Experiment plan</h3>
        <div className="space-y-2">
          {EXPERIMENTS.map((x) => (
            <details key={x.id} id={`exp-${x.id}`} className="group scroll-mt-20 rounded-xl border border-line bg-surface/60 open:bg-surface/80">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="text-faint transition group-open:rotate-90 motion-reduce:transition-none">▸</span>
                <span className="min-w-0 flex-1 text-sm font-semibold text-strong">{x.title}</span>
                <StatusPill kind={EXP_STATE[x.status].kind} label={EXP_STATE[x.status].label} />
              </summary>
              <div className="border-t border-line px-4 py-4">
                <dl className="grid gap-4 md:grid-cols-2">
                  <Field label="Hypothesis">{x.hypothesis}</Field>
                  <Field label="Baseline">{x.baseline}</Field>
                  <Field label="Independent variable">{x.variable}</Field>
                  <Field label="Metric">{x.metric}</Field>
                  <Field label="Procedure">{x.procedure}</Field>
                  <Field label="How to read the result">{x.interpretation}</Field>
                  <div className="md:col-span-2">
                    <Field label="What is missing before it can run">{x.needs}</Field>
                  </div>
                </dl>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ---- 09 ------------------------------------------------------------------------------------------------

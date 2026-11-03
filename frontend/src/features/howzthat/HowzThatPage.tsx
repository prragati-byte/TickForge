// "how'z that!": the standalone research page at /howz-that (see lib/router.tsx for the routes).
// Content lives in ./content (sections) and ../research/papers/*.md (papers); these files are presentation only.
import { useEffect, useRef, type ReactNode } from "react";
import { INTRO_POINTS, STATUS_LABEL, type Status } from "./content";
import { SECTION_IDS, Section, TocList, TopBar, useActiveSection } from "./parts";
import { Eyebrow, StatusPill, linkClass } from "@/components/Prose";
import { IntegratedPaperView, PaperDetail, PaperLibrary, bySlug, paperLabel } from "@/features/research/Papers";
import { Link, parseResearchPath, researchPath } from "@/lib/router";

import { BigPicture } from "./sections/BigPicture";
import { ExistingWork, ProblemStatement } from "./sections/Problem";
import { HowItWorks } from "./sections/HowItWorks";
import { Capabilities, Differentiators } from "./sections/Differentiators";
import { Evaluation } from "./sections/Evaluation";
import { Limitations, References } from "./sections/Closing";

function Overview() {
  const active = useActiveSection(SECTION_IDS);
  const mobileToc = useRef<HTMLDetailsElement>(null);

  // Deep links such as /howz-that#evaluation: scroll once the sections exist.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, []);

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-20 pt-8 lg:px-8">
      <div className="max-w-3xl">
        <Eyebrow className="text-accent">TickForge · research and engineering notes</Eyebrow>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-strong sm:text-5xl">how&apos;z that!</h1>
        <p className="mt-2 text-lg text-fg">Research, engineering decisions, and the ideas behind TickForge.</p>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          This page documents {INTRO_POINTS.slice(0, -1).join(", ")}, and {INTRO_POINTS[INTRO_POINTS.length - 1]}. It follows the team&apos;s research document and was checked against the code; anything not built is labelled as such, and no performance number appears unless it was measured.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-faint">
          <span>Status labels:</span>
          {(["implemented", "partial", "planned", "unverified"] as Status[]).map((s) => (
            <StatusPill key={s} kind={s} label={STATUS_LABEL[s]} />
          ))}
        </div>
      </div>

      <details ref={mobileToc} className="mt-6 rounded-xl border border-line bg-surface/70 lg:hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fg">On this page</summary>
        <div className="border-t border-line p-2">
          <TocList active={active} onPick={() => mobileToc.current?.removeAttribute("open")} />
        </div>
      </details>

      <div className="mt-8 grid gap-10 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-20">
            <Eyebrow className="mb-2 px-2.5">On this page</Eyebrow>
            <TocList active={active} />
          </div>
        </nav>
        <div className="min-w-0 space-y-12">
          <BigPicture />
          <ProblemStatement />
          <ExistingWork />
          <HowItWorks />
          <Differentiators />
          <Capabilities />
          <Evaluation />
          <Section id="paper-library" lead="The papers behind TickForge, one page each, with what we took, what we changed, where it lives in the code and how it was checked. Search or filter, then open a paper.">
            <PaperLibrary />
          </Section>
          <Limitations />
          <References />
        </div>
      </div>
    </div>
  );
}

// ---- route switch --------------------------------------------------------------------------------

export default function HowzThatPage({ path }: { path: string }) {
  const route = parseResearchPath(path);
  const paper = route.view === "paper" ? bySlug.get(route.slug) : undefined;
  const home = { label: "how'z that!", to: researchPath.home };
  const root = { label: "TickForge", to: "/" };

  let title = "how'z that! · TickForge";
  let trail: { label: string; to?: string }[] = [root, { label: "how'z that!" }];
  let body: ReactNode;

  if (route.view === "home") {
    body = <Overview />;
  } else if (route.view === "integrated") {
    title = "Integrated paper · how'z that! · TickForge";
    trail = [root, home, { label: "Integrated paper" }];
    body = <IntegratedPaperView />;
  } else if (paper) {
    title = `${paper.title} · how'z that! · TickForge`;
    trail = [root, home, { label: "Papers", to: researchPath.section("paper-library") }, { label: paperLabel(paper.slug) ?? paper.title }];
    body = <PaperDetail paper={paper} />;
  } else {
    title = "Not found · how'z that! · TickForge";
    trail = [root, home, { label: "Not found" }];
    body = (
      <div className="rounded-2xl border border-line bg-surface/70 px-5 py-10 text-center">
        <h1 className="text-xl font-semibold text-strong">That research page does not exist</h1>
        <p className="mt-2 text-sm text-muted">{route.view === "paper" ? `There is no paper called “${route.slug}”.` : "The address does not match a page."}</p>
        <Link to={researchPath.section("paper-library")} className={`${linkClass} mt-4 inline-block text-sm`}>Go to the paper library</Link>
      </div>
    );
  }

  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <div className="min-h-screen">
      <TopBar trail={trail} />
      <main id="main">
        {route.view === "home" ? body : <div className="mx-auto max-w-[1100px] px-4 pb-20 pt-8 lg:px-8">{body}</div>}
      </main>
    </div>
  );
}

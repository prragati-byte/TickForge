import { useEffect, useState, type ReactNode } from "react";
import { SECTIONS, STATUS_LABEL, type Status } from "./content";
import { StatusPill, linkClass } from "@/components/Prose";
import { bySlug, paperLabel } from "@/features/research/Papers";
import { Link, researchPath } from "@/lib/router";

export const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

// ---- page shell ------------------------------------------------------------------------------------

export function TopBar({ trail }: { trail: { label: string; to?: string }[] }) {
  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-canvas/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 lg:px-8">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-fg transition hover:border-line-strong hover:text-strong"
        >
          <span aria-hidden="true">←</span> Back to TickForge
        </Link>
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {trail.map((item, i) => (
              <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-2">
                {i > 0 && <span aria-hidden="true" className="text-faint">/</span>}
                {item.to ? (
                  <Link to={item.to} className="font-semibold text-muted hover:text-strong">{item.label}</Link>
                ) : (
                  <span aria-current="page" className="truncate text-fg">{item.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex items-center gap-1 text-xs">
          <Link to={researchPath.section("paper-library")} className="rounded-md px-2.5 py-1.5 font-semibold text-muted hover:text-strong">Paper library</Link>
          <Link to={researchPath.integrated} className="rounded-md px-2.5 py-1.5 font-semibold text-muted hover:text-strong">Integrated paper</Link>
        </div>
      </div>
    </header>
  );
}

/** Which section heading is in the reading zone, for the table-of-contents highlight. */
export function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

export const SECTION_IDS = SECTIONS.map((s) => s.id);

export function TocList({ active, onPick }: { active: string; onPick?: () => void }) {
  return (
    <ol className="space-y-0.5">
      {SECTIONS.map((s) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            aria-current={active === s.id ? "location" : undefined}
            onClick={(event) => {
              event.preventDefault();
              window.history.pushState(null, "", `#${s.id}`);
              onPick?.(); // close the mobile menu first, so the layout doesn't shift under the scroll
              window.requestAnimationFrame(() => scrollToId(s.id));
            }}
            className={`flex items-baseline gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition ${
 active === s.id ? "bg-raised font-semibold text-strong" : "text-muted hover:bg-surface hover:text-fg"
 }`}
          >
            <span className={`font-mono text-xs ${active === s.id ? "text-accent" : "text-faint"}`}>{s.number}</span>
            {s.short}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function Section({ id, lead, children }: { id: string; lead?: ReactNode; children: ReactNode }) {
  const meta = SECTIONS.find((s) => s.id === id)!;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 border-t border-line/80 pt-10 first:border-t-0 first:pt-0">
      <div className="font-mono text-xs text-accent">Section {meta.number}</div>
      <h2 id={`${id}-title`} className="mt-1 text-2xl font-semibold tracking-tight text-strong sm:text-[1.7rem]">{meta.title}</h2>
      {lead && <div className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{lead}</div>}
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

export function Card({ children, className = "", dashed = false }: { children: ReactNode; className?: string; dashed?: boolean }) {
  return <div className={`rounded-xl border ${dashed ? "border-dashed border-line-strong bg-transparent" : "border-line bg-surface/60"} p-4 ${className}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-fg">{children}</dd>
    </div>
  );
}

export function Files({ files }: { files?: string[] }) {
  if (!files || files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li key={f}>
          <code className="block rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg [overflow-wrap:anywhere]">{f}</code>
        </li>
      ))}
    </ul>
  );
}

export function PaperLinks({ slugs }: { slugs?: string[] }) {
  const known = (slugs ?? []).filter((s) => bySlug.has(s));
  if (known.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {known.map((s) => (
        <Link key={s} to={researchPath.paper(s)} className={`${linkClass} text-xs`}>{paperLabel(s)}</Link>
      ))}
    </span>
  );
}

export const pillFor = (s: Status) => <StatusPill kind={s} label={STATUS_LABEL[s]} />;

// ---- 01 ------------------------------------------------------------------------------------------------

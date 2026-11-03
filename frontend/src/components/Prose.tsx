// Small presentational pieces shared by the research page and the paper library.
import { Fragment, type ReactNode } from "react";
import { parseBlocks, parseInline } from "@/features/research/research";
import { Link, researchPath } from "@/lib/router";

export type PillKind = "implemented" | "partial" | "planned" | "unverified" | "rejected" | "reading";

const PILL: Record<PillKind, { label: string; cls: string; dot: string }> = {
  implemented: { label: "Implemented", cls: "border-up/25 text-up", dot: "bg-up" },
  partial: { label: "Partially implemented", cls: "border-warn/25 text-warn", dot: "bg-warn" },
  planned: { label: "Planned", cls: "border-accent/25 text-accent", dot: "bg-accent" },
  unverified: { label: "Not verified", cls: "border-line-strong text-fg", dot: "bg-muted" },
  rejected: { label: "Rejected", cls: "border-down/25 text-down", dot: "bg-down" },
  reading: { label: "Reading list", cls: "border-accent/25 text-accent", dot: "bg-accent" },
};

/** One status system for the whole page: a dot + a word, never colour alone. */
export function StatusPill({ kind, label }: { kind: PillKind; label?: string }) {
  const p = PILL[kind];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border bg-canvas/40 px-2 py-0.5 text-xs font-semibold ${p.cls}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${p.dot}`} />
      {label ?? p.label}
    </span>
  );
}

export const linkClass = "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent";

/** Inline markdown: `code`, **bold**, *italic*, [text](https://…) and [[paper-slug]] links. */
export function Rich({ text, paperLabel }: { text: string; paperLabel?: (slug: string) => string | null }) {
  return (
    <>
      {parseInline(text).map((part, i) => {
        if (part.type === "code") return <code key={i} className="rounded bg-canvas px-1 py-0.5 font-mono text-[0.85em] text-accent [overflow-wrap:anywhere]">{part.text}</code>;
        if (part.type === "bold") return <strong key={i} className="font-semibold text-strong">{part.text}</strong>;
        if (part.type === "italic") return <em key={i}>{part.text}</em>;
        if (part.type === "link") return <a key={i} href={part.href} target="_blank" rel="noreferrer" className={linkClass}>{part.text}</a>;
        if (part.type === "paper") {
          const label = paperLabel?.(part.slug);
          return label ? <Link key={i} to={researchPath.paper(part.slug)} className={linkClass}>{label}</Link> : <span key={i}>{part.slug}</span>;
        }
        return <Fragment key={i}>{part.text}</Fragment>;
      })}
    </>
  );
}

export function Markdown({ text, paperLabel, className = "" }: { text: string; paperLabel?: (slug: string) => string | null; className?: string }) {
  return (
    <div className={`space-y-2.5 text-sm leading-relaxed text-fg ${className}`}>
      {parseBlocks(text).map((block, i) =>
        block.type === "p" ? (
          <p key={i}><Rich text={block.text} paperLabel={paperLabel} /></p>
        ) : (
          <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-faint">
            {block.items.map((item, j) => (
              <li key={j}><Rich text={item} paperLabel={paperLabel} /></li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** Small  label used above blocks of content. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-xs font-semibold tracking-[0.14em] text-faint ${className}`}>{children}</div>;
}

// Small building blocks used by every feature: Panel, Badge, Segmented, Notice, Stat.
import type { ReactNode } from "react";

const BADGE = {
  live: "border-up/50 text-up",
  simulated: "border-dashed border-warn/70 text-warn",
  sample: "border-line-strong text-muted",
  planned: "border-accent/50 text-accent",
} as const;

const BADGE_TEXT = { live: "LIVE", simulated: "SIMULATED", sample: "SAMPLE DATA", planned: "PLANNED" } as const;

/** A short status tag. SIMULATED has a dashed border so it is never mistaken for LIVE. */
export function Badge({ kind, label }: { kind: keyof typeof BADGE; label?: string }) {
  return <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-xs font-medium ${BADGE[kind]}`}>{label ?? BADGE_TEXT[kind]}</span>;
}

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
  id,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`min-w-0 overflow-hidden rounded-lg border border-line bg-surface ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A row of mutually exclusive choices, like a radio group drawn as buttons. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-canvas p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${
            value === option.value ? "bg-raised text-strong" : "text-muted hover:text-strong"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Empty, loading and error states: say what is missing and what to do about it. */
export function Notice({
  tone = "empty",
  title,
  children,
}: {
  tone?: "empty" | "loading" | "error";
  title: string;
  children?: ReactNode;
}) {
  const bar = tone === "error" ? "bg-down" : tone === "loading" ? "bg-warn animate-pulse" : "bg-line-strong";
  return (
    <div role={tone === "error" ? "alert" : "status"} className="flex gap-3 px-4 py-8">
      <span className={`mt-1 h-10 w-0.5 shrink-0 rounded-full ${bar}`} aria-hidden="true" />
      <div className="max-w-xl">
        <p className="text-sm font-medium text-strong">{title}</p>
        {children && <div className="mt-1 text-sm text-muted">{children}</div>}
      </div>
    </div>
  );
}

/** One labelled number. */
export function Stat({ label, value, tone = "", live = true }: { label: string; value: string; tone?: string; live?: boolean }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-lg font-medium ${live ? tone || "text-strong" : "text-faint"}`}>{value}</div>
    </div>
  );
}

export const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-surface";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border-line disabled:bg-raised disabled:text-faint";

export const inputClass =
  "w-full rounded-md border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-sm text-strong placeholder:text-faint focus:border-accent focus:outline-none";

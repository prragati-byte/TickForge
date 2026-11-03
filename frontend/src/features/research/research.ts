// Pure helpers for the "How'z that!" research section: no React, no DOM, easy to test.
// Paper pages are markdown files in ./papers (see README.md in this folder for the format).

export type PaperStatus = "implemented" | "partial" | "planned" | "rejected";
export type Section = { heading: string; body: string };
export type Paper = {
  slug: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  doi: string;
  url: string;
  area: "systems" | "behavioral";
  status: PaperStatus;
  reviewed: boolean;
  citationVerified: boolean;
  summary: string;
  seeAlso: string[];
  order: number;
  sections: Section[];
};
export type IntegratedPaper = { title: string; sections: Section[] };

export type Block = { type: "p"; text: string } | { type: "ul"; items: string[] };
export type Inline =
  | { type: "text" | "code" | "bold" | "italic"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "paper"; slug: string };

/**
 * How a paper page is laid out. Each row pulls one or more "## " sections from the markdown file,
 * so the files keep their simple headings while the page uses the evaluator-facing structure.
 * "relevance" and "status" rows come from the front matter instead.
 */
export type DetailRow = { label: string; from: string[]; special?: "relevance" | "status" };
export const DETAIL_LAYOUT: DetailRow[] = [
  { label: "Research question", from: ["Research question"] },
  { label: "Problem addressed", from: ["Problem they solved"] },
  { label: "Method / key idea", from: ["What they did"] },
  { label: "Findings, as reported by the authors", from: ["Findings"] },
  { label: "Relevance to TickForge", from: [], special: "relevance" },
  { label: "What TickForge adopted", from: ["What we took"] },
  { label: "Implementation status", from: [], special: "status" },
  { label: "Code references", from: ["Where in our code"] },
  { label: "Testing and evidence", from: ["How we verified it", "Result"] },
  { label: "Limitations and differences from the original work", from: ["What we changed or rejected", "Limits and trade-offs"] },
];
export const STUB_SECTION = "Why it matters for TickForge";
/** Headings consumed by DETAIL_LAYOUT or the stub layout; anything else is shown at the end as written. */
export const KNOWN_HEADINGS = new Set([...DETAIL_LAYOUT.flatMap((r) => r.from), STUB_SECTION].map((h) => h.toLowerCase()));

export function sectionBody(paper: Paper, heading: string): string | undefined {
  return paper.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())?.body;
}

/** Text used by the library search box. */
export function searchText(p: Paper): string {
  return [p.title, p.authors, p.venue, p.summary, String(p.year), p.area, p.status, ...p.sections.map((s) => s.body)].join(" ").toLowerCase();
}
const STATUSES: PaperStatus[] = ["implemented", "partial", "planned", "rejected"];

const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = unquote(line.slice(at + 1).trim());
  }
  return { meta, body: text.slice(match[0].length) };
}

export function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], body: "" };
      sections.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return sections.map((s) => ({ heading: s.heading, body: s.body.trim() }));
}

/** Paragraphs and "- " bullet lists. Indented lines continue the previous bullet. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (/^\s*-\s+/.test(line)) {
      flushPara();
      list = list ?? [];
      list.push(line.replace(/^\s*-\s+/, ""));
    } else if (list && /^\s+\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([a-z0-9-]+)\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*]*)\*/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ type: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ type: "paper", slug: m[3] });
    else if (m[4] !== undefined) out.push({ type: "link", text: m[4], href: m[5] });
    else out.push({ type: "italic", text: m[6] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function parsePaper(slug: string, raw: string): Paper {
  const { meta, body } = parseFrontmatter(raw);
  const status = STATUSES.includes(meta.status as PaperStatus) ? (meta.status as PaperStatus) : "planned";
  return {
    slug,
    title: meta.title || slug,
    authors: meta.authors || "",
    year: Number(meta.year) || 0,
    venue: meta.venue || "",
    doi: meta.doi || "",
    url: meta.url || "",
    area: meta.area === "behavioral" ? "behavioral" : "systems",
    status,
    reviewed: meta.reviewed === "true",
    citationVerified: meta.citationVerified === "true",
    summary: meta.summary || "",
    seeAlso: (meta.seeAlso || "").split(",").map((s) => s.trim()).filter(Boolean),
    order: Number(meta.order) || 999,
    sections: splitSections(body),
  };
}

/** files: path -> raw markdown, e.g. from import.meta.glob. README.md is skipped; "_integrated.md" is the integrated paper. */
export function loadResearch(files: Record<string, string>): { papers: Paper[]; integrated: IntegratedPaper | null } {
  const papers: Paper[] = [];
  let integrated: IntegratedPaper | null = null;
  for (const [path, raw] of Object.entries(files)) {
    const name = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    if (!name || name.toLowerCase() === "readme") continue;
    if (name === "_integrated") {
      const { meta, body } = parseFrontmatter(raw);
      integrated = { title: meta.title || "Integrated paper", sections: splitSections(body) };
    } else if (!name.startsWith("_")) {
      papers.push(parsePaper(name, raw));
    }
  }
  papers.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return { papers, integrated };
}

/** "Michael, M. M. and Scott, M. L. (1996). Title. Venue." */
export function citation(p: Paper): string {
  const venue = p.venue ? ` ${p.venue}.` : "";
  return `${p.authors} (${p.year}). ${p.title.replace(/\.$/, "")}.${venue}`;
}

/** "Michael", "Benartzi and Thaler", "Gould et al." from an authors line like "Last, F., Last, F. and Last, F.". */
export function shortAuthors(authors: string): string {
  const names = authors
    .split(/,\s+(?=[A-Z][\p{L}'’-]+,)|\s+and\s+/u)
    .map((a) => a.split(",")[0].trim())
    .filter(Boolean);
  if (names.length === 0) return "";
  if (/et al/.test(authors) || names.length > 2) return `${names[0]} et al.`;
  return names.join(" and ");
}

export const usedInBuild = (p: Paper) => p.status !== "planned";

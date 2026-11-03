// Minimal path router on top of the History API (the app has no router dependency, and two pages do not need one).
// Vite's dev and preview servers already fall back to index.html for unknown paths, so /howz-that works on refresh.
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

const NAV_EVENT = "tickforge:navigate";

export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Current pathname; updates on Link clicks, navigate(), and browser Back/Forward. */
export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener(NAV_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAV_EVENT, update);
    };
  }, []);
  return path;
}

/** A real <a href> (so open-in-new-tab, copy link and keyboard all work) that navigates without a page reload. */
export function Link({ to, onClick, ...rest }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}

// ---- research page routes --------------------------------------------------------------------------
export const RESEARCH_BASE = "/howz-that";
export const researchPath = {
  home: RESEARCH_BASE,
  section: (id: string) => `${RESEARCH_BASE}#${id}`,
  paper: (slug: string) => `${RESEARCH_BASE}/papers/${encodeURIComponent(slug)}`,
  integrated: `${RESEARCH_BASE}/integrated-paper`,
};

export type ResearchRoute = { view: "home" } | { view: "paper"; slug: string } | { view: "integrated" } | { view: "missing"; path: string };

export function isResearchPath(path: string): boolean {
  return path === RESEARCH_BASE || path.startsWith(`${RESEARCH_BASE}/`);
}

export function parseResearchPath(path: string): ResearchRoute {
  const rest = path.slice(RESEARCH_BASE.length).replace(/^\/+|\/+$/g, "");
  if (!rest) return { view: "home" };
  if (rest === "integrated-paper") return { view: "integrated" };
  const paper = /^papers\/([^/]+)$/.exec(rest);
  if (paper) {
    try {
      return { view: "paper", slug: decodeURIComponent(paper[1]) };
    } catch {
      return { view: "missing", path };
    }
  }
  return { view: "missing", path };
}

/** Links from the first version used hashes (#/howzthat/<slug>). Turn them into the new paths so old links keep working. */
export function legacyHashTarget(hash: string): string | null {
  if (hash !== "#/howzthat" && !hash.startsWith("#/howzthat/")) return null;
  const rest = hash.slice("#/howzthat".length).replace(/^\/+|\/+$/g, "");
  if (!rest) return researchPath.home;
  if (rest === "paper") return researchPath.integrated;
  return `${RESEARCH_BASE}/papers/${rest}`;
}

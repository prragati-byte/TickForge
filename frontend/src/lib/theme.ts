import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const systemTheme = (): Theme =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

function saved(): Theme | null {
  try {
    const value = window.localStorage.getItem("tickforge-theme");
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null; // storage can be blocked; the system setting is used instead
  }
}

/** Apply a saved choice before the first paint, so every page (not only the dashboard) uses it. */
export function applyStoredTheme() {
  const value = saved();
  if (value) document.documentElement.dataset.theme = value;
}

/** Light or dark. Follows the system setting until the person picks one with the toggle. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => saved() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem("tickforge-theme", next);
    } catch {
      /* not saved, still applied */
    }
  };
  return { theme, toggle };
}

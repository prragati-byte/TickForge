import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import Dashboard from "@/features/dashboard/Dashboard";
import HowzThatPage from "@/features/howzthat/HowzThatPage";
import { isResearchPath, legacyHashTarget, usePathname } from "@/lib/router";
import { applyStoredTheme } from "@/lib/theme";
import "./index.css";

applyStoredTheme();

// Old research links (#/howzthat/...) now live at /howz-that/...
const legacy = legacyHashTarget(window.location.hash);
if (legacy) window.history.replaceState(null, "", legacy);

// Two pages: the dashboard (default) and the standalone "how'z that!" research page.
function Root() {
  const path = usePathname();
  // A new page starts at the top, unless the address points at a section (#id): the page scrolls there itself.
  useEffect(() => {
    if (!window.location.hash) window.scrollTo({ top: 0, behavior: "instant" });
  }, [path]);
  return isResearchPath(path) ? <HowzThatPage path={path} /> : <Dashboard />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

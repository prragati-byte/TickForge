// Smoke test: every page renders its first frame without throwing, and shows honest offline states.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // The pages read these browser objects while rendering; a server render has none, so give it plain stand-ins.
  const win = {
    location: { pathname: "/", search: "", hash: "" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(globalThis, { window: win });
});

describe("pages render", () => {
  it("dashboard shows empty states while no service answers", async () => {
    const { default: Dashboard } = await import("@/features/dashboard/Dashboard");
    const html = renderToString(<Dashboard />);
    expect(html).toContain("Engine not connected");
    expect(html).toContain("No order book yet");
    expect(html).toContain("No trader data");
    expect(html).not.toContain("SAMPLE");
  });

  it("research page renders every route", async () => {
    const { default: HowzThatPage } = await import("@/features/howzthat/HowzThatPage");
    for (const path of ["/howz-that", "/howz-that/integrated-paper", "/howz-that/papers/michael-scott-1996", "/howz-that/papers/nope"]) {
      expect(renderToString(<HowzThatPage path={path} />).length).toBeGreaterThan(500);
    }
  });
});

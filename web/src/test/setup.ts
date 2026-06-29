/*
 * Vitest setup — runs once before each test file (see vitest.config.ts setupFiles).
 *
 * 1. Registers @testing-library/jest-dom's matchers (toBeInTheDocument, toBeDisabled,
 *    toHaveTextContent, …) on Vitest's expect.
 * 2. Unmounts any tree rendered by @testing-library/react after each test. RTL's
 *    auto-cleanup only self-registers when `globals` is on; this suite runs with
 *    explicit imports (globals:false), so we register the afterEach ourselves —
 *    otherwise a left-over DOM from one test would leak into the next.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/*
 * jsdom does not implement window.matchMedia, but the GSAP motion layer
 * (src/lib/motion.tsx → useGsap → gsap.matchMedia) calls it inside a layout
 * effect, so any component carrying motion would throw on render. Stub it as
 * "no match" (reduced-motion path / no animation) — animations are not under
 * test here, only the components that host them.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

afterEach(() => {
  cleanup();
});

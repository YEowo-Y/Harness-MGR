/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/*
 * Vitest config for the CLIENT / component suite (jsdom).
 *
 * Deliberately separate from the server tests: those stay on the zero-dep
 * `node --test server/*.test.mjs` runner. Here `include` is scoped to src/**, so
 * Vitest never picks up server/*.test.mjs and the two runners never overlap.
 *
 * Mirrors vite.config.ts's React transform + the `@` path alias so tests import
 * exactly as the app does; the Tailwind plugin is omitted (CSS is irrelevant to
 * logic + DOM assertions, and jsdom ignores styles anyway).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
  },
});

/*
 * Shared test helpers for the client/component suite.
 *
 * renderWithLang wraps the UI in <LangProvider> — every component that calls
 * useLang()/t() needs that context or it throws. The provider reads its initial
 * language from localStorage ONCE (default zh), so we seed it BEFORE rendering to
 * pin the language. Tests default to "en" and assert against the English table
 * (i18n's EN is the source-of-truth dictionary), which keeps assertions readable
 * and decoupled from the Chinese wording.
 */
import type { ReactElement } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { LangProvider, type Lang } from "@/lib/i18n";

// Mirrors STORAGE_KEY in src/lib/i18n.tsx (a stable persistence contract).
const LANG_STORAGE_KEY = "claude-mgr-lang";

export function renderWithLang(
  ui: ReactElement,
  { lang = "en", ...options }: { lang?: Lang } & Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* jsdom provides localStorage; guard for the unexpected */
  }
  return render(ui, {
    wrapper: ({ children }) => <LangProvider>{children}</LangProvider>,
    ...options,
  });
}

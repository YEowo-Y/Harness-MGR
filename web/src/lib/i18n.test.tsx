import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { renderWithLang } from "@/test/utils";
import { EN, ZH, format, useLang } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 1) format(template, vars)
// ---------------------------------------------------------------------------

describe("format", () => {
  it("returns template unchanged when vars is undefined", () => {
    expect(format("Hello {name}")).toBe("Hello {name}");
  });

  it("replaces a single {token}", () => {
    expect(format("Hello {name}", { name: "Alice" })).toBe("Hello Alice");
  });

  it("replaces multiple {token}s", () => {
    expect(format("{a} and {b}", { a: "foo", b: "bar" })).toBe("foo and bar");
  });

  it("coerces a numeric var to string", () => {
    expect(format("Count: {n}", { n: 42 })).toBe("Count: 42");
  });

  it("leaves an unknown {token} literally as '{token}'", () => {
    expect(format("Hello {missing}", { name: "Alice" })).toBe("Hello {missing}");
  });
});

// ---------------------------------------------------------------------------
// 2) KEY parity: Object.keys(EN) === Object.keys(ZH)
// ---------------------------------------------------------------------------

describe("dictionary key parity", () => {
  it("EN and ZH have identical key sets", () => {
    const enKeys = new Set(Object.keys(EN));
    const zhKeys = new Set(Object.keys(ZH));

    const missingInZH = [...enKeys].filter((k) => !zhKeys.has(k));
    const extraInZH = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(missingInZH).toEqual([]);
    expect(extraInZH).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3) TOKEN parity: for every key, {token} placeholders match between EN and ZH
// ---------------------------------------------------------------------------

function extractTokens(str: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of str.matchAll(/\{(\w+)\}/g)) {
    tokens.add(m[1]);
  }
  return tokens;
}

describe("placeholder token parity", () => {
  for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
    it(`key "${key}" has the same {token}s in EN and ZH`, () => {
      const enTokens = extractTokens(EN[key]);
      const zhTokens = extractTokens(ZH[key]);

      const missingInZH = [...enTokens].filter((t) => !zhTokens.has(t));
      const extraInZH = [...zhTokens].filter((t) => !enTokens.has(t));

      expect(missingInZH).toEqual([]);
      expect(extraInZH).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 4) t() via provider
// ---------------------------------------------------------------------------

function Probe() {
  const { t } = useLang();
  return <span>{t("nav.dashboard")}</span>;
}

function ProbeInterp() {
  const { t } = useLang();
  return <span>{t("dash.itemCount", { shown: 3, total: 9 })}</span>;
}

describe("t() via LangProvider", () => {
  it("renders English string for lang=en", () => {
    renderWithLang(<Probe />, { lang: "en" });
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders Chinese string for lang=zh", () => {
    renderWithLang(<Probe />, { lang: "zh" });
    // ZH["nav.dashboard"] = "总览"
    expect(screen.getByText("总览")).toBeInTheDocument();
  });

  it("interpolates {shown} and {total} via t() in English", () => {
    renderWithLang(<ProbeInterp />, { lang: "en" });
    // EN["dash.itemCount"] = "{shown} / {total}" -> "3 / 9"
    expect(screen.getByText("3 / 9")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5) useLang outside a provider throws
// ---------------------------------------------------------------------------

describe("useLang outside a provider", () => {
  it("throws when called outside <LangProvider>", () => {
    // RTL's renderHook renders into a plain div with no wrapper — no LangProvider.
    expect(() => renderHook(() => useLang())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6) persistence: localStorage and document.documentElement.lang
// ---------------------------------------------------------------------------

describe("persistence side-effects", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "";
  });

  it("writes 'en' to localStorage after rendering with lang=en", () => {
    renderWithLang(<Probe />, { lang: "en" });
    expect(localStorage.getItem("claude-mgr-lang")).toBe("en");
  });

  it("sets document.documentElement.lang to 'en' for lang=en", () => {
    renderWithLang(<Probe />, { lang: "en" });
    expect(document.documentElement.lang).toBe("en");
  });

  it("writes 'zh' to localStorage and sets 'zh-CN' on <html> for lang=zh", () => {
    renderWithLang(<Probe />, { lang: "zh" });
    expect(localStorage.getItem("claude-mgr-lang")).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

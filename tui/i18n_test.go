package main

import (
	"strings"
	"testing"
)

// Each test that reads through t()/tf() sets uiLang explicitly and restores it via
// defer, so the package-level language never leaks into other tests (the suite
// runs sequentially; none of these use t.Parallel).

// TestTranslateEnglishDefault asserts English lookups return the source text —
// byte-identical to the former hardcoded literals, so the default UI is unchanged.
func TestTranslateEnglishDefault(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	cases := map[string]string{
		"tab.inventory":   "Inventory",
		"tab.selftest":    "Selftest",
		"status.expand":   "expand",
		"status.quit":     "quit",
		"count.skills":    "skills",
		"count.mcp":       "mcp",
		"empty.conflicts": "no conflicts found",
		"splash.tagline":  "agent harness configuration governance · read-only",
	}
	for key, want := range cases {
		if got := tr(key); got != want {
			t.Errorf("t(%q) [EN] = %q, want %q", key, got, want)
		}
	}
	if got := tf("summary.conflicts", 3); got != "3 conflicts" {
		t.Errorf("tf(summary.conflicts, 3) [EN] = %q, want %q", got, "3 conflicts")
	}
}

// TestTranslateChinese asserts the Simplified-Chinese lookups.
func TestTranslateChinese(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	cases := map[string]string{
		"tab.inventory": "清单",
		"tab.conflicts": "冲突",
		"status.quit":   "退出",
		"count.skills":  "技能",
	}
	for key, want := range cases {
		if got := tr(key); got != want {
			t.Errorf("t(%q) [ZH] = %q, want %q", key, got, want)
		}
	}
	if got := tf("summary.conflicts", 3); got != "3 个冲突" {
		t.Errorf("tf(summary.conflicts, 3) [ZH] = %q, want %q", got, "3 个冲突")
	}
}

// TestTranslateMissingKeyFallback asserts an unknown key returns itself, so a typo
// degrades visibly rather than panicking or rendering empty.
func TestTranslateMissingKeyFallback(t *testing.T) {
	if got := tr("does.not.exist"); got != "does.not.exist" {
		t.Errorf("t(unknown) = %q, want the key itself", got)
	}
}

// TestTranslationsComplete asserts every entry has non-empty English AND Chinese
// text — guarding against a half-translated (or typo'd) key.
func TestTranslationsComplete(t *testing.T) {
	for key, pair := range translations {
		if strings.TrimSpace(pair[langEN]) == "" {
			t.Errorf("translation %q has empty English text", key)
		}
		if strings.TrimSpace(pair[langZH]) == "" {
			t.Errorf("translation %q has empty Chinese text", key)
		}
	}
}

// TestOtherLang asserts the splash picker toggle flips between the two languages.
func TestOtherLang(t *testing.T) {
	if otherLang(langEN) != langZH {
		t.Error("otherLang(langEN) should be langZH")
	}
	if otherLang(langZH) != langEN {
		t.Error("otherLang(langZH) should be langEN")
	}
}

// TestTabLabelTranslates asserts tabLabel tracks the active language and guards
// the out-of-range index.
func TestTabLabelTranslates(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	if got := tabLabel(viewInventory); got != "Inventory" {
		t.Errorf("tabLabel(viewInventory) [EN] = %q, want Inventory", got)
	}
	uiLang = langZH
	if got := tabLabel(viewInventory); got != "清单" {
		t.Errorf("tabLabel(viewInventory) [ZH] = %q, want 清单", got)
	}
	if got := tabLabel(viewID(99)); got != "" {
		t.Errorf("tabLabel(out-of-range) = %q, want empty", got)
	}
}

// TestTabKeysMatchLabels guards the two parallel tab slices: tabKeys (translation
// keys) must align 1:1 with tabLabels (the former English source), and each key's
// English text must equal its label — so adding/reordering a tab in one slice but
// not the other is caught instead of silently producing a wrong label.
func TestTabKeysMatchLabels(t *testing.T) {
	if len(tabKeys) != len(tabLabels) {
		t.Fatalf("len(tabKeys)=%d != len(tabLabels)=%d", len(tabKeys), len(tabLabels))
	}
	for i, key := range tabKeys {
		pair, ok := translations[key]
		if !ok {
			t.Errorf("tabKeys[%d]=%q has no translation entry", i, key)
			continue
		}
		if pair[langEN] != tabLabels[i] {
			t.Errorf("tabKeys[%d] English = %q, want tabLabels[%d] = %q", i, pair[langEN], i, tabLabels[i])
		}
	}
}

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLangPersistRoundTrip verifies a saved language is read back, with English
// the default for a missing file.
func TestLangPersistRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui.json")

	if got := loadConfigFrom(path).lang(); got != langEN {
		t.Fatalf("missing file: loadConfigFrom.lang() = %d, want langEN", got)
	}
	saveConfigTo(path, uiConfig{Language: "zh"})
	if got := loadConfigFrom(path).lang(); got != langZH {
		t.Fatalf("after save ZH: loadConfigFrom.lang() = %d, want langZH", got)
	}
	saveConfigTo(path, uiConfig{Language: "en"})
	if got := loadConfigFrom(path).lang(); got != langEN {
		t.Fatalf("after save EN: loadConfigFrom.lang() = %d, want langEN", got)
	}
}

// TestLoadLangCorruptOrUnknown verifies malformed JSON and unrecognized values
// fall back to English rather than erroring.
func TestLoadLangCorruptOrUnknown(t *testing.T) {
	dir := t.TempDir()

	corrupt := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corrupt, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := loadConfigFrom(corrupt).lang(); got != langEN {
		t.Fatalf("corrupt file: loadConfigFrom.lang() = %d, want langEN", got)
	}

	unknown := filepath.Join(dir, "unknown.json")
	if err := os.WriteFile(unknown, []byte(`{"language":"fr"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := loadConfigFrom(unknown).lang(); got != langEN {
		t.Fatalf("unknown lang: loadConfigFrom.lang() = %d, want langEN", got)
	}
}

// TestLoadLangEmptyPath verifies an unresolved config path defaults to English
// (and saveConfigTo("") is a safe no-op).
func TestLoadLangEmptyPath(t *testing.T) {
	saveConfigTo("", uiConfig{Language: "zh"}) // must not panic
	if got := loadConfigFrom("").lang(); got != langEN {
		t.Fatalf("empty path: loadConfigFrom.lang() = %d, want langEN", got)
	}
}

// TestConfigBothFieldsRoundTrip verifies all three fields (language, writes, target)
// persist together without clobbering each other.
func TestConfigBothFieldsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ui.json")
	saveConfigTo(path, uiConfig{Language: "zh", WritesEnabled: true, Target: "codex"})
	got := loadConfigFrom(path)
	if got.lang() != langZH {
		t.Errorf("lang = %v, want langZH", got.lang())
	}
	if !got.WritesEnabled {
		t.Error("WritesEnabled = false, want true (writes flag lost on round-trip)")
	}
	if got.target() != "codex" {
		t.Errorf("target = %q, want codex (target lost on round-trip)", got.target())
	}
	// Saving the whole doc again with writes off + claude target must not lose the language.
	saveConfigTo(path, uiConfig{Language: "zh", WritesEnabled: false, Target: "claude"})
	got = loadConfigFrom(path)
	if got.lang() != langZH || got.WritesEnabled || got.target() != "claude" {
		t.Errorf("after re-save: lang=%v writes=%v target=%q, want langZH/false/claude", got.lang(), got.WritesEnabled, got.target())
	}
}

// TestTargetRoundTrip verifies the target field round-trips and defaults to claude
// for a missing file, an empty value, and any unrecognized value.
func TestTargetRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui.json")

	// Missing file defaults to claude.
	if got := loadConfigFrom(path).target(); got != "claude" {
		t.Fatalf("missing file: target() = %q, want claude", got)
	}
	saveConfigTo(path, uiConfig{Target: "codex"})
	if got := loadConfigFrom(path).target(); got != "codex" {
		t.Fatalf("after save codex: target() = %q, want codex", got)
	}
	saveConfigTo(path, uiConfig{Target: "claude"})
	if got := loadConfigFrom(path).target(); got != "claude" {
		t.Fatalf("after save claude: target() = %q, want claude", got)
	}
	// An empty value (older config) and an unknown value both read as claude.
	if got := (uiConfig{Target: ""}).target(); got != "claude" {
		t.Fatalf("empty target: target() = %q, want claude", got)
	}
	if got := (uiConfig{Target: "gemini"}).target(); got != "claude" {
		t.Fatalf("unknown target: target() = %q, want claude", got)
	}
}

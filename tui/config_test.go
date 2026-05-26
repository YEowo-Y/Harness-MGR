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

// TestConfigBothFieldsRoundTrip verifies both fields persist together without
// clobbering each other.
func TestConfigBothFieldsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ui.json")
	saveConfigTo(path, uiConfig{Language: "zh", WritesEnabled: true})
	got := loadConfigFrom(path)
	if got.lang() != langZH {
		t.Errorf("lang = %v, want langZH", got.lang())
	}
	if !got.WritesEnabled {
		t.Error("WritesEnabled = false, want true (writes flag lost on round-trip)")
	}
	// Saving the whole doc again with writes off must not lose the language.
	saveConfigTo(path, uiConfig{Language: "zh", WritesEnabled: false})
	got = loadConfigFrom(path)
	if got.lang() != langZH || got.WritesEnabled {
		t.Errorf("after re-save: lang=%v writes=%v, want langZH/false", got.lang(), got.WritesEnabled)
	}
}

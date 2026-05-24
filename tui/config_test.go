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

	if got := loadLangFrom(path); got != langEN {
		t.Fatalf("missing file: loadLangFrom = %d, want langEN", got)
	}
	saveLangTo(path, langZH)
	if got := loadLangFrom(path); got != langZH {
		t.Fatalf("after save ZH: loadLangFrom = %d, want langZH", got)
	}
	saveLangTo(path, langEN)
	if got := loadLangFrom(path); got != langEN {
		t.Fatalf("after save EN: loadLangFrom = %d, want langEN", got)
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
	if got := loadLangFrom(corrupt); got != langEN {
		t.Fatalf("corrupt file: loadLangFrom = %d, want langEN", got)
	}

	unknown := filepath.Join(dir, "unknown.json")
	if err := os.WriteFile(unknown, []byte(`{"language":"fr"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := loadLangFrom(unknown); got != langEN {
		t.Fatalf("unknown lang: loadLangFrom = %d, want langEN", got)
	}
}

// TestLoadLangEmptyPath verifies an unresolved config path defaults to English
// (and saveLangTo("") is a safe no-op).
func TestLoadLangEmptyPath(t *testing.T) {
	saveLangTo("", langZH) // must not panic
	if got := loadLangFrom(""); got != langEN {
		t.Fatalf("empty path: loadLangFrom = %d, want langEN", got)
	}
}

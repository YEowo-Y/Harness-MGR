package main

import (
	"os"
	"strings"
	"testing"
)

// TestPreviewSectionEmptyPath verifies that an empty path returns "".
func TestPreviewSectionEmptyPath(t *testing.T) {
	got := previewSection("", 40)
	if got != "" {
		t.Fatalf("previewSection(\"\", 40) = %q, want \"\"", got)
	}
}

// TestPreviewSectionKnownContent verifies that a real file's content appears in
// the output and that a divider glyph is present.
func TestPreviewSectionKnownContent(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.md"
	content := "# Hello\n\nThis is a preview test.\nSecond line here."
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got := previewSection(path, 40)
	if !strings.Contains(got, "Hello") {
		t.Fatalf("result missing content word 'Hello': %q", got)
	}
	if !strings.Contains(got, "preview test") {
		t.Fatalf("result missing content word 'preview test': %q", got)
	}
	// Divider should be present: either the Unicode em-dash or ASCII fallback.
	if !strings.Contains(got, "─") && !strings.Contains(got, "-") {
		t.Fatalf("result missing divider rune: %q", got)
	}
}

// TestPreviewSectionNonExistentPath verifies that a missing file returns an
// "unable to read file" section without panicking.
func TestPreviewSectionNonExistentPath(t *testing.T) {
	got := previewSection("/nonexistent/path/that/does/not/exist.md", 40)
	if !strings.Contains(got, "unable to read") {
		t.Fatalf("non-existent path: expected 'unable to read' in result, got %q", got)
	}
}

// TestPreviewSectionLargeFileTruncated verifies that a file exceeding
// maxPreviewBytes produces a result containing "truncated".
func TestPreviewSectionLargeFileTruncated(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/large.md"
	// Write 70 KB — larger than maxPreviewBytes (64 KB).
	data := make([]byte, 70*1024)
	for i := range data {
		data[i] = 'a'
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	got := previewSection(path, 40)
	if !strings.Contains(got, "truncated") {
		t.Fatalf("large file: expected 'truncated' in result, got %q", got[:min(len(got), 200)])
	}
}

// TestPreviewSectionCRLFNormalized verifies that CRLF line endings in the file
// produce no carriage-return characters in the output.
func TestPreviewSectionCRLFNormalized(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/crlf.md"
	content := "a\r\nb\r\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got := previewSection(path, 40)
	if strings.Contains(got, "\r") {
		t.Fatalf("CRLF not normalized: result still contains \\r: %q", got)
	}
}

// TestPreviewSectionDirectory verifies a non-regular-file path (a directory)
// yields the "unable to read file" section rather than panicking.
func TestPreviewSectionDirectory(t *testing.T) {
	got := previewSection(t.TempDir(), 40)
	if !strings.Contains(got, "unable to read") {
		t.Fatalf("directory path: expected 'unable to read', got %q", got)
	}
}

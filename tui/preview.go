package main

import (
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// maxPreviewBytes is the maximum number of bytes read from a component file.
// Content beyond this limit is noted with a truncation marker.
const maxPreviewBytes = 64 * 1024

// previewSection reads up to maxPreviewBytes of the file at path and returns a
// formatted block: a leading blank line, a dim divider, and the word-wrapped
// body. Returns "" when path is empty (non-component nodes). Never panics.
func previewSection(path string, width int) string {
	if path == "" {
		return ""
	}
	w := width
	if w < 1 {
		w = 1
	}
	body, truncated, err := readCapped(path)
	if err != nil {
		return unableToReadSection(w)
	}
	// Normalize line endings.
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "")
	// Drop any invalid UTF-8 (e.g. a partial rune left by the byte-cap cut) so
	// the renderer never emits a U+FFFD replacement char.
	body = strings.ToValidUTF8(body, "")
	if truncated {
		marker := lipgloss.NewStyle().Foreground(leaderDim).Italic(true).
			Render(glyph("…", "...") + "(truncated)")
		body = body + "\n" + marker
	}
	wrapped := lipgloss.NewStyle().Width(w).Render(body)
	return "\n\n" + previewDivider(w) + "\n" + wrapped
}

// readCapped opens path, verifies it is a regular file, and reads at most
// maxPreviewBytes (reading one extra byte so it can DETECT and trim overflow
// precisely). Returns (content, truncated, error). truncated is true when the
// stat size OR the actual read exceeds the cap — the read check also catches a
// file that GREW between Stat and read. A shrink between Stat and read at worst
// shows a harmless "(truncated)" on a fully-read file. On any error the
// returned content is empty.
func readCapped(path string) (string, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() {
		return "", false, os.ErrInvalid
	}
	truncated := info.Size() > maxPreviewBytes

	f, err := os.Open(path)
	if err != nil {
		return "", false, err
	}
	defer f.Close()

	raw, err := io.ReadAll(io.LimitReader(f, maxPreviewBytes+1))
	if err != nil {
		return "", false, err
	}
	if int64(len(raw)) > maxPreviewBytes {
		raw = raw[:maxPreviewBytes]
		truncated = true
	}
	return string(raw), truncated, nil
}

// previewDivider returns a full-width dim horizontal rule at the given width.
func previewDivider(w int) string {
	return lipgloss.NewStyle().Foreground(leaderDim).
		Render(strings.Repeat(glyph("─", "-"), w))
}

// unableToReadSection returns the error variant of the preview block: the same
// divider followed by a dim italic message.
func unableToReadSection(w int) string {
	msg := lipgloss.NewStyle().Foreground(leaderDim).Italic(true).
		Render("unable to read file")
	return "\n\n" + previewDivider(w) + "\n" + msg
}

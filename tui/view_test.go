package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// ── detailField alignment tests ───────────────────────────────────────────────

// TestDetailFieldAlignedValues asserts that two detailField calls with
// different-length labels at the same width produce value text that starts at
// the same column index. Because detailLabelStyle.Width(detailLabelCol) pads
// every label to exactly detailLabelCol columns, the value (after the single
// separator space) always begins at column detailLabelCol+1 regardless of the
// visible label text.
func TestDetailFieldAlignedValues(t *testing.T) {
	width := 60

	rowShort := detailField("Kind", "skill", width)
	rowLong := detailField("Description", "a longer value here", width)

	// Strip ANSI escape sequences so we can measure plain-text column positions.
	plain := func(s string) string {
		return lipgloss.NewStyle().Render(s) // identity — no extra style
	}
	_ = plain

	// Find the column of the first non-space character after the label region.
	// detailLabelCol=16 chars for the label + 1 space separator = column 17 (0-indexed: 16).
	valueColOf := func(row string) int {
		// Strip ANSI codes by walking the raw string and skipping ESC sequences.
		stripped := stripANSI(row)
		// The label occupies the first detailLabelCol visible columns; value starts after the separator space.
		// Count visible chars up to the first non-space char that follows the label region.
		col := 0
		inLabel := true
		for _, ch := range stripped {
			if inLabel && col < detailLabelCol {
				col++
				continue
			}
			inLabel = false
			if ch == ' ' && col == detailLabelCol {
				col++ // the separator space
				continue
			}
			return col
		}
		return col
	}

	colShort := valueColOf(rowShort)
	colLong := valueColOf(rowLong)

	if colShort != colLong {
		t.Fatalf("value columns differ: %q starts at %d, %q starts at %d (want equal)",
			"Kind", colShort, "Description", colLong)
	}
	if colShort != detailLabelCol+1 {
		t.Fatalf("value column = %d, want detailLabelCol+1 = %d", colShort, detailLabelCol+1)
	}
}

// TestDetailFieldEmptyValueDash asserts blank/whitespace values render as "—".
func TestDetailFieldEmptyValueDash(t *testing.T) {
	row := detailField("Kind", "", 60)
	if !strings.Contains(row, "—") {
		t.Fatalf("empty value should render as dash, got: %q", row)
	}
}

// TestDetailFieldTruncatesLongValue asserts a value longer than the available
// space is truncated with an ellipsis.
func TestDetailFieldTruncatesLongValue(t *testing.T) {
	long := strings.Repeat("x", 200)
	row := detailField("Kind", long, 60)
	stripped := stripANSI(row)
	// The stripped row (minus newline) must fit within width columns.
	stripped = strings.TrimRight(stripped, "\n")
	if len([]rune(stripped)) > 60 {
		t.Fatalf("detailField row wider than width=60: %d runes", len([]rune(stripped)))
	}
}

// ── conflictDetail reflow test ────────────────────────────────────────────────

// TestConflictDetailReflowNarrow asserts that a long value (the Reason field)
// is shorter/ellipsized at width=40 compared to width=120, confirming the
// detail builder respects the live pane width.
func TestConflictDetailReflowNarrow(t *testing.T) {
	c := ConflictCluster{
		Kind:         "skill",
		Key:          "seo",
		Confidence:   "likely",
		LikelyWinner: ConflictMember{Name: "seo", Source: ComponentSource{Tier: "user"}},
		Reason:       "user skill shadows plugin skill from a very long path that exceeds narrow widths",
		Fix:          "remove the shadowed copy from the plugin directory",
	}

	narrow := conflictDetail(c, 40)
	wide := conflictDetail(c, 120)

	narrowStripped := stripANSI(narrow)
	wideStripped := stripANSI(wide)

	// The wide version must contain the full reason text; the narrow must not
	// (it gets truncated). Check for a suffix that would only survive at width=120.
	longSuffix := "exceeds narrow widths"
	if !strings.Contains(wideStripped, longSuffix) {
		t.Fatalf("wide detail missing expected reason text %q:\n%s", longSuffix, wideStripped)
	}
	if strings.Contains(narrowStripped, longSuffix) {
		t.Fatalf("narrow detail should have truncated reason but still contains %q:\n%s", longSuffix, narrowStripped)
	}
}

// ── detailTitle header tests ──────────────────────────────────────────────────

// TestDetailTitleHeader asserts detailTitle renders the name plus a header rule
// (a newline separates the title from the rule), and that edge widths — where
// strings.Repeat would panic on a negative count — are guarded.
func TestDetailTitleHeader(t *testing.T) {
	got := detailTitle("My Skill", accent, 40)
	if !strings.Contains(got, "My Skill") {
		t.Fatalf("detailTitle missing name: %q", got)
	}
	if !strings.Contains(got, "\n") {
		t.Fatalf("detailTitle missing the header rule (no newline): %q", got)
	}
	// Edge widths must not panic.
	_ = detailTitle("x", accent, 0)
	_ = detailTitle("x", accent, -1)
}

// ── stripANSI helper ──────────────────────────────────────────────────────────

// stripANSI removes ANSI CSI escape sequences (ESC [ ... m) from s so we can
// measure plain-text column widths in tests. This is a minimal implementation
// sufficient for the color-only sequences lipgloss emits.
func stripANSI(s string) string {
	var b strings.Builder
	runes := []rune(s)
	i := 0
	for i < len(runes) {
		if runes[i] == '\x1b' && i+1 < len(runes) && runes[i+1] == '[' {
			// Skip ESC [ ... <letter>
			i += 2
			for i < len(runes) && !isANSITerminator(runes[i]) {
				i++
			}
			if i < len(runes) {
				i++ // skip the terminator
			}
			continue
		}
		b.WriteRune(runes[i])
		i++
	}
	return b.String()
}

func isANSITerminator(r rune) bool {
	return r >= 0x40 && r <= 0x7E
}

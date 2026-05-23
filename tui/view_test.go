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
	got := detailTitle("My Skill", accent, "", 40)
	if !strings.Contains(got, "My Skill") {
		t.Fatalf("detailTitle missing name: %q", got)
	}
	if !strings.Contains(got, "\n") {
		t.Fatalf("detailTitle missing the header rule (no newline): %q", got)
	}
	// Edge widths must not panic.
	_ = detailTitle("x", accent, "", 0)
	_ = detailTitle("x", accent, "", -1)
	// Icon parameter must not panic when provided.
	_ = detailTitle("x", accent, "◆", 40)
}

// ── detailSection tests ───────────────────────────────────────────────────────

// TestDetailSectionRenders asserts detailSection renders the group label plus a
// dim rule glyph, and that degenerate widths (0 and negative) do not panic.
func TestDetailSectionRenders(t *testing.T) {
	got := stripANSI(detailSection("Provenance", accent, 60))
	if !strings.Contains(got, "Provenance") {
		t.Fatalf("detailSection missing label: %q", got)
	}
	// The rule uses glyph("─","-"): the Unicode bar when a color profile is
	// detected, the ASCII fallback otherwise (the test binary has no TTY).
	if !strings.Contains(got, glyph("─", "-")) {
		t.Fatalf("detailSection missing rule glyph: %q", got)
	}
	// Degenerate widths must not panic.
	_ = detailSection("X", accent, 0)
	_ = detailSection("X", accent, -5)
}

// TestComponentDetailGrouped asserts componentDetail wraps its fields in the new
// group headers (Provenance/Location/About) while preserving every field label
// and value — proving grouping was added without changing content.
func TestComponentDetailGrouped(t *testing.T) {
	c := Component{
		Name:        "demo",
		Kind:        "skill",
		Source:      ComponentSource{Tier: "user"},
		Path:        "/p/demo",
		Description: "does things",
	}
	got := stripANSI(componentDetail(c, accent, 80))

	for _, want := range []string{
		// New group headers.
		"Provenance", "Location", "About",
		// Preserved field labels.
		"Kind", "Source", "Path", "Description",
		// Preserved values.
		"skill", "does things",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("componentDetail missing %q:\n%s", want, got)
		}
	}
}

// TestComponentDetailShowsMarketplaceVersion asserts the Provenance group
// surfaces the optional Marketplace and Version source fields when present.
func TestComponentDetailShowsMarketplaceVersion(t *testing.T) {
	c := Component{
		Name:        "x",
		Kind:        "skill",
		Source:      ComponentSource{Tier: "plugin", Plugin: "alpha", Marketplace: "acme", Version: "1.2.3"},
		Path:        "/p",
		Description: "d",
	}
	got := stripANSI(componentDetail(c, accent, 80))
	for _, want := range []string{"Marketplace", "acme", "Version", "1.2.3"} {
		if !strings.Contains(got, want) {
			t.Fatalf("componentDetail missing %q:\n%s", want, got)
		}
	}
}

// ── mascot / layout tests ─────────────────────────────────────────────────────

// TestRenderMascotThreeLines asserts renderMascot returns a 3-line block with
// non-empty content (testable regardless of Unicode — renderMascot does not gate).
func TestRenderMascotThreeLines(t *testing.T) {
	got := renderMascot()
	if n := strings.Count(got, "\n"); n != 2 {
		t.Fatalf("renderMascot newlines = %d, want 2 (3 lines)", n)
	}
	if stripANSI(got) == "" {
		t.Fatal("renderMascot returned empty content")
	}
}

// TestBarFitsOneLine exercises the content-aware fit logic that gates the corner
// mascot — directly, without unicodeEnabled() (false under `go test`). A counts
// bar rendered at a generous width occupies one row; the same bar forced into a
// tiny width wraps to multiple rows. mascotVisible shows the mascot only in the
// former case, falling back to a full-width bar in the latter.
func TestBarFitsOneLine(t *testing.T) {
	c := Counts{Skills: 240, Agents: 19, Commands: 79, Plugins: 13, Marketplaces: 4, McpServers: 6}

	wide := countsBarView(c, 200)
	if !barFitsOneLine(wide) {
		t.Fatalf("counts bar at width 200 should fit one line, got height %d", lipgloss.Height(wide))
	}

	narrow := countsBarView(c, 15)
	if barFitsOneLine(narrow) {
		t.Fatalf("counts bar at width 15 should wrap to >1 line, got height %d", lipgloss.Height(narrow))
	}
}

// TestMascotBarWidthReserves asserts mascotBarWidth subtracts the mascot block
// from the terminal width and floors the result at 1, so a degenerate width can
// never produce a zero/negative bar width downstream.
func TestMascotBarWidthReserves(t *testing.T) {
	mb := mascotBlockWidth()
	if got, want := mascotBarWidth(200), 200-mb; got != want {
		t.Fatalf("mascotBarWidth(200) = %d, want %d (200 - mascotBlockWidth)", got, want)
	}
	if got := mascotBarWidth(mb); got != 1 {
		t.Fatalf("mascotBarWidth(mascotBlockWidth) = %d, want 1 (floored)", got)
	}
	if got := mascotBarWidth(0); got != 1 {
		t.Fatalf("mascotBarWidth(0) = %d, want 1 (floored)", got)
	}
}

// TestMascotEligibleRequiresUnicode asserts the cheap precondition gate: without
// a color/Unicode profile (no TTY under `go test`) the mascot is never eligible,
// regardless of width, so the sprite glyphs can never render as mojibake.
func TestMascotEligibleRequiresUnicode(t *testing.T) {
	if mascotEligible(200) {
		t.Fatal("mascotEligible(200) = true without Unicode (no TTY under go test), want false")
	}
}

// TestSplitDimsReservesForMascotWhenAbsent guards the normal (no-mascot) path:
// in the no-Unicode test env mascotVisible is false (mascotEligible gates on
// Unicode), so splitDims reserves only chromeRows and boxH = height - chromeRows.
func TestSplitDimsReservesForMascotWhenAbsent(t *testing.T) {
	m := model{width: 120, height: 30}
	_, _, boxH := m.splitDims()
	if want := 30 - chromeRows; boxH != want {
		t.Fatalf("splitDims boxH = %d, want %d (height - chromeRows, mascot absent in test env)", boxH, want)
	}
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

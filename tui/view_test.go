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

// TestRenderMascotLineCount asserts renderMascot returns one rendered row per
// splashMascot line with non-empty content (testable regardless of Unicode —
// renderMascot does not gate). Tied to len(splashMascot) so the sprite's row
// count can change without breaking this test.
func TestRenderMascotLineCount(t *testing.T) {
	got := renderMascot(false)
	if n, want := strings.Count(got, "\n"), len(splashMascot)-1; n != want {
		t.Fatalf("renderMascot newlines = %d, want %d (%d lines)", n, want, len(splashMascot))
	}
	if stripANSI(got) == "" {
		t.Fatal("renderMascot returned empty content")
	}
}

// TestRenderMascotBlinkDiffers asserts the blink (eyes-closed) frame differs from
// the open frame but has identical dimensions (same row count AND per-row width),
// so the blink changes only the eyes and never shifts the header layout. The
// blink is a per-cell COLOR change (white eye → dark), so it differs in the frame
// DATA even though the no-TTY test render strips color and makes the rendered
// █-grids compare equal — hence we assert on the frames, plus equal render lines.
func TestRenderMascotBlinkDiffers(t *testing.T) {
	if len(splashMascot) != len(splashMascotBlink) {
		t.Fatalf("frames differ in row count: %d vs %d", len(splashMascot), len(splashMascotBlink))
	}
	differs := false
	for i := range splashMascot {
		if splashMascot[i] != splashMascotBlink[i] {
			differs = true
		}
		if a, b := lipgloss.Width(splashMascot[i]), lipgloss.Width(splashMascotBlink[i]); a != b {
			t.Fatalf("frame row %d width differs: open=%d closed=%d (would jitter mid-blink)", i, a, b)
		}
	}
	if !differs {
		t.Fatal("blink frame should differ from the eyes-open frame (the eye row)")
	}
	if a, b := strings.Count(renderMascot(false), "\n"), strings.Count(renderMascot(true), "\n"); a != b {
		t.Fatalf("open/closed render line counts differ: %d vs %d", a, b)
	}
}

// TestBlinkMsgTogglesAndReschedules asserts a blinkMsg flips model.mascotBlink
// and returns a non-nil command to schedule the next blink (so the animation
// keeps cycling).
func TestBlinkMsgTogglesAndReschedules(t *testing.T) {
	m := initialModel("x")
	if m.mascotBlink {
		t.Fatal("mascotBlink should start false (eyes open)")
	}
	next, cmd := m.Update(blinkMsg{})
	nm := next.(model)
	if !nm.mascotBlink {
		t.Fatal("blinkMsg should toggle mascotBlink to true (eyes closed)")
	}
	if cmd == nil {
		t.Fatal("blinkMsg should reschedule the next blink (non-nil cmd)")
	}
	if next2, _ := nm.Update(blinkMsg{}); next2.(model).mascotBlink {
		t.Fatal("second blinkMsg should toggle back to false (eyes open)")
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

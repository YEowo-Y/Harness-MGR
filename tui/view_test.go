package main

import (
	"errors"
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

// TestDetailFieldWrapsLongValue asserts a value longer than the available space
// is word-wrapped across multiple lines (no ellipsis) and each visual line fits
// within the pane width. The full value text must be present across those lines.
func TestDetailFieldWrapsLongValue(t *testing.T) {
	const width = 60
	long := strings.Repeat("x", 200)
	row := detailField("Kind", long, width)
	stripped := stripANSI(row)

	// The full value text must be recoverable across lines (no truncation/ellipsis).
	// Join all visual lines and strip spaces to reconstruct the wrapped value.
	joined := strings.ReplaceAll(strings.TrimRight(stripped, "\n"), "\n", "")
	joined = strings.ReplaceAll(joined, " ", "")
	if !strings.Contains(joined, long) {
		t.Fatalf("detailField should contain full value text (no ellipsis), reconstructed: %q", joined)
	}

	// Every line must fit within width columns.
	for i, line := range strings.Split(strings.TrimRight(stripped, "\n"), "\n") {
		if n := len([]rune(line)); n > width {
			t.Fatalf("line %d wider than width=%d: %d runes: %q", i, width, n, line)
		}
	}

	// Output must span more than one line (wrapping occurred).
	if strings.Count(stripped, "\n") < 1 {
		t.Fatalf("detailField with long value should wrap to multiple lines")
	}
}

// ── conflictDetail reflow test ────────────────────────────────────────────────

// TestConflictDetailReflowNarrow asserts that a long value (the Reason field)
// is fully visible at both narrow and wide widths — wrapping keeps the full text
// readable at any width, with narrower widths producing more lines.
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

	// Both narrow and wide must contain the full reason text (wrapping, not truncation).
	longSuffix := "exceeds narrow widths"
	if !strings.Contains(wideStripped, longSuffix) {
		t.Fatalf("wide detail missing expected reason text %q:\n%s", longSuffix, wideStripped)
	}
	if !strings.Contains(narrowStripped, longSuffix) {
		t.Fatalf("narrow detail should wrap (not truncate) and still contain %q:\n%s", longSuffix, narrowStripped)
	}

	// The narrow version must produce more lines than the wide version.
	if strings.Count(narrowStripped, "\n") <= strings.Count(wideStripped, "\n") {
		t.Fatalf("narrow detail should have more lines than wide (wrapping), narrow=%d wide=%d",
			strings.Count(narrowStripped, "\n"), strings.Count(wideStripped, "\n"))
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

// TestPlural asserts the count-aware noun pluralization used by the health
// verdict: only a count of exactly 1 keeps the singular form.
func TestPlural(t *testing.T) {
	cases := []struct {
		n    int
		word string
		want string
	}{
		{0, "orphan", "0 orphans"},
		{1, "orphan", "1 orphan"},
		{2, "orphan", "2 orphans"},
		{1, "conflict", "1 conflict"},
		{3, "diagnostic", "3 diagnostics"},
	}
	for _, tc := range cases {
		if got := plural(tc.n, tc.word); got != tc.want {
			t.Errorf("plural(%d, %q) = %q, want %q", tc.n, tc.word, got, tc.want)
		}
	}
}

// healthModel builds a model with conflicts/orphans section state and inventory
// diagnostics for healthVerdict/headerLeftColumn tests. loading marks both
// sections as still fetching.
func healthModel(conflicts, orphans, diags int, loading bool) model {
	return model{
		inv: Inventory{Diagnostics: make([]Diagnostic, diags)},
		sections: map[viewID]*sectionState{
			viewConflicts: {loading: loading, list: newSectionModel(make([]sectionItem, conflicts))},
			viewOrphans:   {loading: loading, list: newSectionModel(make([]sectionItem, orphans))},
		},
	}
}

// TestHealthVerdictClean asserts a fully healthy harness (zero conflicts, orphans,
// and diagnostics) yields the "clean" tally listing all three zero counts plus the
// success marker ("OK" is glyph's no-TTY fallback for ✓).
func TestHealthVerdictClean(t *testing.T) {
	v := stripANSI(healthModel(0, 0, 0, false).healthVerdict())
	for _, want := range []string{"0 conflicts", "0 orphans", "0 diagnostics", "OK"} {
		if !strings.Contains(v, want) {
			t.Fatalf("clean verdict %q missing %q", v, want)
		}
	}
}

// TestHealthVerdictIssues asserts a harness with problems lists each signal with
// its count and the warning marker, pluralizing by count (1 orphan, not orphans).
func TestHealthVerdictIssues(t *testing.T) {
	v := stripANSI(healthModel(2, 1, 1, false).healthVerdict())
	for _, want := range []string{"2 conflicts", "1 orphan", "1 diagnostic", "!"} {
		if !strings.Contains(v, want) {
			t.Fatalf("issue verdict %q missing %q", v, want)
		}
	}
	if strings.Contains(v, "1 orphans") {
		t.Fatalf("verdict should use singular '1 orphan' for a count of 1, got %q", v)
	}
}

// TestHealthVerdictInventoryError asserts that when the inventory fetch failed
// (m.err set, so m.inv is zero-valued) the verdict reports "unavailable" rather
// than a false-clean "0 diagnostics" tally.
func TestHealthVerdictInventoryError(t *testing.T) {
	m := healthModel(0, 0, 0, false)
	m.err = errors.New("inventory fetch failed")
	v := stripANSI(m.healthVerdict())
	if strings.Contains(v, "0 diagnostics") {
		t.Fatalf("verdict must not report a false count when inventory fetch failed, got %q", v)
	}
	if !strings.Contains(v, "unavailable") {
		t.Fatalf("verdict should report checks unavailable on inventory error, got %q", v)
	}
}

// TestHealthVerdictLoading asserts that while the conflicts/orphans fetches are
// still in flight the verdict shows a "checking" placeholder, never a misleading
// all-zero "clean".
func TestHealthVerdictLoading(t *testing.T) {
	v := stripANSI(healthModel(0, 0, 0, true).healthVerdict())
	if !strings.Contains(v, "checking") {
		t.Fatalf("loading verdict %q should contain 'checking'", v)
	}
}

// TestHeaderLeftColumnRowCount guards the layout invariant: the header's left
// column is ALWAYS exactly len(splashMascot) rows tall, so the rendered header
// height matches the splitDims reservation (chromeRows + mascotExtraRows) and the
// health lockup can never overflow the frame (the bug the old stats panel had).
func TestHeaderLeftColumnRowCount(t *testing.T) {
	m := healthModel(0, 0, 0, false)
	m.width = 120
	build := func(w int) string { return countsBarView(Counts{}, w) }
	got := m.headerLeftColumn(build, 100)
	if n, want := strings.Count(got, "\n"), len(splashMascot)-1; n != want {
		t.Fatalf("headerLeftColumn lines = %d, want %d (== mascot height)", n+1, want+1)
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

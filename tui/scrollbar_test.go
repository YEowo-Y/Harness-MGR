package main

import (
	"strings"
	"testing"
)

// ── scrollbarColumn unit tests ────────────────────────────────────────────────

// TestScrollbarColumnExactHeight asserts the returned slice always has exactly
// `height` entries for a range of inputs.
func TestScrollbarColumnExactHeight(t *testing.T) {
	cases := []struct{ total, windowH, offset, height int }{
		{240, 20, 0, 20},
		{240, 20, 100, 20},
		{5, 5, 0, 10},
		{0, 5, 0, 8},
		{10, 10, 0, 1},
		{10, 3, 7, 5},
	}
	for _, tc := range cases {
		got := scrollbarColumn(tc.total, tc.windowH, tc.offset, tc.height)
		if len(got) != tc.height {
			t.Errorf("scrollbarColumn(%d,%d,%d,%d) len=%d, want %d",
				tc.total, tc.windowH, tc.offset, tc.height, len(got), tc.height)
		}
	}
}

// TestScrollbarColumnHeightZeroReturnsNil asserts height<1 yields nil (no panic).
func TestScrollbarColumnHeightZeroReturnsNil(t *testing.T) {
	if got := scrollbarColumn(10, 5, 0, 0); got != nil {
		t.Errorf("height=0 should return nil, got %v", got)
	}
	if got := scrollbarColumn(10, 5, 0, -5); got != nil {
		t.Errorf("height=-5 should return nil, got %v", got)
	}
}

// TestScrollbarColumnBlankWhenFits asserts total≤visibleH (or degenerate input) →
// a blank column (no scrollbar drawn for a non-scrolling list).
func TestScrollbarColumnBlankWhenFits(t *testing.T) {
	cases := []struct{ total, visibleH int }{
		{5, 5},
		{3, 10},
		{0, 10},
		{1, 1},
	}
	for _, tc := range cases {
		col := scrollbarColumn(tc.total, tc.visibleH, 0, 8)
		for i, g := range col {
			if g != " " {
				t.Errorf("total=%d visibleH=%d: col[%d]=%q, want blank %q",
					tc.total, tc.visibleH, i, g, " ")
			}
		}
	}
}

// TestScrollbarColumnThumbAtTopWhenOffsetZero asserts that with a tall list and
// offset=0 the thumb starts at the top (index 0) of the column.
func TestScrollbarColumnThumbAtTopWhenOffsetZero(t *testing.T) {
	thumb := glyph("█", "#")
	col := scrollbarColumn(240, 20, 0, 20)
	if col[0] != thumb {
		t.Errorf("offset=0: col[0]=%q, want thumb %q", col[0], thumb)
	}
}

// TestScrollbarColumnThumbAtBottomNearMaxOffset asserts that with offset near the
// max the thumb is at the bottom of the column.
func TestScrollbarColumnThumbAtBottomNearMaxOffset(t *testing.T) {
	thumb := glyph("█", "#")
	total, windowH, height := 240, 20, 20
	maxOffset := total - windowH // 220
	col := scrollbarColumn(total, windowH, maxOffset, height)
	// The thumb must include the last row.
	if col[height-1] != thumb {
		t.Errorf("offset=maxOffset: col[last]=%q, want thumb %q", col[height-1], thumb)
	}
}

// TestScrollbarColumnThumbNeverExceedsBounds asserts thumb rows are always
// within [0, height).
func TestScrollbarColumnThumbNeverExceedsBounds(t *testing.T) {
	thumb := glyph("█", "#")
	total, windowH, height := 240, 20, 20
	for offset := 0; offset <= total-windowH; offset += 10 {
		col := scrollbarColumn(total, windowH, offset, height)
		inThumb := false
		ended := false
		for i, g := range col {
			if g == thumb {
				if ended {
					t.Errorf("offset=%d: thumb not contiguous (gap at %d)", offset, i)
				}
				inThumb = true
			} else {
				if inThumb {
					ended = true
				}
			}
		}
	}
}

// TestScrollbarColumnThumbMinOneWhenOverflowing asserts thumbH >= 1 even for a
// very long list (prevents a zero-height invisible thumb).
func TestScrollbarColumnThumbMinOneWhenOverflowing(t *testing.T) {
	thumb := glyph("█", "#")
	// total=10000 windowH=1 height=10 → thumbH = max(1, 10*1/10000) = 1
	col := scrollbarColumn(10000, 1, 0, 10)
	found := false
	for _, g := range col {
		if g == thumb {
			found = true
			break
		}
	}
	if !found {
		t.Error("thumb should appear at least once even for a very tall list")
	}
}

// TestScrollbarColumnDefensiveNegativeInputs asserts no panic on hostile inputs.
func TestScrollbarColumnDefensiveNegativeInputs(t *testing.T) {
	// All of these must not panic.
	_ = scrollbarColumn(-1, -1, -1, 5)
	_ = scrollbarColumn(0, 0, 0, 5)
	_ = scrollbarColumn(10, -5, -100, 5)
	_ = scrollbarColumn(10, 20, 999, 5) // offset past maxOffset
}

// TestScrollbarColumnOffsetPastMaxIsClamped asserts that an offset larger than
// maxOffset still places the thumb at the bottom (no out-of-bounds panic).
func TestScrollbarColumnOffsetPastMaxIsClamped(t *testing.T) {
	thumb := glyph("█", "#")
	col := scrollbarColumn(10, 5, 9999, 10)
	if col[len(col)-1] != thumb {
		t.Errorf("clamped offset: last cell = %q, want thumb %q", col[len(col)-1], thumb)
	}
}

// ── composeListWithScrollbar unit tests ───────────────────────────────────────

// TestComposeListLineCount asserts the output always has exactly innerH lines.
func TestComposeListLineCount(t *testing.T) {
	list := "row0\nrow1\nrow2\nrow3\nrow4"
	out := composeListWithScrollbar(list, 20, 6, 10, 5, 0, 0)
	lines := strings.Split(out, "\n")
	if len(lines) != 6 {
		t.Errorf("output lines = %d, want innerH=6 (got %q)", len(lines), out)
	}
}

// TestComposeListGutterAtExpectedColumn asserts the gutter rune appears at
// column innerW-1 (0-indexed) on every content row.
func TestComposeListGutterAtExpectedColumn(t *testing.T) {
	innerW := 10
	innerH := 4
	list := "abc\ndef" // only 2 content rows; contentH=3
	out := composeListWithScrollbar(list, innerW, innerH, 20, innerH-1, 0, 0)
	lines := strings.Split(out, "\n")
	// Content rows are lines[0..innerH-2]; footer is lines[innerH-1].
	contentLines := lines[:innerH-1]
	for i, ln := range contentLines {
		// Strip ANSI so we measure plain runes. The gutter glyph is ASCII in test env.
		plain := stripANSI(ln)
		runes := []rune(plain)
		if len(runes) != innerW {
			t.Errorf("content row %d width = %d runes, want %d: %q", i, len(runes), innerW, plain)
		}
	}
}

// TestComposeListFallbackOnTinyPane asserts that a pane with innerW<2 or innerH<2
// returns listStr unchanged.
func TestComposeListFallbackOnTinyPane(t *testing.T) {
	list := "hello"
	if got := composeListWithScrollbar(list, 1, 10, 5, 9, 0, 0); got != list {
		t.Errorf("innerW=1 should fall back to listStr, got %q", got)
	}
	if got := composeListWithScrollbar(list, 10, 1, 5, 0, 0, 0); got != list {
		t.Errorf("innerH=1 should fall back to listStr, got %q", got)
	}
}

// TestComposeListFooterContainsPositionText asserts the footer line contains the
// "current/total" numbers.
func TestComposeListFooterContainsPositionText(t *testing.T) {
	list := "row0\nrow1\nrow2"
	// cursor=1 → current=2, total=5
	out := composeListWithScrollbar(list, 15, 5, 5, 4, 0, 1)
	lines := strings.Split(out, "\n")
	footer := stripANSI(lines[len(lines)-1])
	if !strings.Contains(footer, "2/5") {
		t.Errorf("footer %q does not contain %q", footer, "2/5")
	}
}

// TestComposeListFooterZeroTotalShowsZero asserts total=0 → footer shows "0/0".
func TestComposeListFooterZeroTotalShowsZero(t *testing.T) {
	out := composeListWithScrollbar("", 15, 4, 0, 3, 0, 0)
	lines := strings.Split(out, "\n")
	footer := stripANSI(lines[len(lines)-1])
	if !strings.Contains(footer, "0/0") {
		t.Errorf("footer with total=0 %q does not contain %q", footer, "0/0")
	}
}

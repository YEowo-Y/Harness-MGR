package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── Scrollbar helpers ─────────────────────────────────────────────────────────
//
// scrollbarColumn and composeListWithScrollbar add a 1-column proportional
// scrollbar gutter to the right edge of the list pane, plus a "current/total"
// position footer at the bottom. Both helpers are PURE (no I/O, no side-effects)
// and degrade gracefully on tiny panes or degenerate inputs.

// scrollbarColumn returns exactly height strings, each a single-cell glyph:
// a proportional thumb (█) over a track (░) when the list overflows the window,
// or a BLANK column (spaces) when the whole list fits — so a non-scrolling list
// draws no scrollbar at all (the modern "hide when not scrollable" convention).
//
// Math:
//   - total ≤ visibleH (or degenerate input) → all blank (nothing to scroll)
//   - else: thumbH = max(1, height*visibleH/total); thumbStart proportional to offset
//   - All inputs are clamped defensively.
//
// visibleH is the number of rows the window can show at once (== the bar height
// at the call sites today, but kept distinct so the formula stays correct if a
// caller ever decouples them).
func scrollbarColumn(total, visibleH, offset, height int) []string {
	if height < 1 {
		return nil
	}

	out := make([]string, height)

	// Everything fits, or degenerate input → blank column (no scrollbar drawn).
	if total <= visibleH || visibleH < 1 || total < 1 {
		for i := range out {
			out[i] = " "
		}
		return out
	}

	track := glyph("░", "|")
	thumb := glyph("█", "#")
	for i := range out {
		out[i] = track
	}

	// Proportional thumb.
	thumbH := height * visibleH / total
	if thumbH < 1 {
		thumbH = 1
	}

	maxOffset := total - visibleH
	if maxOffset < 1 {
		maxOffset = 1
	}
	if offset < 0 {
		offset = 0
	}
	if offset > maxOffset {
		offset = maxOffset
	}

	thumbStart := (height - thumbH) * offset / maxOffset
	// Clamp defensively (unreachable given offset∈[0,maxOffset] and thumbH≤height).
	if thumbStart < 0 {
		thumbStart = 0
	}
	if thumbStart > height-thumbH {
		thumbStart = height - thumbH
	}

	for r := thumbStart; r < thumbStart+thumbH; r++ {
		out[r] = thumb
	}
	return out
}

// footerDimStyle is the lipgloss style used for the "current/total" position
// footer. It uses labelGray (the standard de-emphasized foreground) so it
// recedes without disappearing.
var footerDimStyle = lipgloss.NewStyle().Foreground(labelGray)

// composeListWithScrollbar assembles the final left-pane body from the raw list
// string produced by a widget's render() call, attaching a 1-column scrollbar
// gutter at the right edge and a "current/total" footer on the last line.
//
// Parameters:
//   - listStr  : the string returned by tree.render / sectionModel.render
//   - innerW   : full inner pane width (gutter occupies the rightmost column)
//   - innerH   : full inner pane height (footer occupies the bottom row)
//   - total    : total number of rows in the list (len(visible) or len(filtered()))
//   - visibleH : rows the list was rendered at (= innerH - 1 = contentH)
//   - offset   : the current scroll offset
//   - cursor   : the cursor row index (0-based)
//
// The caller must have rendered the list at width=innerW-1, height=innerH-1
// so the gutter and footer fit without overlap.
//
// Falls back to listStr unchanged when innerW < 2 or innerH < 2 (too small).
func composeListWithScrollbar(listStr string, innerW, innerH, total, visibleH, offset, cursor int) string {
	if innerW < 2 || innerH < 2 {
		return listStr
	}

	contentH := innerH - 1 // last row reserved for the footer

	// Split the rendered list into lines.
	lines := strings.Split(listStr, "\n")

	// Build the scrollbar column for the content area.
	bars := scrollbarColumn(total, visibleH, offset, contentH)

	// Each list row was already truncated to innerW-1 display columns by the
	// widget's render(), so we only right-pad here (lipgloss.Width is ANSI/CJK-safe).
	// We must NOT run the plain-text truncate() on these rows — they are already
	// ANSI-styled and cutting them by rune would split escape sequences; in the
	// (unreachable) over-wide case we leave the row intact rather than corrupt it.
	composed := make([]string, contentH)
	want := innerW - 1
	for r := 0; r < contentH; r++ {
		var line string
		if r < len(lines) {
			line = lines[r]
		}
		if w := lipgloss.Width(line); w < want {
			line += strings.Repeat(" ", want-w)
		}
		bar := " "
		if r < len(bars) {
			bar = bars[r]
		}
		composed[r] = line + bar
	}

	// Footer: "current/total" right-aligned within innerW columns.
	current := cursor + 1
	if total == 0 {
		current = 0
	}
	footerText := fmt.Sprintf("%d/%d", current, total)
	footerRendered := footerDimStyle.Render(footerText)
	// Measure rendered width (ANSI-safe).
	renderedW := lipgloss.Width(footerRendered)
	pad := innerW - renderedW
	if pad < 0 {
		pad = 0
	}
	footer := strings.Repeat(" ", pad) + footerRendered

	// Join content rows and footer. Three-index slice forces cap==len so append
	// always allocates a fresh backing array (no aliasing into composed).
	allRows := append(composed[:contentH:contentH], footer)
	return strings.Join(allRows, "\n")
}

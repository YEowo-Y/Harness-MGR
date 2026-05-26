package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// ── D2: selected-row highlight band ──────────────────────────────────────────
//
// The band is implemented via lipgloss.NewStyle().Background(selectionBg).Width(width).
// In a no-TTY test environment lipgloss emits no ANSI color sequences, so we
// cannot check for the background color code directly. Instead we verify the
// band's structural effects:
//
//  1. A selected row's ANSI-aware display width (lipgloss.Width) == width,
//     proving Width(width) padded the row to fill the full band area.
//  2. A non-selected row with the same short title is narrower than width,
//     proving the band is ONLY applied to the cursor row.
//  3. The plain-text content (stripANSI rune count) of a selected row == width,
//     confirming the padding is real visible space, not hidden ANSI bytes.

// ── Tree folder row ───────────────────────────────────────────────────────────

// TestD2FolderSelectedRowLipglossWidth verifies that a selected folder row has
// ANSI-aware display width == width (band fills the row).
func TestD2FolderSelectedRowLipglossWidth(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[0] // Skills folder header
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderFolderRow(row, meta, true /*selected*/, width)
	if got := lipgloss.Width(rendered); got != width {
		t.Fatalf("selected folder row lipgloss.Width = %d, want %d\nraw: %q",
			got, width, rendered)
	}
}

// TestD2FolderSelectedRowFullWidth verifies the plain-text rune count == width.
func TestD2FolderSelectedRowFullWidth(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[0]
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderFolderRow(row, meta, true /*selected*/, width)
	plain := stripANSI(rendered)
	if got := len([]rune(plain)); got != width {
		t.Fatalf("selected folder row display width = %d, want %d\nplain: %q",
			got, width, plain)
	}
}

// TestD2FolderNonSelectedRowNarrow verifies a non-selected folder row with a
// short title is narrower than width (band ONLY on cursor row).
func TestD2FolderNonSelectedRowNarrow(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[0]
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderFolderRow(row, meta, false /*not selected*/, width)
	got := lipgloss.Width(rendered)
	if got >= width {
		t.Fatalf("non-selected folder row lipgloss.Width = %d, want < %d (no band on non-cursor rows)",
			got, width)
	}
}

// ── Tree item row ─────────────────────────────────────────────────────────────

// TestD2ItemSelectedRowLipglossWidth verifies that a selected item row has
// ANSI-aware display width == width.
func TestD2ItemSelectedRowLipglossWidth(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[1] // Skills item "seo"
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderItemRow(row, meta, true /*selected*/, width)
	if got := lipgloss.Width(rendered); got != width {
		t.Fatalf("selected item row lipgloss.Width = %d, want %d\nraw: %q",
			got, width, rendered)
	}
}

// TestD2ItemSelectedRowFullWidth verifies the plain-text rune count == width.
func TestD2ItemSelectedRowFullWidth(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[1]
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderItemRow(row, meta, true /*selected*/, width)
	plain := stripANSI(rendered)
	if got := len([]rune(plain)); got != width {
		t.Fatalf("selected item row display width = %d, want %d\nplain: %q",
			got, width, plain)
	}
}

// TestD2ItemNonSelectedRowNarrow verifies a non-selected item row is narrower
// than width (no band on non-cursor rows).
func TestD2ItemNonSelectedRowNarrow(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	const width = 40
	row := tr.visible[1]
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderItemRow(row, meta, false /*not selected*/, width)
	got := lipgloss.Width(rendered)
	if got >= width {
		t.Fatalf("non-selected item row lipgloss.Width = %d, want < %d (no band on non-cursor rows)",
			got, width)
	}
}

// ── Section row ───────────────────────────────────────────────────────────────

// TestD2SectionSelectedRowLipglossWidth verifies that a selected section row
// has ANSI-aware display width == width.
func TestD2SectionSelectedRowLipglossWidth(t *testing.T) {
	items := []sectionItem{
		{title: "alpha", color: lipgloss.Color("#2DD4BF")},
		{title: "beta", color: lipgloss.Color("#A78BFA")},
	}
	m := newSectionModel(items)
	m.cursor = 0
	const width = 40
	rendered := m.renderRow(items, 0, width)
	if got := lipgloss.Width(rendered); got != width {
		t.Fatalf("selected section row lipgloss.Width = %d, want %d\nraw: %q",
			got, width, rendered)
	}
}

// TestD2SectionSelectedRowFullWidth verifies the plain-text rune count == width.
func TestD2SectionSelectedRowFullWidth(t *testing.T) {
	items := []sectionItem{
		{title: "alpha", color: lipgloss.Color("#2DD4BF")},
	}
	m := newSectionModel(items)
	m.cursor = 0
	const width = 40
	rendered := m.renderRow(items, 0, width)
	plain := stripANSI(rendered)
	if got := len([]rune(plain)); got != width {
		t.Fatalf("selected section row display width = %d, want %d\nplain: %q",
			got, width, plain)
	}
}

// TestD2SectionNonSelectedRowNarrow verifies a non-selected section row with a
// short title ("hi" = 2 runes) is narrower than width, proving the band is
// exclusively applied to the cursor row.
func TestD2SectionNonSelectedRowNarrow(t *testing.T) {
	items := []sectionItem{
		{title: "hi", color: lipgloss.Color("#2DD4BF")},
		{title: "hi", color: lipgloss.Color("#A78BFA")},
	}
	m := newSectionModel(items)
	m.cursor = 0
	const width = 40
	// Render row 1 (non-cursor) while cursor is at 0.
	rendered := m.renderRow(items, 1, width)
	got := lipgloss.Width(rendered)
	// Non-selected row is "  hi" (2-space indent + 2-rune title = 4 cols).
	if got >= width {
		t.Fatalf("non-selected section row lipgloss.Width = %d, want < %d (no band on non-cursor rows)",
			got, width)
	}
}

// TestD2BandComposesWithScrollbarGutter verifies that a selected row from the
// tree renders to exactly innerW-1 display columns — so composeListWithScrollbar
// appends the 1-col gutter at the correct column with no shift.
func TestD2BandComposesWithScrollbarGutter(t *testing.T) {
	const innerW = 32 // arbitrary; innerW-1 = 31 is the render width
	const renderW = innerW - 1
	tr := newTreeModel(sampleDetail())
	// Render the selected folder header at renderW (= innerW-1, as the caller passes).
	row := tr.visible[0]
	meta := kindMetas[tr.folders[row.folderIdx].kind]
	rendered := tr.renderFolderRow(row, meta, true /*selected*/, renderW)
	if got := lipgloss.Width(rendered); got != renderW {
		t.Fatalf("selected row at renderW=%d has lipgloss.Width=%d; gutter would be misaligned",
			renderW, got)
	}
	// Confirm composeListWithScrollbar does NOT add extra padding to this row
	// (because it's already exactly want=innerW-1 cols wide).
	composed := composeListWithScrollbar(rendered+"\n", innerW, 3, 5, 2, 0, 0)
	firstLine := strings.SplitN(composed, "\n", 2)[0]
	// The composed line is renderW cols of content + 1 col gutter = innerW total.
	if got := lipgloss.Width(firstLine); got != innerW {
		t.Fatalf("composed line width = %d, want %d (renderW=%d + 1 gutter)", got, innerW, renderW)
	}
}

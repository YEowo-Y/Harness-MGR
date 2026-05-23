package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

func sampleItems() []sectionItem {
	return []sectionItem{
		{title: "alpha", color: lipgloss.Color("#2DD4BF")},
		{title: "beta", color: lipgloss.Color("#A78BFA")},
		{title: "gamma", color: lipgloss.Color("#F59E0B")},
	}
}

// ── Empty list ────────────────────────────────────────────────────────────────

func TestSectionEmptySelectedItemOkFalse(t *testing.T) {
	m := newSectionModel(nil)
	_, ok := m.selectedItem()
	if ok {
		t.Fatal("selectedItem should return ok=false on an empty list")
	}
}

func TestSectionEmptyRenderNoPanic(t *testing.T) {
	m := newSectionModel(nil)
	got := m.render(80, 24)
	if got != "" {
		t.Fatalf("render on empty list should return %q, got %q", "", got)
	}
}

func TestSectionEmptyMoveUpDownNoPanic(t *testing.T) {
	m := newSectionModel(nil)
	m.moveUp(5)
	m.moveDown(5)
	m.gotoTop()
	m.gotoBottom()
	if m.cursor != 0 {
		t.Fatalf("cursor should stay 0 on empty list, got %d", m.cursor)
	}
}

// ── Navigation clamping ───────────────────────────────────────────────────────

func TestSectionMoveDownClampsAtLast(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.moveDown(100)
	if want := len(m.items) - 1; m.cursor != want {
		t.Fatalf("moveDown(100) cursor = %d, want %d", m.cursor, want)
	}
}

func TestSectionMoveUpClampsAtZero(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.moveDown(2)
	m.moveUp(100)
	if m.cursor != 0 {
		t.Fatalf("moveUp(100) cursor = %d, want 0", m.cursor)
	}
}

func TestSectionGotoBottom(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.gotoBottom()
	if want := len(m.items) - 1; m.cursor != want {
		t.Fatalf("gotoBottom cursor = %d, want %d", m.cursor, want)
	}
}

func TestSectionGotoTop(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.gotoBottom()
	m.gotoTop()
	if m.cursor != 0 {
		t.Fatalf("gotoTop cursor = %d, want 0", m.cursor)
	}
}

func TestSectionMoveUpDownByOne(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.moveDown(1)
	if m.cursor != 1 {
		t.Fatalf("after moveDown(1) cursor = %d, want 1", m.cursor)
	}
	m.moveUp(1)
	if m.cursor != 0 {
		t.Fatalf("after moveUp(1) cursor = %d, want 0", m.cursor)
	}
}

// ── selectedItem returns cursor row ───────────────────────────────────────────

func TestSectionSelectedItemReturnsCursorRow(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.moveDown(1)
	item, ok := m.selectedItem()
	if !ok {
		t.Fatal("selectedItem returned ok=false on non-empty list")
	}
	if item.title != "beta" {
		t.Fatalf("selectedItem title = %q, want %q", item.title, "beta")
	}
}

func TestSectionSelectedItemAtTop(t *testing.T) {
	m := newSectionModel(sampleItems())
	item, ok := m.selectedItem()
	if !ok {
		t.Fatal("selectedItem returned ok=false")
	}
	if item.title != "alpha" {
		t.Fatalf("selectedItem title = %q, want %q", item.title, "alpha")
	}
}

func TestSectionSelectedItemAtBottom(t *testing.T) {
	m := newSectionModel(sampleItems())
	m.gotoBottom()
	item, ok := m.selectedItem()
	if !ok {
		t.Fatal("selectedItem returned ok=false at bottom")
	}
	if item.title != "gamma" {
		t.Fatalf("selectedItem title = %q, want %q", item.title, "gamma")
	}
}

// ── Render ────────────────────────────────────────────────────────────────────

func TestSectionRenderContainsNonCursorTitle(t *testing.T) {
	m := newSectionModel(sampleItems())
	// cursor is at 0 ("alpha"); "beta" and "gamma" are non-cursor rows.
	out := m.render(80, 24)
	if !strings.Contains(out, "beta") {
		t.Fatalf("render missing non-cursor title %q:\n%s", "beta", out)
	}
	if !strings.Contains(out, "gamma") {
		t.Fatalf("render missing non-cursor title %q:\n%s", "gamma", out)
	}
}

func TestSectionRenderCursorRowPresent(t *testing.T) {
	m := newSectionModel(sampleItems())
	out := m.render(80, 24)
	if !strings.Contains(out, "alpha") {
		t.Fatalf("render missing cursor title %q:\n%s", "alpha", out)
	}
}

func TestSectionRenderTinyWidthNoPanic(t *testing.T) {
	m := newSectionModel(sampleItems())
	_ = m.render(1, 1) // must not panic
}

func TestSectionRenderZeroWidthReturnsEmpty(t *testing.T) {
	m := newSectionModel(sampleItems())
	got := m.render(0, 24)
	if got != "" {
		t.Fatalf("render(0, 24) = %q, want empty", got)
	}
}

func TestSectionRenderZeroHeightReturnsEmpty(t *testing.T) {
	m := newSectionModel(sampleItems())
	got := m.render(80, 0)
	if got != "" {
		t.Fatalf("render(80, 0) = %q, want empty", got)
	}
}

func TestSectionRenderNegativeDimsNoPanic(t *testing.T) {
	m := newSectionModel(sampleItems())
	got := m.render(-1, -1)
	if got != "" {
		t.Fatalf("render(-1,-1) = %q, want empty", got)
	}
}

// TestSectionRenderScrollsToKeepCursorVisible verifies that when the cursor is
// past the visible window the rendered output contains the cursor row's title
// and not the rows that have scrolled off the top.
func TestSectionRenderScrollsToKeepCursorVisible(t *testing.T) {
	items := []sectionItem{
		{title: "row0"}, {title: "row1"}, {title: "row2"},
		{title: "row3"}, {title: "row4"}, {title: "row5"},
	}
	m := newSectionModel(items)
	m.gotoBottom() // cursor at row5; height=3 → rows 3/4/5 visible
	out := m.render(80, 3)
	if !strings.Contains(out, "row5") {
		t.Fatalf("cursor row5 not visible in render:\n%s", out)
	}
	if strings.Contains(out, "row0") {
		t.Fatalf("row0 should have scrolled off, but appears in render:\n%s", out)
	}
}

// TestSectionRenderZeroColorDefaultFg verifies that an item with the zero-value
// color ("") renders without panic and still includes the title text.
func TestSectionRenderZeroColorDefaultFg(t *testing.T) {
	m := newSectionModel([]sectionItem{{title: "nocolor", color: ""}})
	out := m.render(80, 10)
	if !strings.Contains(out, "nocolor") {
		t.Fatalf("item with zero color missing from render: %q", out)
	}
}

package main

import "testing"

// ── A5: tree renderRow bounds guard ───────────────────────────────────────────
//
// tree.go's renderRow indexes t.visible[i] directly. The render loop clamps i to
// [offset, len(visible)), so today i is always in range — but a future loop
// desync (or any direct caller passing a stale index) would panic the whole TUI,
// which corrupts the terminal. The guard converts that into a silent "" row,
// mirroring the guard sectionModel.renderRow already has.
//
// These oracles are falsifiable: without the `if i < 0 || i >= len(t.visible)`
// guard, the out-of-range legs index a nil/short slice and PANIC, failing the
// test. The valid-index leg pins that the guard does NOT over-reject in-range
// rows (it still renders real content).

// TestRenderRowEmptyTreeNoPanic: an out-of-range index on an empty tree returns
// "" instead of panicking on t.visible[0].
func TestRenderRowEmptyTreeNoPanic(t *testing.T) {
	tr := treeModel{} // visible is nil
	if got := tr.renderRow(0, 80); got != "" {
		t.Fatalf("renderRow(0) on empty tree = %q, want \"\"", got)
	}
}

// TestRenderRowNegativeIndexNoPanic: a negative index returns "" (a negative
// slice index would panic without the guard).
func TestRenderRowNegativeIndexNoPanic(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	if got := tr.renderRow(-1, 80); got != "" {
		t.Fatalf("renderRow(-1) = %q, want \"\"", got)
	}
}

// TestRenderRowPastEndNoPanic: an index at/after len(visible) returns "" (would
// index past the slice end and panic without the guard).
func TestRenderRowPastEndNoPanic(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	if n := len(tr.visible); n == 0 {
		t.Fatalf("sampleDetail() produced 0 visible rows; fixture broken")
	}
	past := len(tr.visible)
	if got := tr.renderRow(past, 80); got != "" {
		t.Fatalf("renderRow(%d) past end = %q, want \"\"", past, got)
	}
}

// TestRenderRowValidIndexStillRenders: the guard must NOT over-reject — an
// in-range row still renders non-empty content.
func TestRenderRowValidIndexStillRenders(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	if got := tr.renderRow(0, 80); got == "" {
		t.Fatalf("renderRow(0) on a populated tree = \"\", want non-empty content")
	}
}

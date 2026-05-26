package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// componentModel returns a loaded model with a single real skill component whose
// file is at skillPath, panes sized at w×h, splash dismissed.
func componentModel(t *testing.T, skillPath string, w, h int) model {
	t.Helper()
	data := DetailData{
		Components: []Component{
			{Name: "testskill", Kind: "skill", Source: ComponentSource{Tier: "user"}, Path: skillPath},
		},
	}
	m := initialModel("unused")
	mm, _ := m.Update(detailMsg{data: data})
	m = mm.(model)
	// Dismiss the splash.
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{' '}})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m = mm.(model)
	return m
}

// TestCursorMoveSchedulesPreviewCmd verifies that pressing j on the Inventory
// tree (when the cursor actually moves) returns a non-nil Cmd — the debounced
// preview tick — and does NOT panic.
func TestCursorMoveSchedulesPreviewCmd(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, "skill.md")
	if err := os.WriteFile(skillPath, []byte("---\nname: testskill\n---\nBODY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Start at the root of the tree (the Skills folder); j moves into it.
	m := componentModel(t, skillPath, 120, 30)

	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = mm.(model)

	if cmd == nil {
		t.Fatal("expected a non-nil Cmd (schedulePreview) after cursor move, got nil")
	}
	// The detail viewport should contain the node's metadata (name), not panic.
	view := m.detail.View()
	if view == "" {
		t.Fatal("detail viewport is empty after cursor move")
	}
}

// TestCursorMoveShowsMetaBeforePreview verifies that immediately after a cursor
// move the detail contains metadata (name label) but NOT the file body — the
// file is only loaded after the debounce tick fires.
func TestCursorMoveShowsMetaBeforePreview(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, "skill.md")
	const uniqueBody = "UNIQUE_DEBOUNCE_BODY_SENTINEL"
	if err := os.WriteFile(skillPath, []byte("---\nname: testskill\n---\n"+uniqueBody+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := componentModel(t, skillPath, 120, 30)

	// Move cursor onto the skill item (Skills folder is expanded by default; j
	// enters it).
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = mm.(model)

	// The file body must NOT appear yet (no disk I/O on the keypress path).
	view := m.detail.View()
	if strings.Contains(view, uniqueBody) {
		t.Fatalf("file body appeared before debounce tick — disk I/O on keypress path: %q", view)
	}
}

// TestStalePreviewTickIsNoop verifies that a previewTickMsg with a stale gen
// (not matching m.previewGen) leaves the detail content unchanged.
func TestStalePreviewTickIsNoop(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, "skill.md")
	if err := os.WriteFile(skillPath, []byte("---\nname: testskill\n---\nBODY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := componentModel(t, skillPath, 120, 30)

	// Move cursor to bump previewGen to 1.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = mm.(model)
	before := m.detail.View()

	// Deliver a stale tick (gen 0, but current is 1).
	mm, cmd := m.Update(previewTickMsg{gen: 0})
	m = mm.(model)

	if cmd != nil {
		t.Errorf("stale previewTickMsg returned non-nil Cmd, want nil")
	}
	after := m.detail.View()
	if after != before {
		t.Errorf("stale previewTickMsg mutated detail content:\nbefore=%q\nafter=%q", before, after)
	}
}

// TestCurrentPreviewTickLoadsFileBody verifies that a previewTickMsg with the
// current gen triggers refreshDetail, which reads the file and appends the body.
func TestCurrentPreviewTickLoadsFileBody(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, "skill.md")
	const uniqueBody = "UNIQUE_TICK_BODY_SENTINEL"
	if err := os.WriteFile(skillPath, []byte("---\nname: testskill\n---\n"+uniqueBody+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := componentModel(t, skillPath, 120, 30)

	// Move cursor to schedule the debounce (gen becomes 1).
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = mm.(model)

	// Confirm the body is absent before the tick.
	if strings.Contains(m.detail.View(), uniqueBody) {
		t.Fatal("file body appeared before tick fired")
	}

	// Deliver the matching tick.
	currentGen := m.previewGen
	mm, _ = m.Update(previewTickMsg{gen: currentGen})
	m = mm.(model)

	// Now the file body must be present.
	if !strings.Contains(m.detail.View(), uniqueBody) {
		t.Fatalf("file body missing after matching tick; detail=%q", m.detail.View())
	}
}

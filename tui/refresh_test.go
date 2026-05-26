package main

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestRefreshInventorySetsLoadingAndCmd verifies that pressing "r" on the
// Inventory tab sets both loading flags and returns a non-nil cmd.
func TestRefreshInventorySetsLoadingAndCmd(t *testing.T) {
	m := loadedModel(120, 30)
	// loadedModel leaves m.loading == true (counts never injected via inventoryMsg).
	// Clear both flags so the no-op guard doesn't fire.
	m.loading = false
	m.detailLoading = false

	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	m = mm.(model)

	if !m.loading {
		t.Fatal("loading should be true after pressing r on Inventory tab")
	}
	if !m.detailLoading {
		t.Fatal("detailLoading should be true after pressing r on Inventory tab")
	}
	if cmd == nil {
		t.Fatal("cmd should be non-nil after pressing r on Inventory tab")
	}
}

// TestRefreshSectionSetsLoadingAndCmd verifies that pressing "r" on a loaded
// section tab sets that section's loading flag and returns a non-nil cmd.
func TestRefreshSectionSetsLoadingAndCmd(t *testing.T) {
	m := loadedModel(120, 30)
	// Inject drift data so viewDrift's section is populated (st.loading = false).
	m = injectDrift(m, sampleDriftResult())

	// Switch to viewDrift via the "9" key.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	if m.currentView != viewDrift {
		t.Fatalf("currentView = %v, want viewDrift", m.currentView)
	}

	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	m = mm.(model)

	st := m.sections[viewDrift]
	if st == nil {
		t.Fatal("sections[viewDrift] is nil")
	}
	if !st.loading {
		t.Fatal("sections[viewDrift].loading should be true after pressing r")
	}
	if cmd == nil {
		t.Fatal("cmd should be non-nil after pressing r on viewDrift")
	}
}

// TestRefreshNoopWhileSectionLoading verifies that pressing "r" is a no-op
// (returns nil cmd) when the section tab is already loading.
func TestRefreshNoopWhileSectionLoading(t *testing.T) {
	m := loadedModel(120, 30)

	// Switch to viewConflicts via the "2" key.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("currentView = %v, want viewConflicts", m.currentView)
	}

	// Force the section into loading state.
	st := m.sections[viewConflicts]
	if st == nil {
		t.Fatal("sections[viewConflicts] is nil")
	}
	st.loading = true

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	if cmd != nil {
		t.Fatal("cmd should be nil when section is already loading (no-op)")
	}
}

// TestRefreshNoopWhileInventoryLoading verifies that pressing "r" on the
// Inventory tab is a no-op when the counts fetch is already in flight.
func TestRefreshNoopWhileInventoryLoading(t *testing.T) {
	// loadedModel leaves m.loading == true (counts never injected).
	m := loadedModel(120, 30)
	if m.currentView != viewInventory {
		t.Fatalf("currentView = %v, want viewInventory", m.currentView)
	}
	if !m.loading {
		t.Fatal("expected m.loading == true from loadedModel (counts not injected)")
	}

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	if cmd != nil {
		t.Fatal("cmd should be nil when inventory is already loading (no-op)")
	}
}

// TestSectionFetchCmdNilForInventory verifies that sectionFetchCmd returns nil
// for non-section views and non-nil for section views.
func TestSectionFetchCmdNilForInventory(t *testing.T) {
	if got := sectionFetchCmd(viewInventory, "x"); got != nil {
		t.Fatal("sectionFetchCmd(viewInventory) should return nil")
	}
	if got := sectionFetchCmd(viewDrift, "x"); got == nil {
		t.Fatal("sectionFetchCmd(viewDrift) should return non-nil")
	}
}

// TestSectionFetchCmdCoversAllSectionViews pins the invariant that every section
// view (per isSectionView) has a fetch in sectionFetchCmd — a drift between the two
// would strand a refreshed tab in a never-ending spinner.
func TestSectionFetchCmdCoversAllSectionViews(t *testing.T) {
	for v := viewInventory; v < tabCount; v++ {
		if !isSectionView(v) {
			continue
		}
		if sectionFetchCmd(v, "x") == nil {
			t.Errorf("sectionFetchCmd(%v) is nil but isSectionView(%v) is true", v, v)
		}
	}
}

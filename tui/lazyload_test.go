package main

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// Lazy loading: the three non-badge tabs (config/hooks/audit) are NOT fetched at
// startup; they load on first visit. The badge tabs stay eager so their tab-bar
// dot is correct from launch. These tests pin that split + the no-refetch contract.

// ── the lazy split at startup ────────────────────────────────────────────────

func TestLazyTabsStartIdle(t *testing.T) {
	m := loadedModel(120, 30)
	for _, v := range []viewID{viewConfig, viewHooks, viewAudit} {
		st := m.sections[v]
		if st == nil {
			t.Fatalf("section %v should exist", v)
		}
		if st.loading {
			t.Errorf("lazy tab %v must NOT be loading at startup", v)
		}
		if st.loaded {
			t.Errorf("lazy tab %v must NOT be loaded at startup", v)
		}
	}
}

// Guards the badge invariant: making a badge tab lazy would drop its startup dot.
func TestBadgeTabsStartLoading(t *testing.T) {
	m := loadedModel(120, 30)
	badge := []viewID{viewConflicts, viewOrphans, viewSelftest, viewDoctor, viewPermissions, viewDrift}
	for _, v := range badge {
		st := m.sections[v]
		if st == nil || !st.loading {
			t.Errorf("badge tab %v must be eager (loading) at startup", v)
		}
	}
}

// ── first visit triggers the fetch ───────────────────────────────────────────

func TestLazyTabFetchesOnFirstVisit(t *testing.T) {
	m := loadedModel(120, 30)
	// "4" → viewConfig.
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	if m.currentView != viewConfig {
		t.Fatalf("currentView = %v, want viewConfig", m.currentView)
	}
	if cmd == nil {
		t.Fatal("first visit to Config should dispatch a fetch cmd")
	}
	if !m.sections[viewConfig].loading {
		t.Fatal("Config section should be loading after first visit")
	}
}

// ── a loaded lazy tab is not re-fetched on revisit ───────────────────────────

func TestLazyTabNoRefetchOnRevisit(t *testing.T) {
	m := loadedModel(120, 30)
	// First visit dispatches the fetch.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	// Fetch completes.
	mm, _ = m.Update(configMsg{data: sampleConfigResult()})
	m = mm.(model)
	if !m.sections[viewConfig].loaded {
		t.Fatal("Config should be loaded after its msg")
	}
	// Switch away to Inventory, then back to Config.
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("1")})
	m = mm.(model)
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	if cmd != nil {
		t.Fatal("revisit to a loaded Config tab must NOT re-fetch")
	}
}

// ── switching to an eager tab never triggers a lazy fetch ────────────────────

func TestEagerTabNoLazyFetch(t *testing.T) {
	m := loadedModel(120, 30)
	// "2" → viewConflicts (an eager/badge tab).
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("currentView = %v, want viewConflicts", m.currentView)
	}
	if cmd != nil {
		t.Fatal("switching to an eager tab must NOT dispatch a lazy fetch")
	}
}

// ── the bracket cycle key also triggers a lazy fetch ─────────────────────────

// The `]`/`[` cycle keys are a separate handler from the digit jump; this guards
// that landing on a lazy tab via `]` fetches it too.
func TestLazyTabFetchesViaBracketKey(t *testing.T) {
	m := loadedModel(120, 30)
	// Jump to Orphans (index 2, an eager tab) via "3".
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("3")})
	m = mm.(model)
	if m.currentView != viewOrphans {
		t.Fatalf("currentView = %v, want viewOrphans", m.currentView)
	}
	// "]" cycles forward to Config (index 3) — a lazy tab.
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
	m = mm.(model)
	if m.currentView != viewConfig {
		t.Fatalf("currentView = %v, want viewConfig", m.currentView)
	}
	if cmd == nil {
		t.Fatal("cycling onto Config via ] should dispatch a fetch")
	}
	if !m.sections[viewConfig].loading {
		t.Fatal("Config should be loading after ] lands on it")
	}
}

// ── r refresh still re-fetches a loaded lazy tab ─────────────────────────────

// Guards that refreshCurrent does NOT gate on `loaded`: a manual `r` on a loaded
// lazy tab must still re-fetch, otherwise the tab would be permanently stale.
func TestRefreshRefetchesLoadedLazyTab(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	mm, _ = m.Update(configMsg{data: sampleConfigResult()})
	m = mm.(model)
	if m.sections[viewConfig].loading {
		t.Fatal("Config should not be loading after its msg")
	}
	// "r" refreshes the current tab.
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	m = mm.(model)
	if cmd == nil {
		t.Fatal("r on a loaded lazy tab must re-fetch (non-nil cmd)")
	}
	if !m.sections[viewConfig].loading {
		t.Fatal("Config should be loading again after r")
	}
}

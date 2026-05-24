package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestMatchesFilter covers the shared case-insensitive substring matcher.
func TestMatchesFilter(t *testing.T) {
	cases := []struct {
		name, query string
		want        bool
	}{
		{"agent-eval", "eval", true},
		{"Agent-Eval", "EVAL", true}, // case-insensitive
		{"foo", "bar", false},
		{"anything", "", true}, // empty query matches all
	}
	for _, c := range cases {
		if got := matchesFilter(c.name, c.query); got != c.want {
			t.Errorf("matchesFilter(%q, %q) = %v, want %v", c.name, c.query, got, c.want)
		}
	}
}

// TestTreeFilterNarrowsAndClears verifies setFilter limits the visible rows to
// matching items (under their force-shown folders) and that clearing restores
// the full set.
func TestTreeFilterNarrowsAndClears(t *testing.T) {
	tm := newTreeModel(DetailData{Components: []Component{
		{Name: "alpha-skill", Kind: "skill"},
		{Name: "beta-skill", Kind: "skill"},
		{Name: "alpha-agent", Kind: "agent"},
	}})
	full := len(tm.visible)

	tm.setFilter("alpha")
	// Skills(alpha-skill) + Agents(alpha-agent): 2 headers + 2 items = 4 rows.
	if got := len(tm.visible); got != 4 {
		t.Fatalf("filtered visible rows = %d, want 4", got)
	}

	tm.setFilter("")
	if got := len(tm.visible); got != full {
		t.Fatalf("clearing filter: visible rows = %d, want %d (restored)", got, full)
	}
}

// TestSectionFilterNarrows verifies the flat-list filter and that the selection
// follows the filtered set.
func TestSectionFilterNarrows(t *testing.T) {
	sm := newSectionModel([]sectionItem{{title: "alpha"}, {title: "beta"}, {title: "alphabet"}})
	sm.setFilter("alph")
	if got := len(sm.filtered()); got != 2 {
		t.Fatalf("filtered len = %d, want 2 (alpha, alphabet)", got)
	}
	item, ok := sm.selectedItem()
	if !ok || item.title != "alpha" {
		t.Fatalf("selectedItem after filter = %q (ok=%v), want alpha", item.title, ok)
	}
}

// TestSlashFiltersInventoryTree drives the full key flow: / opens the filter,
// typing live-filters the tree, Enter keeps it applied, Esc clears it.
func TestSlashFiltersInventoryTree(t *testing.T) {
	m := initialModel("x")
	m.showSplash = false
	m.currentView = viewInventory
	m.tree = newTreeModel(DetailData{Components: []Component{
		{Name: "alpha-skill", Kind: "skill"},
		{Name: "beta-skill", Kind: "skill"},
	}})

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	m = next.(model)
	if !m.filterMode {
		t.Fatal("/ should enter filter mode")
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("alpha")})
	m = next.(model)
	if m.filterQuery != "alpha" {
		t.Fatalf("filterQuery = %q, want alpha", m.filterQuery)
	}
	if m.tree.filter != "alpha" {
		t.Fatalf("tree.filter = %q, want alpha (filter applied live)", m.tree.filter)
	}
	if got := len(m.tree.visible); got != 2 {
		t.Fatalf("filtered tree visible = %d, want 2 (Skills header + alpha-skill)", got)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(model)
	if m.filterMode {
		t.Fatal("Enter should exit the filter input mode")
	}
	if m.filterQuery != "alpha" {
		t.Fatal("Enter should keep the applied filter")
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(model)
	if m.filterQuery != "" || m.tree.filter != "" {
		t.Fatalf("Esc should clear the filter, got query=%q tree=%q", m.filterQuery, m.tree.filter)
	}
}

// TestTabSwitchClearsFilter verifies switching tabs drops an active filter so a
// stale query never carries onto a different view.
func TestTabSwitchClearsFilter(t *testing.T) {
	m := initialModel("x")
	m.showSplash = false
	m.currentView = viewInventory
	m.tree = newTreeModel(DetailData{Components: []Component{{Name: "alpha-skill", Kind: "skill"}}})
	m.filterQuery = "alpha"
	m.applyFilter()
	if m.tree.filter != "alpha" {
		t.Fatal("setup: tree filter should be applied")
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{']'}})
	m = next.(model)
	if m.filterQuery != "" {
		t.Fatalf("] tab switch should clear the filter, got %q", m.filterQuery)
	}
	if m.tree.filter != "" {
		t.Fatal("] tab switch should clear the tree filter")
	}
}

// TestTreeFilterNoMatch verifies a 0-match filter empties the visible rows (the
// tree pane then shows the "no matches" empty state).
func TestTreeFilterNoMatch(t *testing.T) {
	tm := newTreeModel(DetailData{Components: []Component{{Name: "alpha", Kind: "skill"}}})
	tm.setFilter("zzz")
	if got := len(tm.visible); got != 0 {
		t.Fatalf("0-match tree filter: visible rows = %d, want 0", got)
	}
}

// TestSectionFilterNoMatchShowsMessage verifies a 0-match section filter renders
// the "no matches" message rather than a blank pane (the HIGH review fix).
func TestSectionFilterNoMatchShowsMessage(t *testing.T) {
	m := initialModel("x")
	m.showSplash = false
	m.currentView = viewConflicts
	st := m.sections[viewConflicts]
	st.loading = false
	st.list = newSectionModel([]sectionItem{{title: "alpha"}, {title: "beta"}})
	st.list.setFilter("zzz") // matches nothing

	got := stripANSI(sectionListBody(m))
	if !strings.Contains(got, "no matches") {
		t.Fatalf("0-match section filter should show 'no matches', got %q", got)
	}
}

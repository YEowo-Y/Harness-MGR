package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// sampleComponents returns a small ordered component set for tests.
func sampleComponents() []Component {
	return []Component{
		{Name: "analyst", Kind: "agent", Source: ComponentSource{Tier: "user"}, Path: `C:\a\analyst.md`},
		{Name: "architect", Kind: "agent", Source: ComponentSource{Tier: "user"}, Path: `C:\a\architect.md`},
		{Name: "do", Kind: "command", Source: ComponentSource{Tier: "plugin", Plugin: "claude-mem"}, Path: `C:\c\do.md`},
		{Name: "seo", Kind: "skill", Source: ComponentSource{Tier: "user"}, Path: `C:\s\seo.md`},
	}
}

// loadedModel builds a model with components loaded and panes sized, as the
// live Update loop would after a componentsMsg + WindowSizeMsg.
func loadedModel(w, h int) model {
	m := initialModel("unused")
	mm, _ := m.Update(componentsMsg{comps: sampleComponents()})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	return mm.(model)
}

func TestSortComponentsByKindThenName(t *testing.T) {
	in := []Component{
		{Name: "seo", Kind: "skill"},
		{Name: "architect", Kind: "agent"},
		{Name: "do", Kind: "command"},
		{Name: "analyst", Kind: "agent"},
	}
	sortComponents(in)
	got := make([]string, len(in))
	for i, c := range in {
		got[i] = c.Kind + "/" + c.Name
	}
	want := []string{"agent/analyst", "agent/architect", "command/do", "skill/seo"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestComponentsMsgPopulatesListAndDetail(t *testing.T) {
	m := loadedModel(120, 30)
	if got := len(m.list.Items()); got != 4 {
		t.Fatalf("list items = %d, want 4", got)
	}
	c, ok := m.selectedComponent()
	if !ok || c.Name != "analyst" {
		t.Fatalf("selected = %q ok=%v, want analyst", c.Name, ok)
	}
	if !strings.Contains(m.detail.View(), "analyst") {
		t.Fatalf("detail viewport does not show selected component: %q", m.detail.View())
	}
}

func TestTabTogglesFocusNotSection(t *testing.T) {
	m := loadedModel(120, 30)
	if m.focus != focusList {
		t.Fatalf("initial focus = %v, want focusList", m.focus)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = mm.(model)
	if m.focus != focusDetail {
		t.Fatalf("after Tab focus = %v, want focusDetail", m.focus)
	}
	if m.currentView != viewInventory {
		t.Fatalf("Tab changed section to %v, want it unchanged (viewInventory)", m.currentView)
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = mm.(model)
	if m.focus != focusList {
		t.Fatalf("after Shift+Tab focus = %v, want focusList", m.focus)
	}
}

func TestBracketKeysCycleSections(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("after ] view = %v, want viewConflicts", m.currentView)
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("[")})
	m = mm.(model)
	if m.currentView != viewInventory {
		t.Fatalf("after [ view = %v, want viewInventory", m.currentView)
	}
}

func TestDigitKeysJumpSections(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("3")})
	m = mm.(model)
	if m.currentView != viewOrphans {
		t.Fatalf("after 3 view = %v, want viewOrphans", m.currentView)
	}
}

func TestListNavRefreshesDetailLive(t *testing.T) {
	m := loadedModel(120, 30)
	// focus is the list; "j" / down moves selection to the next component.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	c, ok := m.selectedComponent()
	if !ok || c.Name != "architect" {
		t.Fatalf("after j selected = %q, want architect", c.Name)
	}
	if !strings.Contains(m.detail.View(), "architect") {
		t.Fatalf("detail did not refresh to architect: %q", m.detail.View())
	}
}

func TestNavWhileDetailFocusedScrollsNotSelects(t *testing.T) {
	m := loadedModel(120, 8) // short height so detail content can scroll
	// move focus to the detail pane
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = mm.(model)
	before, _ := m.selectedComponent()
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	after, _ := m.selectedComponent()
	if before.Name != after.Name {
		t.Fatalf("j with detail focused changed selection %q -> %q (should not)", before.Name, after.Name)
	}
}

func TestSplitViewRendersTwoBorderedPanes(t *testing.T) {
	m := loadedModel(120, 30)
	out := m.View()
	// Two rounded top-border corners on the panes' top row proves two boxes.
	top := strings.SplitN(out, "\n", 3)
	if len(top) < 2 {
		t.Fatalf("frame too short: %q", out)
	}
	if n := strings.Count(top[1], "╭"); n != 2 {
		t.Fatalf("expected 2 top-left corners (two panes), got %d in %q", n, top[1])
	}
	if !strings.Contains(out, "section") || !strings.Contains(out, "focus") {
		t.Fatalf("status bar hints missing from frame: %q", out)
	}
}

func TestQuitKeys(t *testing.T) {
	m := loadedModel(120, 30)
	for _, k := range []tea.KeyMsg{
		{Type: tea.KeyRunes, Runes: []rune("q")},
		{Type: tea.KeyCtrlC},
		{Type: tea.KeyEsc},
	} {
		_, cmd := m.Update(k)
		if cmd == nil {
			t.Fatalf("key %v did not return a quit command", k)
		}
	}
}

func TestEmptyComponentsDoesNotPanic(t *testing.T) {
	m := initialModel("unused")
	mm, _ := m.Update(componentsMsg{comps: nil})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = mm.(model)
	_ = m.View() // must not panic; empty-state hints render
	if _, ok := m.selectedComponent(); ok {
		t.Fatalf("selectedComponent ok=true on empty list, want false")
	}
}

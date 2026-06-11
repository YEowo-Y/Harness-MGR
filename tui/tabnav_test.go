package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// Arrow keys cycle tabs as a fallback alongside [ / ].

func TestRightArrowAdvancesTab(t *testing.T) {
	m := loadedModel(120, 30)
	if m.currentView != viewInventory {
		t.Fatalf("precondition: want viewInventory, got %v", m.currentView)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("right arrow: want viewConflicts, got %v", m.currentView)
	}
}

func TestLeftArrowFromFirstWrapsToHealth(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyLeft})
	m = mm.(model)
	if m.currentView != viewHealth {
		t.Fatalf("left arrow from Inventory should wrap to the last tab (Health), got %v", m.currentView)
	}
}

func TestLeftRightAreEquivalentToBracketCycle(t *testing.T) {
	// right then left returns to the start (round trip), matching ] then [.
	m := loadedModel(120, 30)
	start := m.currentView
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyLeft})
	m = mm.(model)
	if m.currentView != start {
		t.Fatalf("right then left should round-trip to %v, got %v", start, m.currentView)
	}
}

// H jumps directly to the Health tab (the 11th tab has no single digit).

func TestHKeyJumpsToHealth(t *testing.T) {
	m := loadedModel(120, 30) // starts on Inventory
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("H")})
	m = mm.(model)
	if m.currentView != viewHealth {
		t.Fatalf("H should jump to viewHealth, got %v", m.currentView)
	}
}

func TestHKeyFromDoctorAlsoJumpsToHealth(t *testing.T) {
	// From an arbitrary middle tab, H still lands on Health (not relative).
	m := loadedModel(120, 30)
	m.currentView = viewDoctor
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("H")})
	m = mm.(model)
	if m.currentView != viewHealth {
		t.Fatalf("H from Doctor should jump to viewHealth, got %v", m.currentView)
	}
}

// The status bar advertises the arrow fallback, and the help overlay lists H.

func TestStatusBarShowsArrowHint(t *testing.T) {
	m := loadedModel(120, 30)
	if out := m.View(); !strings.Contains(out, "1-0/←→") {
		t.Fatalf("status bar should advertise the arrow tab keys (1-0/←→):\n%s", out)
	}
}

func TestHelpOverlayListsHealthKey(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m.showHelp = true
	out := m.View()
	if !strings.Contains(out, "jump to Health") {
		t.Fatalf("help overlay should list the H → Health shortcut:\n%s", out)
	}
}

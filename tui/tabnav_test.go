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

func TestLeftArrowFromFirstWrapsToDispositions(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyLeft})
	m = mm.(model)
	if m.currentView != viewDispositions {
		t.Fatalf("left arrow from Inventory should wrap to the last tab (Dispositions), got %v", m.currentView)
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

// TestTabAcceleratorDigits verifies that the first 10 tabs get digit labels and
// that tabs beyond index 9 do NOT get a digit (they would collide with 1-0).
func TestTabAcceleratorDigits(t *testing.T) {
	cases := []struct {
		v    viewID
		want string
	}{
		{viewInventory, "1"},
		{viewConflicts, "2"},
		{viewOrphans, "3"},
		{viewConfig, "4"},
		{viewHooks, "5"},
		{viewSelftest, "6"},
		{viewDoctor, "7"},
		{viewPermissions, "8"},
		{viewDrift, "9"},
		{viewAudit, "0"},        // 10th tab → digit 0
		{viewHealth, "H"},       // 11th tab → mnemonic
		{viewDispositions, "D"}, // 12th tab → mnemonic
	}
	for _, tc := range cases {
		got := tabAccelerator(tc.v)
		if got != tc.want {
			t.Errorf("tabAccelerator(%v) = %q, want %q", tc.v, got, tc.want)
		}
	}
}

// TestTabAcceleratorMnemonicsDriftGuard is the headline drift-guard: for every
// entry in tabMnemonics, pressing that letter key must actually jump to that tab.
// If handleKey's case label diverges from tabMnemonics, this test goes red.
func TestTabAcceleratorMnemonicsDriftGuard(t *testing.T) {
	for v, letter := range tabMnemonics {
		m := loadedModel(120, 30)
		m.currentView = viewInventory // start elsewhere so the jump is observable
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(letter)})
		got := mm.(model).currentView
		if got != v {
			t.Errorf("tabMnemonics[%v]=%q but pressing %q lands on %v, not %v",
				v, letter, letter, got, v)
		}
	}
}

// TestTabBarShowsMnemonics verifies that the rendered tab bar shows "H Health"
// and "D Dispositions" instead of the colliding "1 Health"/"2 Dispositions".
func TestTabBarShowsMnemonics(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(160, 30) // wide enough to show all tabs
	out := tabBarView(m)
	if strings.Contains(out, "1 Health") {
		t.Errorf("tab bar must not show '1 Health' (collides with Inventory):\n%s", out)
	}
	if strings.Contains(out, "2 Dispositions") {
		t.Errorf("tab bar must not show '2 Dispositions' (collides with Conflicts):\n%s", out)
	}
	if !strings.Contains(out, "H Health") {
		t.Errorf("tab bar should show 'H Health':\n%s", out)
	}
	if !strings.Contains(out, "D Dispositions") {
		t.Errorf("tab bar should show 'D Dispositions':\n%s", out)
	}
}

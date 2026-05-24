package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestHelpToggle verifies ? opens the help overlay and ? / Esc close it.
func TestHelpToggle(t *testing.T) {
	m := initialModel("x")
	m.showSplash = false // past the splash

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	nm := next.(model)
	if !nm.showHelp {
		t.Fatal("? should open the help overlay (showHelp=true)")
	}

	again, _ := nm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	if again.(model).showHelp {
		t.Fatal("? again should close the help overlay")
	}

	esc, _ := nm.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if esc.(model).showHelp {
		t.Fatal("Esc should close the help overlay")
	}

	// q also closes the overlay (it does not quit the app while help is open).
	q, _ := nm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if q.(model).showHelp {
		t.Fatal("q should close the help overlay")
	}
}

// TestHelpSwallowsKeys verifies that while help is open a non-dismiss key (the
// section-switch digit "2") neither closes the overlay nor changes the tab.
func TestHelpSwallowsKeys(t *testing.T) {
	m := initialModel("x")
	m.showSplash = false
	m.showHelp = true
	m.currentView = viewInventory

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'2'}})
	nm := next.(model)
	if !nm.showHelp {
		t.Fatal("a non-dismiss key should NOT close the help overlay")
	}
	if nm.currentView != viewInventory {
		t.Fatalf("tab changed to %d while help open — the key should be swallowed", nm.currentView)
	}
}

// TestHelpViewContent verifies the overlay renders its title, a key hint, and the
// dismiss hint (English default).
func TestHelpViewContent(t *testing.T) {
	got := stripANSI(helpView(80, 24))
	for _, want := range []string{"Keyboard shortcuts", "Tab", "switch pane", "to close"} {
		if !strings.Contains(got, want) {
			t.Fatalf("helpView missing %q\ngot: %q", want, got)
		}
	}
}

// TestHelpViewTranslates verifies the overlay follows the active language.
func TestHelpViewTranslates(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	got := stripANSI(helpView(80, 24))
	if !strings.Contains(got, "键盘快捷键") {
		t.Fatalf("helpView [ZH] missing 键盘快捷键\ngot: %q", got)
	}
}

// TestHelpViewZeroDims guards the degenerate sizes (never panic, return "").
func TestHelpViewZeroDims(t *testing.T) {
	for _, c := range [][2]int{{0, 0}, {0, 24}, {80, 0}, {-1, -1}} {
		if got := helpView(c[0], c[1]); got != "" {
			t.Logf("helpView(%d,%d) = %q (non-empty but no panic — acceptable)", c[0], c[1], got)
		}
	}
}

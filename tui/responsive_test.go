package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── Fix 3: the chrome (tab bar) fits the terminal width ───────────────────────

// TestViewFitsTerminalWidth is the headline regression guard: at every realistic
// terminal width, NO line of the rendered frame may exceed m.width. Before the
// tab-bar windowing fix the 152-col strip padded every line to 152, overflowing
// any terminal narrower than that (60/80/100/120 all broke).
func TestViewFitsTerminalWidth(t *testing.T) {
	for _, w := range []int{60, 80, 100, 120} {
		m := loadedModel(w, 24)
		for i, line := range strings.Split(m.View(), "\n") {
			if lw := lipgloss.Width(line); lw > w {
				t.Errorf("width=%d: line %d is %d cols, exceeds width:\n%q", w, i, lw, line)
			}
		}
	}
}

// TestTabBarFitsTerminalWidth pins the tab bar itself to never exceed m.width and,
// when narrower than the full strip, to fill EXACTLY m.width (so JoinVertical does
// not pad the rest of the frame past the terminal).
func TestTabBarFitsTerminalWidth(t *testing.T) {
	for _, w := range []int{60, 80, 100, 120, 152, 200} {
		m := loadedModel(w, 24)
		if got := lipgloss.Width(tabBarView(m)); got != w {
			t.Errorf("width=%d: tabBarView width = %d, want exactly %d", w, got, w)
		}
	}
}

// TestActiveTabAlwaysVisible verifies that on a narrow terminal the active tab's
// label stays fully visible in the scrolled window — including the last tab
// (Snapshots, reached via "S"), which forces the window to scroll to the far right.
func TestActiveTabAlwaysVisible(t *testing.T) {
	cases := []struct {
		key   rune
		view  viewID
		label string
	}{
		{'1', viewInventory, "Inventory"},
		{'7', viewDoctor, "Doctor"},
		{'H', viewHealth, "Health"},
		{'S', viewSnapshots, "Snapshots"},
	}
	for _, c := range cases {
		m := loadedModel(60, 24)
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{c.key}})
		m = mm.(model)
		if m.currentView != c.view {
			t.Fatalf("key %q: currentView = %v, want %v", c.key, m.currentView, c.view)
		}
		out := tabBarView(m)
		if !strings.Contains(out, c.label) {
			t.Errorf("key %q (width 60): active label %q not visible in tab bar:\n%s", c.key, c.label, out)
		}
	}
}

// TestTabBarScrollMarkers verifies the overflow markers appear on the correct
// side: with the FIRST tab active only a right marker shows (tabs hidden right);
// with the LAST tab active only a left marker shows. Markers go through glyph()
// so the assertion uses the same Unicode/ASCII resolution the renderer does.
func TestTabBarScrollMarkers(t *testing.T) {
	left := glyph("‹", "<")
	right := glyph("›", ">")

	// First tab (Inventory) active: window starts at lo=0 → no left marker, but
	// tabs remain hidden to the right → right marker.
	m := loadedModel(60, 24)
	out := tabBarView(m)
	if strings.Contains(out, left) {
		t.Errorf("first tab active: unexpected left marker %q:\n%s", left, out)
	}
	if !strings.Contains(out, right) {
		t.Errorf("first tab active: expected right marker %q:\n%s", right, out)
	}

	// Last tab (Snapshots) active: window ends at hi=len → no right marker, but
	// tabs remain hidden to the left → left marker.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("S")})
	m = mm.(model)
	out = tabBarView(m)
	if !strings.Contains(out, left) {
		t.Errorf("last tab active: expected left marker %q:\n%s", left, out)
	}
	if strings.Contains(out, right) {
		t.Errorf("last tab active: unexpected right marker %q:\n%s", right, out)
	}
}

// TestWideTerminalTabBarUnchanged pins that a terminal at least as wide as the full
// strip is NOT regressed: every tab label is present and NO scroll markers are
// shown (the full strip fits, so the no-scroll path runs).
func TestWideTerminalTabBarUnchanged(t *testing.T) {
	m := loadedModel(200, 24)
	out := tabBarView(m)
	for i := range tabLabels {
		label := tabLabel(viewID(i))
		if !strings.Contains(out, label) {
			t.Errorf("wide terminal: tab label %q missing:\n%s", label, out)
		}
	}
	if strings.Contains(out, glyph("‹", "<")) || strings.Contains(out, glyph("›", ">")) {
		t.Errorf("wide terminal: scroll markers must not appear when the full strip fits:\n%s", out)
	}
}

// ── Fix 2: T shows a target-switch toast ──────────────────────────────────────

// TestTKeyShowsSwitchToast verifies pressing T sets the transient status-bar toast
// to the NEW target's name (codex on the first flip, claude on the second).
func TestTKeyShowsSwitchToast(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)
	if m.writeStatus != tr("status.switchedToCodex") {
		t.Fatalf("after first T: writeStatus = %q, want %q", m.writeStatus, tr("status.switchedToCodex"))
	}
	if !m.writeOK {
		t.Error("after first T: writeOK should be true (informational toast)")
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)
	if m.writeStatus != tr("status.switchedToClaude") {
		t.Fatalf("after second T: writeStatus = %q, want %q", m.writeStatus, tr("status.switchedToClaude"))
	}
}

// ── Fix 1: the short codex read-only toast fits a narrow status bar ────────────

// TestCodexReadOnlyToastFitsNarrowBar verifies the shortened write.codexReadOnly
// string renders inside the status bar at a 40-col width without being wrapped off
// — it stays on one line and its text is present.
func TestCodexReadOnlyToastFitsNarrowBar(t *testing.T) {
	m := loadedModel(40, 24)
	m.writeStatus = tr("write.codexReadOnly")
	m.writeOK = false
	out := statusBarView(m)
	if h := lipgloss.Height(out); h != 1 {
		t.Errorf("codex read-only toast is %d lines at width 40, want 1:\n%s", h, out)
	}
	if !strings.Contains(out, tr("write.codexReadOnly")) {
		t.Errorf("codex read-only toast text missing at width 40:\n%s", out)
	}
}

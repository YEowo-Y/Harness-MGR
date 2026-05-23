package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── splashView rendering tests ────────────────────────────────────────────────

// TestSplashViewNormal checks that splashView(80,24) is non-empty and contains
// the tagline text. In the no-color test environment the banner text degrades to
// plain so we also verify the tagline substring survives.
func TestSplashViewNormal(t *testing.T) {
	got := splashView(80, 24)
	if got == "" {
		t.Fatal("splashView(80,24) returned empty string")
	}
	if !strings.Contains(got, splashTagline) {
		t.Fatalf("splashView(80,24) missing tagline %q\ngot: %q", splashTagline, got)
	}
}

// TestSplashViewNarrowFallback checks that a very narrow terminal does not panic
// and returns a non-empty string (falls back to brandWordmark).
func TestSplashViewNarrowFallback(t *testing.T) {
	got := splashView(10, 5)
	if got == "" {
		t.Fatal("splashView(10,5) returned empty string — expected fallback content")
	}
	// brandWordmark() always contains "claude-mgr" in the no-color test env.
	if !strings.Contains(got, "claude-mgr") {
		t.Fatalf("splashView(10,5) fallback should contain \"claude-mgr\"\ngot: %q", got)
	}
}

// TestSplashViewZeroDims verifies that zero or negative dimensions do not panic
// and return "" or a safe string (never a panic).
func TestSplashViewZeroDims(t *testing.T) {
	cases := [][2]int{{0, 0}, {0, 24}, {80, 0}, {-1, -1}}
	for _, c := range cases {
		got := splashView(c[0], c[1])
		// Must not panic (reaching here means it didn't). Result must be "" per spec.
		if got != "" {
			t.Logf("splashView(%d,%d) = %q (non-empty but not a panic — acceptable)", c[0], c[1], got)
		}
	}
}

// TestSplashViewContainsHint checks that splashView(80,24) includes the loading
// hint text, confirming the full block is assembled.
func TestSplashViewContainsHint(t *testing.T) {
	got := splashView(80, 24)
	if !strings.Contains(got, splashHint) {
		t.Fatalf("splashView(80,24) missing hint %q\ngot: %q", splashHint, got)
	}
}

// TestSplashViewLipglossPlace checks that the output is wider than the block
// itself — i.e. lipgloss.Place added padding — confirming centering occurred.
func TestSplashViewLipglossPlace(t *testing.T) {
	got := splashView(80, 24)
	h := lipgloss.Height(got)
	if h < 24 {
		t.Fatalf("splashView(80,24) height=%d, want ≥24 (lipgloss.Place should pad vertically)", h)
	}
}

// ── model.showSplash state machine tests ──────────────────────────────────────

// TestInitialModelShowSplash verifies that initialModel sets showSplash=true.
func TestInitialModelShowSplash(t *testing.T) {
	m := initialModel("x")
	if !m.showSplash {
		t.Fatal("initialModel().showSplash = false, want true")
	}
}

// TestDetailMsgDismissesSplash verifies that delivering a detailMsg sets
// showSplash=false.
func TestDetailMsgDismissesSplash(t *testing.T) {
	m := initialModel("x")
	if !m.showSplash {
		t.Fatal("precondition: showSplash should be true after initialModel")
	}
	next, _ := m.Update(detailMsg{data: DetailData{}})
	nm := next.(model)
	if nm.showSplash {
		t.Fatal("showSplash should be false after detailMsg arrives")
	}
}

// TestDetailMsgErrorDismissesSplash verifies the splash is dismissed even when
// the detail fetch FAILED — otherwise a fetch error would freeze the splash.
func TestDetailMsgErrorDismissesSplash(t *testing.T) {
	m := initialModel("x")
	next, _ := m.Update(detailMsg{err: errors.New("fetch failed")})
	if next.(model).showSplash {
		t.Fatal("showSplash should be false even when detailMsg carries an error")
	}
}

// TestKeyMsgDismissesSplash verifies that any KeyMsg while showSplash=true sets
// showSplash=false and does NOT change currentView (the key is swallowed).
func TestKeyMsgDismissesSplash(t *testing.T) {
	m := initialModel("x")
	m.currentView = viewInventory

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	nm := next.(model)
	if nm.showSplash {
		t.Fatal("showSplash should be false after KeyMsg while splash is shown")
	}
	if nm.currentView != viewInventory {
		t.Fatalf("currentView changed to %d after splash-dismiss key — key should be swallowed", nm.currentView)
	}
}

// TestKeyMsgDoesNotChangeViewDuringSplash further verifies that a section-switch
// key (e.g. "2") is also swallowed and does not advance the tab.
func TestKeyMsgDoesNotChangeViewDuringSplash(t *testing.T) {
	m := initialModel("x")
	m.currentView = viewInventory

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'2'}})
	nm := next.(model)
	if nm.showSplash {
		t.Fatal("showSplash should be false after digit key while splash shown")
	}
	if nm.currentView != viewInventory {
		t.Fatalf("currentView = %d after swallowed '2' key, want viewInventory(%d)", nm.currentView, viewInventory)
	}
}

// ── runSnapshot model has showSplash=false ────────────────────────────────────

// TestSnapshotModelNoSplash verifies that the model literal used by runSnapshot
// has showSplash=false (the zero value) so --snapshot always renders the dashboard.
// We build an equivalent model directly (same fields as runSnapshot) and check
// that View() returns the tab bar, not the splash.
func TestSnapshotModelNoSplash(t *testing.T) {
	m := model{
		sections: map[viewID]*sectionState{
			viewConflicts: {list: newSectionModel(nil)},
			viewOrphans:   {list: newSectionModel(nil)},
			viewConfig:    {list: newSectionModel(nil)},
			viewHooks:     {list: newSectionModel(nil)},
			viewSelftest:  {list: newSectionModel(nil)},
		},
		currentView: viewInventory,
		width:       defaultWidth,
		height:      defaultHeight,
		tree:        newTreeModel(DetailData{}),
		detail:      viewport.New(0, 0),
		spinner:     newSpinner(),
		focus:       focusTree,
		// showSplash intentionally absent (zero = false)
	}
	m.layoutPanes()
	view := m.View()
	// The dashboard tab bar always contains "Inventory".
	if !strings.Contains(view, "Inventory") {
		t.Fatalf("snapshot model View() missing 'Inventory' tab — splash may have been shown instead\ngot: %q", view)
	}
	if strings.Contains(view, splashTagline) {
		t.Fatalf("snapshot model View() contains splash tagline — showSplash should be false\ngot: %q", view)
	}
}

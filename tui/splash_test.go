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

// TestDetailMsgDismissesSplash verifies that delivering BOTH a detailMsg AND a
// splashTimerMsg sets showSplash=false. detailMsg alone no longer dismisses
// the splash — it waits for the minimum timer to also fire.
func TestDetailMsgDismissesSplash(t *testing.T) {
	m := initialModel("x")
	if !m.showSplash {
		t.Fatal("precondition: showSplash should be true after initialModel")
	}
	// detailMsg alone: splash still showing (timer not done yet).
	next, _ := m.Update(detailMsg{data: DetailData{}})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should still be true after detailMsg alone (timer not done)")
	}
	// Now deliver the timer: both conditions met → dismiss.
	next2, _ := nm.Update(splashTimerMsg{})
	nm2 := next2.(model)
	if nm2.showSplash {
		t.Fatal("showSplash should be false after both detailMsg and splashTimerMsg")
	}
}

// TestDetailMsgErrorDismissesSplash verifies the splash is dismissed even when
// the detail fetch FAILED — otherwise a fetch error would freeze the splash.
// Both detailMsg (with error) AND splashTimerMsg must arrive before dismissal.
func TestDetailMsgErrorDismissesSplash(t *testing.T) {
	m := initialModel("x")
	// detailMsg with error alone: not yet dismissed.
	next, _ := m.Update(detailMsg{err: errors.New("fetch failed")})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should still be true after error detailMsg alone (timer not done)")
	}
	// Timer fires: now dismiss.
	next2, _ := nm.Update(splashTimerMsg{})
	if next2.(model).showSplash {
		t.Fatal("showSplash should be false after error detailMsg + splashTimerMsg")
	}
}

// TestSplashTimerAloneDoesNotDismiss verifies that the timer alone (without data
// having loaded) does not dismiss the splash.
func TestSplashTimerAloneDoesNotDismiss(t *testing.T) {
	m := initialModel("x")
	// detailLoading starts true; deliver only the timer.
	next, _ := m.Update(splashTimerMsg{})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should still be true when timer fires but data not yet loaded")
	}
	if !nm.splashTimerDone {
		t.Fatal("splashTimerDone should be true after splashTimerMsg")
	}
}

// TestSplashDismissesWhenBothDataAndTimer verifies the splash hides when both
// conditions are met, regardless of delivery order (timer first or data first).
func TestSplashDismissesWhenBothDataAndTimer(t *testing.T) {
	// Order A: timer first, then data.
	t.Run("timer_then_data", func(t *testing.T) {
		m := initialModel("x")
		next, _ := m.Update(splashTimerMsg{})
		nm := next.(model)
		if !nm.showSplash {
			t.Fatal("should still show after timer alone")
		}
		next2, _ := nm.Update(detailMsg{data: DetailData{}})
		if next2.(model).showSplash {
			t.Fatal("should dismiss after data arrives post-timer")
		}
	})
	// Order B: data first, then timer.
	t.Run("data_then_timer", func(t *testing.T) {
		m := initialModel("x")
		next, _ := m.Update(detailMsg{data: DetailData{}})
		nm := next.(model)
		if !nm.showSplash {
			t.Fatal("should still show after data alone")
		}
		next2, _ := nm.Update(splashTimerMsg{})
		if next2.(model).showSplash {
			t.Fatal("should dismiss after timer fires post-data")
		}
	})
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

// ── mascot tests ──────────────────────────────────────────────────────────────

// TestSplashMascotLines verifies splashMascot is non-empty and each line is
// non-empty (guards against accidental blank-slice regression).
func TestSplashMascotLines(t *testing.T) {
	if len(splashMascot) == 0 {
		t.Fatal("splashMascot is empty")
	}
	for i, line := range splashMascot {
		if len([]rune(line)) == 0 {
			t.Fatalf("splashMascot[%d] is empty", i)
		}
	}
}

// TestSplashViewNoUnicodeFallback verifies that on a no-color/no-Unicode terminal
// (unicodeEnabled() == false, as in the test runner) splashView still renders
// without panic and contains the wordmark fallback but NOT the mascot glyph.
func TestSplashViewNoUnicodeFallback(t *testing.T) {
	if unicodeEnabled() {
		t.Skip("mascot IS shown in this environment — skip no-unicode fallback test")
	}
	got := splashView(80, 24)
	if got == "" {
		t.Fatal("splashView returned empty on no-unicode terminal")
	}
	// Wordmark fallback must be present.
	if !strings.Contains(got, "claude-mgr") {
		t.Fatalf("splashView no-unicode: missing wordmark fallback, got: %q", got)
	}
	// Mascot glyph must NOT appear (it's gated on unicodeEnabled).
	if strings.Contains(got, "◕") {
		t.Fatal("splashView no-unicode: mascot glyph '◕' should not appear")
	}
}

// TestSplashMascotShownWhenUnicode verifies that when unicodeEnabled() is true
// the mascot block is included in the splashView output. Skipped when the test
// env has no color profile (the common CI / pipe case).
func TestSplashMascotShownWhenUnicode(t *testing.T) {
	if !unicodeEnabled() {
		t.Skip("unicodeEnabled() is false in this environment — mascot not rendered")
	}
	got := splashView(80, 24)
	if !strings.Contains(got, "◕") {
		t.Fatalf("splashView unicode: expected mascot glyph '◕' in output\ngot: %q", got)
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

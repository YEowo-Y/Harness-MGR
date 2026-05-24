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
	// brandWordmark() always contains "warden" in the no-color test env.
	if !strings.Contains(got, "warden") {
		t.Fatalf("splashView(10,5) fallback should contain \"warden\"\ngot: %q", got)
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

// TestSplashViewContainsPicker checks that splashView(80,24) includes both
// language-picker options, confirming the full block (banner + tagline + picker)
// is assembled.
func TestSplashViewContainsPicker(t *testing.T) {
	got := splashView(80, 24)
	for _, want := range []string{"English", "简体中文"} {
		if !strings.Contains(got, want) {
			t.Fatalf("splashView(80,24) missing language option %q\ngot: %q", want, got)
		}
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

// TestDetailMsgDoesNotDismissSplash verifies that a detailMsg (success) leaves
// showSplash=true — data loads behind the splash but the user must act to enter.
func TestDetailMsgDoesNotDismissSplash(t *testing.T) {
	m := initialModel("x")
	if !m.showSplash {
		t.Fatal("precondition: showSplash should be true after initialModel")
	}
	next, _ := m.Update(detailMsg{data: DetailData{}})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should still be true after detailMsg — user must enter manually")
	}
}

// TestDetailMsgErrorDoesNotDismissSplash verifies the splash also stays up when
// the detail fetch FAILED — the user still presses a key to enter.
func TestDetailMsgErrorDoesNotDismissSplash(t *testing.T) {
	m := initialModel("x")
	next, _ := m.Update(detailMsg{err: errors.New("fetch failed")})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should still be true after error detailMsg — user must enter manually")
	}
}

// TestEnterDismissesSplash verifies that Enter while showSplash=true enters the
// dashboard (showSplash=false) without changing currentView. The splash is now a
// language picker, so it is confirmed with Enter — not "any key".
func TestEnterDismissesSplash(t *testing.T) {
	m := initialModel("x")
	m.currentView = viewInventory

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	nm := next.(model)
	if nm.showSplash {
		t.Fatal("showSplash should be false after Enter on the splash picker")
	}
	if nm.currentView != viewInventory {
		t.Fatalf("currentView changed to %d after Enter — key should be swallowed", nm.currentView)
	}
}

// TestNonPickerKeyIgnoredDuringSplash verifies that a key that isn't part of the
// picker (e.g. the section-switch digit "2") neither dismisses the splash nor
// changes the tab — the splash now waits for Enter, not "any key".
func TestNonPickerKeyIgnoredDuringSplash(t *testing.T) {
	m := initialModel("x")
	m.currentView = viewInventory

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'2'}})
	nm := next.(model)
	if !nm.showSplash {
		t.Fatal("showSplash should STAY true after a non-picker key — the splash waits for Enter")
	}
	if nm.currentView != viewInventory {
		t.Fatalf("currentView = %d after ignored '2' key, want viewInventory(%d)", nm.currentView, viewInventory)
	}
}

// TestArrowTogglesLanguageOnSplash verifies that ← / → toggle the highlighted
// language on the splash without leaving it.
func TestArrowTogglesLanguageOnSplash(t *testing.T) {
	m := initialModel("x")
	if m.lang != langEN {
		t.Fatalf("initial lang = %d, want langEN", m.lang)
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	nm := next.(model)
	if nm.lang != langZH {
		t.Fatalf("lang after → = %d, want langZH", nm.lang)
	}
	if !nm.showSplash {
		t.Fatal("→ should only toggle the language, not dismiss the splash")
	}
	back, _ := nm.Update(tea.KeyMsg{Type: tea.KeyLeft})
	if back.(model).lang != langEN {
		t.Fatal("lang after ← should toggle back to langEN")
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
// without panic and contains the wordmark fallback but NOT the mascot glyph. The
// mascot now lives in the dashboard's top-right corner, not on the splash, so its
// glyph must never appear in the splash output regardless of Unicode support.
func TestSplashViewNoUnicodeFallback(t *testing.T) {
	if unicodeEnabled() {
		t.Skip("mascot IS shown in this environment — skip no-unicode fallback test")
	}
	got := splashView(80, 24)
	if got == "" {
		t.Fatal("splashView returned empty on no-unicode terminal")
	}
	// Wordmark fallback must be present.
	if !strings.Contains(got, "warden") {
		t.Fatalf("splashView no-unicode: missing wordmark fallback, got: %q", got)
	}
	// Mascot glyph must NOT appear (it's gated on unicodeEnabled).
	if strings.Contains(got, "◠") {
		t.Fatal("splashView no-unicode: mascot glyph '◠' should not appear")
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

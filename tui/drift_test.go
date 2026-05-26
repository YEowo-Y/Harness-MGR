package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

var sampleDriftJSON = []byte(`{
	"command": "drift",
	"version": 1,
	"result": {
		"status": "drifted",
		"changes": [
			{"path": "skills/foo.md", "change": "added"},
			{"path": "agents/bar.md", "change": "modified"}
		],
		"summary": {"added": 1, "removed": 0, "modified": 1}
	},
	"diagnostics": [
		{"severity": "warn", "code": "drift-detected", "message": "config surface has drifted from baseline"}
	]
}`)

// sampleDriftResult returns a representative drifted DriftResult for model tests.
func sampleDriftResult() DriftResult {
	return DriftResult{
		Status: "drifted",
		Changes: []DriftChange{
			{Path: "skills/foo.md", Change: "added"},
			{Path: "agents/bar.md", Change: "modified"},
		},
		Summary: DriftSummary{Added: 1, Removed: 0, Modified: 1},
		Diagnostics: []Diagnostic{
			{Severity: "warn", Code: "drift-detected", Message: "config surface has drifted from baseline"},
		},
	}
}

// injectDrift delivers a driftMsg to a model and returns the updated model.
func injectDrift(m model, r DriftResult) model {
	mm, _ := m.Update(driftMsg{data: r})
	return mm.(model)
}

// ── parseDrift tests ──────────────────────────────────────────────────────────

func TestParseDriftHappyPath(t *testing.T) {
	r, err := parseDrift(sampleDriftJSON)
	if err != nil {
		t.Fatalf("parseDrift error: %v", err)
	}
	if r.Status != "drifted" {
		t.Fatalf("Status = %q, want %q", r.Status, "drifted")
	}
	if len(r.Changes) != 2 {
		t.Fatalf("Changes count = %d, want 2", len(r.Changes))
	}
	if r.Changes[0].Path != "skills/foo.md" {
		t.Fatalf("Changes[0].Path = %q, want %q", r.Changes[0].Path, "skills/foo.md")
	}
	if r.Changes[0].Change != "added" {
		t.Fatalf("Changes[0].Change = %q, want %q", r.Changes[0].Change, "added")
	}
	if r.Summary.Added != 1 {
		t.Fatalf("Summary.Added = %d, want 1", r.Summary.Added)
	}
	if r.Summary.Modified != 1 {
		t.Fatalf("Summary.Modified = %d, want 1", r.Summary.Modified)
	}
	if len(r.Diagnostics) != 1 {
		t.Fatalf("Diagnostics count = %d, want 1", len(r.Diagnostics))
	}
	if r.Diagnostics[0].Severity != "warn" {
		t.Fatalf("Diagnostics[0].Severity = %q, want warn", r.Diagnostics[0].Severity)
	}
}

func TestParseDriftEmpty(t *testing.T) {
	data := []byte(`{"command":"drift","version":1,"result":{"status":"clean","changes":[],"summary":{}},"diagnostics":[]}`)
	r, err := parseDrift(data)
	if err != nil {
		t.Fatalf("parseDrift error: %v", err)
	}
	if r.Status != "clean" {
		t.Fatalf("Status = %q, want %q", r.Status, "clean")
	}
	if len(r.Changes) != 0 {
		t.Fatalf("Changes count = %d, want 0", len(r.Changes))
	}
}

func TestParseDriftInvalidJSON(t *testing.T) {
	_, err := parseDrift([]byte(`not json`))
	if err == nil {
		t.Fatal("parseDrift should return error on invalid JSON")
	}
}

// ── driftItems tests ──────────────────────────────────────────────────────────

func TestDriftItemsCount(t *testing.T) {
	items := driftItems(sampleDriftResult())
	if len(items) != 2 {
		t.Fatalf("driftItems count = %d, want 2", len(items))
	}
}

func TestDriftItemsAddedGreen(t *testing.T) {
	items := driftItems(sampleDriftResult())
	// "added" → colorPlugin (green)
	if items[0].color != colorPlugin {
		t.Fatalf("added item color = %v, want colorPlugin", items[0].color)
	}
}

func TestDriftItemsModifiedOrange(t *testing.T) {
	items := driftItems(sampleDriftResult())
	// "modified" → colorOrange
	if items[1].color != colorOrange {
		t.Fatalf("modified item color = %v, want colorOrange", items[1].color)
	}
}

func TestDriftItemsRemovedRed(t *testing.T) {
	r := DriftResult{
		Changes: []DriftChange{{Path: "skills/gone.md", Change: "removed"}},
	}
	items := driftItems(r)
	if items[0].color != colorRed {
		t.Fatalf("removed item color = %v, want colorRed", items[0].color)
	}
}

func TestDriftItemsTitleContainsPath(t *testing.T) {
	items := driftItems(sampleDriftResult())
	if !strings.Contains(items[0].title, "skills/foo.md") {
		t.Fatalf("item title missing path: %q", items[0].title)
	}
	if !strings.Contains(items[1].title, "agents/bar.md") {
		t.Fatalf("item title missing path: %q", items[1].title)
	}
}

func TestDriftItemsEmpty(t *testing.T) {
	items := driftItems(DriftResult{})
	if len(items) != 0 {
		t.Fatalf("driftItems(empty) count = %d, want 0", len(items))
	}
}

// ── driftDetail tests ─────────────────────────────────────────────────────────

func TestDriftDetailContainsPathAndKind(t *testing.T) {
	c := DriftChange{Path: "skills/foo.md", Change: "added"}
	body := driftDetail(c, 80)
	if !strings.Contains(body, "skills/foo.md") {
		t.Fatalf("driftDetail missing path:\n%s", body)
	}
	if !strings.Contains(body, "added") {
		t.Fatalf("driftDetail missing change kind:\n%s", body)
	}
}

// ── Model wiring: driftMsg delivery ──────────────────────────────────────────

func TestDriftMsgDriftedSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDrift(m, sampleDriftResult())

	st := m.sections[viewDrift]
	if st == nil {
		t.Fatal("sections[viewDrift] is nil after driftMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after driftMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	if !strings.Contains(st.summaryText(), "added") {
		t.Fatalf("drifted summary = %q, want to contain 'added'", st.summaryText())
	}
}

func TestDriftMsgCleanSummary(t *testing.T) {
	m := loadedModel(120, 30)
	r := DriftResult{Status: "clean", Changes: nil}
	m = injectDrift(m, r)

	st := m.sections[viewDrift]
	if len(st.list.items) != 0 {
		t.Fatalf("clean drift: list items = %d, want 0", len(st.list.items))
	}
	if !strings.Contains(st.summaryText(), "matches baseline") {
		t.Fatalf("clean summary = %q, want to contain 'matches baseline'", st.summaryText())
	}
}

func TestDriftMsgNoBaselineSummary(t *testing.T) {
	m := loadedModel(120, 30)
	r := DriftResult{Status: "no-baseline"}
	m = injectDrift(m, r)

	st := m.sections[viewDrift]
	if !strings.Contains(st.summaryText(), "no baseline") {
		t.Fatalf("no-baseline summary = %q, want to contain 'no baseline'", st.summaryText())
	}
}

func TestDriftErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(driftMsg{err: errFmt("boom")})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("drift error state not rendered:\n%s", out)
	}
}

// ── View-level: switching to tab 9 ───────────────────────────────────────────

func TestSwitchToDriftView(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDrift(m, sampleDriftResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	if m.currentView != viewDrift {
		t.Fatalf("currentView = %v, want viewDrift", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "skills/foo.md") {
		t.Fatalf("Drift frame missing changed path:\n%s", out)
	}
}

func TestDriftTabReachableByCycle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDrift(m, sampleDriftResult())
	for i := 0; i < int(viewDrift); i++ {
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
		m = mm.(model)
	}
	if m.currentView != viewDrift {
		t.Fatalf("after %d ']' presses currentView = %v, want viewDrift", int(viewDrift), m.currentView)
	}
}

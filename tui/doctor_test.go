package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

// sampleDoctorReport models a representative passive run: an ok check (ran, 0
// findings), a warn check (#23 permissions-overbroad with 2 matching warn
// diagnostics), an error check, an info check (findings>0 but no error/warn
// diagnostic), and a skipped active check (ran=false). It exercises every branch
// of resolveDoctorSeverity / doctorColor.
func sampleDoctorReport() DoctorReport {
	return DoctorReport{
		ProbeLevel: "passive",
		Checks: []DoctorCheck{
			{ID: 1, Code: "mcp-auth-stale", ProbeLevel: "passive", Ran: true, Findings: 0},
			{ID: 23, Code: "permissions-overbroad", ProbeLevel: "passive", Ran: true, Findings: 2},
			{ID: 6, Code: "settings-json-valid", ProbeLevel: "passive", Ran: true, Findings: 1},
			{ID: 12, Code: "orphan-files", ProbeLevel: "passive", Ran: true, Findings: 1},
			{ID: 4, Code: "hook-node-syntax", ProbeLevel: "active", Ran: false, Findings: 0},
		},
		Diagnostics: []Diagnostic{
			{Severity: "warn", Code: "permissions-overbroad", Message: "permissions.allow contains a wildcard rule: \"Edit(*)\"", Fix: "replace \"Edit(*)\" with specific rules"},
			{Severity: "warn", Code: "permissions-overbroad", Message: "permissions.allow contains a wildcard rule: \"Write(*)\""},
			{Severity: "error", Code: "settings-json-valid", Message: "settings.json duplicate key \"model\" (line 3, column 3)", Fix: "remove the duplicate key"},
			{Severity: "info", Code: "orphan-files", Message: "soft orphan: notes.txt — loose file in skills/"},
		},
	}
}

// injectDoctor delivers a doctorMsg to a model and returns the updated model.
func injectDoctor(m model, r DoctorReport) model {
	mm, _ := m.Update(doctorMsg{data: r})
	return mm.(model)
}

// ── parseDoctor tests ─────────────────────────────────────────────────────────

var sampleDoctorJSON = []byte(`{
	"command": "doctor",
	"version": 1,
	"result": {
		"probeLevel": "passive",
		"checks": [
			{"id": 1, "code": "mcp-auth-stale", "probeLevel": "passive", "ran": true, "findings": 0},
			{"id": 23, "code": "permissions-overbroad", "probeLevel": "passive", "ran": true, "findings": 1},
			{"id": 4, "code": "hook-node-syntax", "probeLevel": "active", "ran": false, "findings": 0}
		]
	},
	"diagnostics": [
		{"severity": "warn", "code": "permissions-overbroad", "message": "wildcard rule", "fix": "use specific rules", "phase": "doctor"}
	]
}`)

func TestParseDoctorHappyPath(t *testing.T) {
	r, err := parseDoctor(sampleDoctorJSON)
	if err != nil {
		t.Fatalf("parseDoctor error: %v", err)
	}
	if r.ProbeLevel != "passive" {
		t.Fatalf("ProbeLevel = %q, want %q", r.ProbeLevel, "passive")
	}
	if len(r.Checks) != 3 {
		t.Fatalf("Checks count = %d, want 3", len(r.Checks))
	}
	if r.Checks[0].ID != 1 || r.Checks[0].Code != "mcp-auth-stale" {
		t.Fatalf("Checks[0] = %+v, want id 1 / mcp-auth-stale", r.Checks[0])
	}
	if !r.Checks[0].Ran {
		t.Fatal("Checks[0].Ran should be true")
	}
	if r.Checks[2].Ran {
		t.Fatal("Checks[2] (active) Ran should be false in passive run")
	}
	if r.Checks[1].Findings != 1 {
		t.Fatalf("Checks[1].Findings = %d, want 1", r.Checks[1].Findings)
	}
	if len(r.Diagnostics) != 1 {
		t.Fatalf("Diagnostics count = %d, want 1", len(r.Diagnostics))
	}
	if r.Diagnostics[0].Severity != "warn" {
		t.Fatalf("Diagnostics[0].Severity = %q, want warn", r.Diagnostics[0].Severity)
	}
	if r.Diagnostics[0].Code != "permissions-overbroad" {
		t.Fatalf("Diagnostics[0].Code = %q, want permissions-overbroad", r.Diagnostics[0].Code)
	}
	if r.Diagnostics[0].Fix != "use specific rules" {
		t.Fatalf("Diagnostics[0].Fix = %q, want %q", r.Diagnostics[0].Fix, "use specific rules")
	}
}

func TestParseDoctorEmpty(t *testing.T) {
	data := []byte(`{"command":"doctor","version":1,"result":{"probeLevel":"passive","checks":[]},"diagnostics":[]}`)
	r, err := parseDoctor(data)
	if err != nil {
		t.Fatalf("parseDoctor error: %v", err)
	}
	if len(r.Checks) != 0 {
		t.Fatalf("expected 0 checks, got %d", len(r.Checks))
	}
	if len(r.Diagnostics) != 0 {
		t.Fatalf("expected 0 diagnostics, got %d", len(r.Diagnostics))
	}
}

func TestParseDoctorInvalidJSON(t *testing.T) {
	_, err := parseDoctor([]byte(`not json`))
	if err == nil {
		t.Fatal("parseDoctor should return error on invalid JSON")
	}
}

// ── doctorItems coloring tests ─────────────────────────────────────────────────

func TestDoctorItemsCount(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	if len(items) != 5 {
		t.Fatalf("doctorItems count = %d, want 5", len(items))
	}
}

func TestDoctorItemsPreservesCheckOrder(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// Engine order: #1, #23, #6, #12, #4 — preserved (no re-sort).
	wantCodes := []string{"mcp-auth-stale", "permissions-overbroad", "settings-json-valid", "orphan-files", "hook-node-syntax"}
	for i, code := range wantCodes {
		if !strings.Contains(items[i].title, code) {
			t.Fatalf("items[%d].title = %q, want to contain %q", i, items[i].title, code)
		}
	}
}

func TestDoctorItemsOkGreen(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #1 mcp-auth-stale: ran, 0 findings → colorPlugin (green).
	if items[0].color != colorPlugin {
		t.Fatalf("ok check color = %v, want colorPlugin", items[0].color)
	}
}

func TestDoctorItemsWarnOrange(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #23 permissions-overbroad: matching warn diagnostics → colorOrange.
	if items[1].color != colorOrange {
		t.Fatalf("warn check color = %v, want colorOrange", items[1].color)
	}
}

func TestDoctorItemsErrorRed(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #6 settings-json-valid: matching error diagnostic → colorRed.
	if items[2].color != colorRed {
		t.Fatalf("error check color = %v, want colorRed", items[2].color)
	}
}

func TestDoctorItemsInfoColor(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #12 orphan-files: findings>0 with only an info diagnostic → colorMcp (cyan),
	// the doctor "info" severity color, decoupled from the brand accent teal.
	if items[3].color != colorMcp {
		t.Fatalf("info check color = %v, want colorMcp", items[3].color)
	}
}

func TestDoctorItemsSkippedGray(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #4 hook-node-syntax: active check not run → labelGray.
	if items[4].color != labelGray {
		t.Fatalf("skipped check color = %v, want labelGray", items[4].color)
	}
}

func TestDoctorItemsTitleHasIDAndCode(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	if !strings.Contains(items[0].title, "#1") {
		t.Fatalf("title missing id: %q", items[0].title)
	}
	if !strings.Contains(items[0].title, "mcp-auth-stale") {
		t.Fatalf("title missing code: %q", items[0].title)
	}
}

func TestDoctorItemsTitleShowsFindingsCount(t *testing.T) {
	items := doctorItems(sampleDoctorReport())
	// #23 has 2 findings → title carries " · 2".
	if !strings.Contains(items[1].title, "· 2") {
		t.Fatalf("warn title missing findings count: %q", items[1].title)
	}
	// #1 has 0 findings → no " · " findings suffix.
	if strings.Contains(items[0].title, "·") {
		t.Fatalf("ok title should not carry a findings suffix: %q", items[0].title)
	}
}

func TestDoctorItemsEmpty(t *testing.T) {
	items := doctorItems(DoctorReport{})
	if len(items) != 0 {
		t.Fatalf("doctorItems(empty) count = %d, want 0", len(items))
	}
}

// TestDoctorItemsNilReport covers a fully zero DoctorReport (what a failed/empty
// decode leaves), which must yield zero items without panicking.
func TestDoctorItemsNilReport(t *testing.T) {
	var r DoctorReport
	items := doctorItems(r)
	if len(items) != 0 {
		t.Fatalf("doctorItems(nil) count = %d, want 0", len(items))
	}
}

// ── doctorDetail tests ─────────────────────────────────────────────────────────

func TestDoctorDetailOkSaysPassed(t *testing.T) {
	report := sampleDoctorReport()
	items := doctorItems(report)
	// #1 ok check: detail should report no findings.
	body := items[0].detail(80)
	if !strings.Contains(body, "no findings") {
		t.Fatalf("ok detail missing 'no findings':\n%s", body)
	}
	if !strings.Contains(body, "passive") {
		t.Fatalf("ok detail missing probe level:\n%s", body)
	}
}

func TestDoctorDetailWarnListsDiagnostic(t *testing.T) {
	report := sampleDoctorReport()
	items := doctorItems(report)
	// #23 warn check: detail should list the diagnostic message + fix.
	body := items[1].detail(120)
	if !strings.Contains(body, "Edit(*)") {
		t.Fatalf("warn detail missing diagnostic message:\n%s", body)
	}
	if !strings.Contains(body, "specific rules") {
		t.Fatalf("warn detail missing fix:\n%s", body)
	}
	if !strings.Contains(body, "warn") {
		t.Fatalf("warn detail missing severity:\n%s", body)
	}
}

func TestDoctorDetailSkippedSaysSkipped(t *testing.T) {
	report := sampleDoctorReport()
	items := doctorItems(report)
	// #4 active skipped check: detail should call out the skip.
	body := items[4].detail(80)
	if !strings.Contains(strings.ToLower(body), "skip") {
		t.Fatalf("skipped detail missing 'skip':\n%s", body)
	}
}

// ── Model-level: doctorMsg delivery ───────────────────────────────────────────

func TestDoctorMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())

	st := m.sections[viewDoctor]
	if st == nil {
		t.Fatal("sections[viewDoctor] is nil after doctorMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after doctorMsg")
	}
	if len(st.list.items) != 5 {
		t.Fatalf("list items = %d, want 5", len(st.list.items))
	}
	// Summary: 5 checks · 4 findings (2 + 1 + 1 across #23/#6/#12).
	if !strings.Contains(st.summaryText(), "5 checks") {
		t.Fatalf("summary = %q, want to contain %q", st.summaryText(), "5 checks")
	}
	if !strings.Contains(st.summaryText(), "4 findings") {
		t.Fatalf("summary = %q, want to contain %q", st.summaryText(), "4 findings")
	}
}

func TestDoctorErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(doctorMsg{err: errFmt("doctor boom")})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("doctor error state not rendered:\n%s", out)
	}
}

// ── View-level: switching to tab 7 ────────────────────────────────────────────

func TestSwitchToDoctorViewContainsCheckCode(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	if m.currentView != viewDoctor {
		t.Fatalf("currentView = %v, want viewDoctor", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "permissions-overbroad") {
		t.Fatalf("Doctor frame missing check code %q:\n%s", "permissions-overbroad", out)
	}
}

func TestSwitchToDoctorViewContainsSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "findings") {
		t.Fatalf("Doctor frame missing summary with %q:\n%s", "findings", out)
	}
}

// TestDoctorTabReachableByCycle confirms the "]" cycle reaches the Doctor tab
// (it is the last tab, so six "]" presses from Inventory land on it).
func TestDoctorTabReachableByCycle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())
	for i := 0; i < int(viewDoctor); i++ {
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
		m = mm.(model)
	}
	if m.currentView != viewDoctor {
		t.Fatalf("after %d ']' presses currentView = %v, want viewDoctor", int(viewDoctor), m.currentView)
	}
}

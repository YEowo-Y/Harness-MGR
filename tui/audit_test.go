package main

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data ───────────────────────────────────────────────────────────────

var sampleAuditJSON = []byte(`{
	"command": "audit",
	"version": 1,
	"result": {
		"entries": [
			{"timestamp": "2026-05-02T10:00:00Z", "action": "apply", "target": "settings.json"},
			{"timestamp": "2026-05-01T09:00:00Z", "action": "rollback"}
		],
		"summary": {"total": 2, "returned": 2, "skippedMalformed": 0, "oldest": "2026-05-01T09:00:00Z", "newest": "2026-05-02T10:00:00Z"}
	},
	"diagnostics": []
}`)

// injectAudit delivers an auditMsg to a model and returns the updated model.
func injectAudit(m model, r AuditResult) model {
	mm, _ := m.Update(auditMsg{data: r})
	return mm.(model)
}

// ── parseAudit tests ──────────────────────────────────────────────────────────

func TestParseAuditHappyPath(t *testing.T) {
	r, err := parseAudit(sampleAuditJSON)
	if err != nil {
		t.Fatalf("parseAudit error: %v", err)
	}
	if len(r.Entries) != 2 {
		t.Fatalf("Entries count = %d, want 2", len(r.Entries))
	}
	if r.Summary.Returned != 2 {
		t.Fatalf("Summary.Returned = %d, want 2", r.Summary.Returned)
	}
	if auditEntryString(r.Entries[0], "action") != "apply" {
		t.Fatalf("entries[0] action = %q, want %q", auditEntryString(r.Entries[0], "action"), "apply")
	}
}

func TestParseAuditEmpty(t *testing.T) {
	data := []byte(`{"result":{"entries":[],"summary":{}},"diagnostics":[]}`)
	r, err := parseAudit(data)
	if err != nil {
		t.Fatalf("parseAudit error: %v", err)
	}
	if len(r.Entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(r.Entries))
	}
}

func TestParseAuditInvalidJSON(t *testing.T) {
	_, err := parseAudit([]byte(`not json`))
	if err == nil {
		t.Fatal("parseAudit should return error on invalid JSON")
	}
}

// ── auditItems tests ──────────────────────────────────────────────────────────

func makeAuditResult() AuditResult {
	r, _ := parseAudit(sampleAuditJSON)
	return r
}

func TestAuditItemsCount(t *testing.T) {
	items := auditItems(makeAuditResult())
	if len(items) != 2 {
		t.Fatalf("auditItems count = %d, want 2", len(items))
	}
}

func TestAuditItemsTitleContainsTimestampAndAction(t *testing.T) {
	items := auditItems(makeAuditResult())
	if !strings.Contains(items[0].title, "2026-05-02T10:00:00Z") {
		t.Fatalf("items[0].title missing timestamp: %q", items[0].title)
	}
	if !strings.Contains(items[0].title, "apply") {
		t.Fatalf("items[0].title missing action: %q", items[0].title)
	}
	if !strings.Contains(items[1].title, "rollback") {
		t.Fatalf("items[1].title missing action: %q", items[1].title)
	}
}

func TestAuditItemsNoTimestampNoActionFallback(t *testing.T) {
	// Entry with neither a timestamp nor any auditTitleFields key → "entry 1".
	e := AuditEntry{"note": json.RawMessage(`"hi"`)}
	r := AuditResult{Entries: []AuditEntry{e}}
	items := auditItems(r)
	if len(items) != 1 {
		t.Fatalf("auditItems count = %d, want 1", len(items))
	}
	if !strings.Contains(items[0].title, "entry 1") {
		t.Fatalf("fallback title = %q, want to contain 'entry 1'", items[0].title)
	}
}

func TestAuditItemsColor(t *testing.T) {
	items := auditItems(makeAuditResult())
	if items[0].color != accent {
		t.Fatalf("audit item color = %v, want accent", items[0].color)
	}
}

func TestAuditItemsEmpty(t *testing.T) {
	items := auditItems(AuditResult{})
	if len(items) != 0 {
		t.Fatalf("auditItems(empty) count = %d, want 0", len(items))
	}
}

// ── auditDetail tests ─────────────────────────────────────────────────────────

func TestAuditDetailContainsFields(t *testing.T) {
	r := makeAuditResult()
	items := auditItems(r)
	body := items[0].detail(120)
	if !strings.Contains(body, "action") {
		t.Fatalf("auditDetail missing 'action' key:\n%s", body)
	}
	if !strings.Contains(body, "apply") {
		t.Fatalf("auditDetail missing 'apply' value:\n%s", body)
	}
	if !strings.Contains(body, "target") {
		t.Fatalf("auditDetail missing 'target' key:\n%s", body)
	}
	if !strings.Contains(body, "settings.json") {
		t.Fatalf("auditDetail missing 'settings.json' value:\n%s", body)
	}
}

// ── Model wiring: auditMsg delivery ──────────────────────────────────────────

func TestAuditMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectAudit(m, makeAuditResult())

	st := m.sections[viewAudit]
	if st == nil {
		t.Fatal("sections[viewAudit] is nil after auditMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after auditMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	if !strings.Contains(st.summaryText(), "2 entries") {
		t.Fatalf("summary = %q, want to contain '2 entries'", st.summaryText())
	}
}

func TestAuditMsgSkippedMalformedSummary(t *testing.T) {
	m := loadedModel(120, 30)
	r := AuditResult{
		Entries: []AuditEntry{},
		Summary: AuditSummary{Total: 3, Returned: 2, SkippedMalformed: 1},
	}
	m = injectAudit(m, r)

	st := m.sections[viewAudit]
	if !strings.Contains(st.summaryText(), "malformed") {
		t.Fatalf("skipped-malformed summary = %q, want to contain 'malformed'", st.summaryText())
	}
}

func TestAuditMsgEmptyEntriesSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectAudit(m, AuditResult{})

	st := m.sections[viewAudit]
	if len(st.list.items) != 0 {
		t.Fatalf("empty audit: list items = %d, want 0", len(st.list.items))
	}
	if !strings.Contains(st.summaryText(), "0 entries") {
		t.Fatalf("empty summary = %q, want to contain '0 entries'", st.summaryText())
	}
}

func TestAuditErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(auditMsg{err: errFmt("boom")})
	m = mm.(model)
	// "0" key maps to viewAudit (the 10th tab).
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("0")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("audit error state not rendered:\n%s", out)
	}
}

// ── View-level: switching to tab 10 via "0" ───────────────────────────────────

func TestSwitchToAuditView(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectAudit(m, makeAuditResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("0")})
	m = mm.(model)
	if m.currentView != viewAudit {
		t.Fatalf("currentView = %v, want viewAudit", m.currentView)
	}
}

func TestDigitZeroMapsToAudit(t *testing.T) {
	v, ok := digitToView("0")
	if !ok {
		t.Fatal("digitToView('0') ok=false, want true")
	}
	if v != viewAudit {
		t.Fatalf("digitToView('0') = %v, want viewAudit", v)
	}

	v, ok = digitToView("9")
	if !ok {
		t.Fatal("digitToView('9') ok=false, want true")
	}
	if v != viewDrift {
		t.Fatalf("digitToView('9') = %v, want viewDrift", v)
	}
}

// TestAuditEntryStringNonStringValues pins the null-handling fix: a JSON null
// (and other non-string scalars) must fall through to its raw text, NOT be
// silently dropped to "" by json.Unmarshal-into-string (which succeeds for
// null). Absent keys still return "".
func TestAuditEntryStringNonStringValues(t *testing.T) {
	e := AuditEntry{
		"s":    json.RawMessage(`"hi"`),
		"n":    json.RawMessage(`42`),
		"b":    json.RawMessage(`true`),
		"null": json.RawMessage(`null`),
	}
	if got := auditEntryString(e, "s"); got != "hi" {
		t.Errorf("string value: got %q, want %q", got, "hi")
	}
	if got := auditEntryString(e, "n"); got != "42" {
		t.Errorf("number value: got %q, want %q", got, "42")
	}
	if got := auditEntryString(e, "b"); got != "true" {
		t.Errorf("bool value: got %q, want %q", got, "true")
	}
	if got := auditEntryString(e, "null"); got != "null" {
		t.Errorf("null value: got %q, want %q (must not be dropped to empty)", got, "null")
	}
	if got := auditEntryString(e, "absent"); got != "" {
		t.Errorf("absent key: got %q, want empty", got)
	}
}

package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

// samplePermissionsResult models a representative `permissions --audit` output:
// 2 allow rules (one overbroad, one normal), 1 ask rule, 1 deny rule, and 2
// diagnostics for the overbroad allow rule.
func samplePermissionsResult() PermissionsResult {
	return PermissionsResult{
		Allow: []string{"Edit(*)", "Bash(git status)"},
		Ask:   []string{"WebSearch"},
		Deny:  []string{"Bash(rm -rf)"},
		Overbroad: []string{"Edit(*)"},
		Diagnostics: []Diagnostic{
			{
				Severity: "warn",
				Code:     "permissions-overbroad",
				Message:  `permissions.allow contains a wildcard rule: "Edit(*)"`,
				Fix:      `replace "Edit(*)" with specific file patterns`,
			},
		},
	}
}

// injectPermissions delivers a permissionsMsg to a model and returns the
// updated model.
func injectPermissions(m model, r PermissionsResult) model {
	mm, _ := m.Update(permissionsMsg{data: r})
	return mm.(model)
}

// ── parsePermissions tests ────────────────────────────────────────────────────

var samplePermissionsJSON = []byte(`{
	"command": "permissions",
	"version": 1,
	"result": {
		"allow": ["Edit(*)", "Bash(git status)"],
		"ask":   ["WebSearch"],
		"deny":  ["Bash(rm -rf)"],
		"overbroad": ["Edit(*)"]
	},
	"diagnostics": [
		{
			"severity": "warn",
			"code": "permissions-overbroad",
			"message": "permissions.allow contains a wildcard rule: \"Edit(*)\"",
			"fix": "replace \"Edit(*)\" with specific file patterns"
		}
	]
}`)

func TestParsePermissionsHappyPath(t *testing.T) {
	r, err := parsePermissions(samplePermissionsJSON)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(r.Allow) != 2 {
		t.Errorf("want 2 allow rules, got %d", len(r.Allow))
	}
	if r.Allow[0] != "Edit(*)" {
		t.Errorf("want Allow[0]=%q, got %q", "Edit(*)", r.Allow[0])
	}
	if len(r.Ask) != 1 || r.Ask[0] != "WebSearch" {
		t.Errorf("want Ask=[WebSearch], got %v", r.Ask)
	}
	if len(r.Deny) != 1 || r.Deny[0] != "Bash(rm -rf)" {
		t.Errorf("want Deny=[Bash(rm -rf)], got %v", r.Deny)
	}
	if len(r.Overbroad) != 1 || r.Overbroad[0] != "Edit(*)" {
		t.Errorf("want Overbroad=[Edit(*)], got %v", r.Overbroad)
	}
	if len(r.Diagnostics) != 1 {
		t.Fatalf("want 1 diagnostic, got %d", len(r.Diagnostics))
	}
	d := r.Diagnostics[0]
	if d.Severity != "warn" {
		t.Errorf("want severity=warn, got %q", d.Severity)
	}
	if d.Fix == "" {
		t.Error("want non-empty Fix field")
	}
}

func TestParsePermissionsEmpty(t *testing.T) {
	r, err := parsePermissions([]byte(`{"result":{},"diagnostics":[]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(r.Allow) != 0 || len(r.Ask) != 0 || len(r.Deny) != 0 {
		t.Error("want empty slices for empty result")
	}
}

func TestParsePermissionsInvalidJSON(t *testing.T) {
	_, err := parsePermissions([]byte(`{bad json`))
	if err == nil {
		t.Error("want error for invalid JSON, got nil")
	}
}

// ── permissionsItems color matrix ─────────────────────────────────────────────

func TestPermissionsItemsOverbroadIsRed(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	// First item = overbroad allow "Edit(*)"
	if items[0].color != colorRed {
		t.Errorf("overbroad allow: want colorRed, got %v", items[0].color)
	}
}

func TestPermissionsItemsNormalAllowIsGreen(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	// Second item = normal allow "Bash(git status)"
	if items[1].color != colorPlugin {
		t.Errorf("normal allow: want colorPlugin (green), got %v", items[1].color)
	}
}

func TestPermissionsItemsAskIsOrange(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	// Third item = ask "WebSearch"
	if items[2].color != colorOrange {
		t.Errorf("ask: want colorOrange, got %v", items[2].color)
	}
}

func TestPermissionsItemsDenyIsGray(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	// Fourth item = deny "Bash(rm -rf)"
	if items[3].color != labelGray {
		t.Errorf("deny: want labelGray, got %v", items[3].color)
	}
}

// ── permissionsItems title format ────────────────────────────────────────────

func TestPermissionsItemsTitleContainsCategory(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	if !strings.Contains(items[0].title, "allow") {
		t.Errorf("overbroad allow title should contain 'allow', got %q", items[0].title)
	}
	if !strings.Contains(items[2].title, "ask") {
		t.Errorf("ask title should contain 'ask', got %q", items[2].title)
	}
	if !strings.Contains(items[3].title, "deny") {
		t.Errorf("deny title should contain 'deny', got %q", items[3].title)
	}
}

func TestPermissionsItemsTitleContainsRule(t *testing.T) {
	items := permissionsItems(samplePermissionsResult())
	if !strings.Contains(items[0].title, "Edit(*)") {
		t.Errorf("title should contain rule, got %q", items[0].title)
	}
	if !strings.Contains(items[3].title, "Bash(rm -rf)") {
		t.Errorf("deny title should contain rule, got %q", items[3].title)
	}
}

func TestPermissionsItemsCount(t *testing.T) {
	r := samplePermissionsResult()
	items := permissionsItems(r)
	want := len(r.Allow) + len(r.Ask) + len(r.Deny)
	if len(items) != want {
		t.Errorf("want %d items, got %d", want, len(items))
	}
}

func TestPermissionsItemsEmpty(t *testing.T) {
	items := permissionsItems(PermissionsResult{})
	if len(items) != 0 {
		t.Errorf("want 0 items for empty result, got %d", len(items))
	}
}

// ── permissionsDetail prefix-substring regression ─────────────────────────────

// TestPermissionsDetailPrefixSubstringDisambiguated proves that a rule which is
// a bare substring of a longer rule does NOT pull in the longer rule's
// diagnostic. The real case: "Edit(*)" is a substring of "NotebookEdit(*)", so
// without quoted matching the Edit(*) detail would falsely show the
// NotebookEdit(*) fix text.
func TestPermissionsDetailPrefixSubstringDisambiguated(t *testing.T) {
	diags := []Diagnostic{
		{
			Severity: "warn",
			Code:     "permissions-overbroad",
			Message:  `permissions.allow contains a wildcard rule: "Edit(*)"`,
			Fix:      "replace Edit with specific paths",
		},
		{
			Severity: "warn",
			Code:     "permissions-overbroad",
			Message:  `permissions.allow contains a wildcard rule: "NotebookEdit(*)"`,
			Fix:      "replace NotebookEdit with specific paths",
		},
	}

	// Edit(*) detail must contain its own fix and NOT the NotebookEdit fix.
	editDetail := permissionsDetail("Edit(*)", permCategoryAllowOverbroad, diags, 80)
	if !strings.Contains(editDetail, "replace Edit with specific paths") {
		t.Errorf("Edit(*) detail missing its own fix:\n%s", editDetail)
	}
	if strings.Contains(editDetail, "replace NotebookEdit") {
		t.Errorf("Edit(*) detail falsely contains NotebookEdit fix (prefix false-match):\n%s", editDetail)
	}

	// NotebookEdit(*) detail must contain its own fix and NOT the Edit fix.
	nbDetail := permissionsDetail("NotebookEdit(*)", permCategoryAllowOverbroad, diags, 80)
	if !strings.Contains(nbDetail, "replace NotebookEdit with specific paths") {
		t.Errorf("NotebookEdit(*) detail missing its own fix:\n%s", nbDetail)
	}
	if strings.Contains(nbDetail, "replace Edit with specific paths") && !strings.Contains(nbDetail, "replace NotebookEdit") {
		t.Errorf("NotebookEdit(*) detail falsely contains Edit-only fix:\n%s", nbDetail)
	}
}

// ── permissionsDetail tests ───────────────────────────────────────────────────

func TestPermissionsDetailOverbroadSaysYes(t *testing.T) {
	diags := samplePermissionsResult().Diagnostics
	got := permissionsDetail("Edit(*)", permCategoryAllowOverbroad, diags, 80)
	if !strings.Contains(got, "yes") {
		t.Errorf("overbroad detail should say 'yes', got:\n%s", got)
	}
}

func TestPermissionsDetailNormalAllowSaysNo(t *testing.T) {
	got := permissionsDetail("Bash(git status)", permCategoryAllow, nil, 80)
	if !strings.Contains(got, "no") {
		t.Errorf("normal allow detail should say 'no' for overbroad, got:\n%s", got)
	}
}

func TestPermissionsDetailListsMatchingDiagnostic(t *testing.T) {
	diags := samplePermissionsResult().Diagnostics
	got := permissionsDetail("Edit(*)", permCategoryAllowOverbroad, diags, 80)
	if !strings.Contains(got, "wildcard") {
		t.Errorf("detail should contain diagnostic message text, got:\n%s", got)
	}
}

func TestPermissionsDetailFixShownWhenPresent(t *testing.T) {
	diags := samplePermissionsResult().Diagnostics
	got := permissionsDetail("Edit(*)", permCategoryAllowOverbroad, diags, 80)
	if !strings.Contains(got, "specific file patterns") {
		t.Errorf("detail should show Fix text, got:\n%s", got)
	}
}

func TestPermissionsDetailNoDiagnosticWhenNoMatch(t *testing.T) {
	got := permissionsDetail("Bash(git status)", permCategoryAllow, nil, 80)
	// No "Why" section when there are no matching diagnostics.
	if strings.Contains(got, "Why") {
		t.Errorf("detail should not show Why section with no matching diags, got:\n%s", got)
	}
}

// ── Model wiring tests ────────────────────────────────────────────────────────

func TestPermissionsMsgSetsListAndSummary(t *testing.T) {
	m := initialModel("src/cli.mjs")
	r := samplePermissionsResult()
	m = injectPermissions(m, r)

	st := m.sections[viewPermissions]
	if st == nil {
		t.Fatal("sections[viewPermissions] is nil after permissionsMsg")
	}
	if st.loading {
		t.Error("loading should be false after permissionsMsg")
	}
	// 2 allow + 1 ask + 1 deny = 4 items
	if len(st.list.items) != 4 {
		t.Errorf("want 4 items, got %d", len(st.list.items))
	}
	summary := st.summaryText()
	if !strings.Contains(summary, "allow") {
		t.Errorf("summary should contain 'allow', got %q", summary)
	}
	if !strings.Contains(summary, "overbroad") {
		t.Errorf("summary should contain 'overbroad', got %q", summary)
	}
}

func TestPermissionsErrorState(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(permissionsMsg{err: errFmt("fetch failed")})
	m = mm.(model)
	st := m.sections[viewPermissions]
	if st == nil {
		t.Fatal("sections[viewPermissions] nil")
	}
	if st.err == nil {
		t.Error("want err set after error permissionsMsg")
	}
}

func TestSwitchToPermissionsViewContainsRule(t *testing.T) {
	m := loadedModel(120, 30)
	r := samplePermissionsResult()
	m = injectPermissions(m, r)

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("8")})
	m = mm.(model)
	if m.currentView != viewPermissions {
		t.Fatalf("currentView = %v, want viewPermissions", m.currentView)
	}
	rendered := m.View()
	if !strings.Contains(rendered, "Permissions") {
		t.Errorf("view should contain 'Permissions' tab label:\n%s", rendered)
	}
}

func TestPermissionsTabReachableByCycle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectPermissions(m, samplePermissionsResult())
	// Cycle forward from Inventory through all tabs until we reach Permissions.
	for i := 0; i < int(viewPermissions); i++ {
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
		m = mm.(model)
	}
	if m.currentView != viewPermissions {
		t.Errorf("] cycling: want viewPermissions, got %v", m.currentView)
	}
}

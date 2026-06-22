package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// These JSON fixtures are REAL `enable|disable --type plugin <key> --format json`
// dry-run envelopes captured from the engine (see the before→after diff shape),
// trimmed to the fields the TUI decodes.

const disableDryRunJSON = `{"result":{"alreadyInState":false,"desired":false,"diff":{"after":"\"ecc@everything-claude-code\": false","before":"\"ecc@everything-claude-code\": true","line":152},"dryRun":true,"kind":"plugin","name":"ecc@everything-claude-code","ok":true,"status":"dry-run","target":"C:\\Users\\x\\.claude\\settings.json"},"diagnostics":[{"code":"plugin-toggle-dry-run","severity":"info","message":"would set plugin enabled=false"}],"version":1}`

const enableAlreadyJSON = `{"result":{"alreadyInState":true,"desired":true,"diff":null,"dryRun":true,"kind":"plugin","name":"ecc@everything-claude-code","ok":true,"status":"already","target":"C:\\Users\\x\\.claude\\settings.json"},"diagnostics":[{"code":"plugin-toggle-dry-run","severity":"info","message":"already enabled"}],"version":1}`

const enableInsertJSON = `{"result":{"alreadyInState":false,"desired":true,"diff":{"after":"\"agent-sdk-dev@official\": true","before":"","line":152},"dryRun":true,"kind":"plugin","name":"agent-sdk-dev@official","ok":true,"status":"dry-run","target":"C:\\Users\\x\\.claude\\settings.json"},"diagnostics":[],"version":1}`

const refusedJSON = `{"result":{"alreadyInState":false,"desired":false,"diff":null,"dryRun":false,"kind":"plugin","name":"ecc@everything-claude-code","ok":false,"status":"refused","target":"C:\\Users\\x\\.claude\\settings.json"},"diagnostics":[{"code":"plugin-toggle-no-map","severity":"error","message":"has no enabledPlugins object"}],"version":1}`

// ── parseConfigEdit ────────────────────────────────────────────────────────

func TestParseConfigEditDisableDiff(t *testing.T) {
	r, diags, err := parseConfigEdit([]byte(disableDryRunJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.Ok || !r.DryRun {
		t.Fatalf("Ok/DryRun = %v/%v, want true/true", r.Ok, r.DryRun)
	}
	if r.AlreadyInState {
		t.Fatal("AlreadyInState should be false for a real flip")
	}
	if r.Diff == nil {
		t.Fatal("Diff should be non-nil for a flip")
	}
	if r.Diff.Before != `"ecc@everything-claude-code": true` || r.Diff.After != `"ecc@everything-claude-code": false` {
		t.Fatalf("diff before/after = %q/%q", r.Diff.Before, r.Diff.After)
	}
	if r.Diff.Line != 152 {
		t.Fatalf("diff line = %d, want 152", r.Diff.Line)
	}
	if len(diags) != 1 || diags[0].Code != "plugin-toggle-dry-run" {
		t.Fatalf("diagnostics = %+v", diags)
	}
}

func TestParseConfigEditEnableAlready(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(enableAlreadyJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.AlreadyInState {
		t.Fatal("AlreadyInState should be true (enable probe ⇒ already enabled)")
	}
	if r.Diff != nil {
		t.Fatal("Diff should be nil for an already-in-state no-op")
	}
}

func TestParseConfigEditEnableInsert(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(enableInsertJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if r.Diff == nil || r.Diff.Before != "" {
		t.Fatalf("insert diff before should be empty, got %+v", r.Diff)
	}
	if r.Diff.After != `"agent-sdk-dev@official": true` {
		t.Fatalf("insert diff after = %q", r.Diff.After)
	}
}

func TestParseConfigEditMalformed(t *testing.T) {
	if _, _, err := parseConfigEdit([]byte("not json")); err == nil {
		t.Fatal("parseConfigEdit should error on malformed JSON")
	}
}

// ── diagnostic helpers ─────────────────────────────────────────────────────

func TestPluginToggleOverride(t *testing.T) {
	with := []Diagnostic{{Code: "plugin-toggle-overridden-by-local", Severity: "warn"}}
	if !pluginToggleOverride(with) {
		t.Fatal("override should be true when the local-precedence diag is present")
	}
	without := []Diagnostic{{Code: "plugin-toggle-dry-run", Severity: "info"}}
	if pluginToggleOverride(without) {
		t.Fatal("override should be false without the diag")
	}
}

func TestFirstErrorMessageAndRefusalError(t *testing.T) {
	diags := []Diagnostic{
		{Severity: "info", Message: "ignore me"},
		{Severity: "error", Message: "has no enabledPlugins object"},
	}
	if got := firstErrorMessage(diags); got != "has no enabledPlugins object" {
		t.Fatalf("firstErrorMessage = %q", got)
	}
	if got := firstErrorMessage(nil); got != "" {
		t.Fatalf("firstErrorMessage(nil) = %q, want empty", got)
	}
	if err := refusalError(diags); err == nil || !strings.Contains(err.Error(), "enabledPlugins") {
		t.Fatalf("refusalError = %v", err)
	}
	if err := refusalError(nil); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("refusalError(nil) = %v, want generic fallback", err)
	}
}

// ── buildPluginToggleAction ────────────────────────────────────────────────

func TestBuildPluginToggleActionEnable(t *testing.T) {
	a := buildPluginToggleAction(pluginToggleInfo{key: "ecc@market", desired: true})
	if a.id != "plugin-toggle" {
		t.Fatalf("id = %q", a.id)
	}
	if a.plugin == nil || !a.plugin.desired {
		t.Fatal("plugin info should be set with desired=true")
	}
	want := []string{"enable", "--type", "plugin", "ecc@market", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
	if a.refetch != nil {
		t.Fatal("refetch should be nil (inventory enabled field is not the authoritative signal)")
	}
}

func TestBuildPluginToggleActionDisableVerb(t *testing.T) {
	a := buildPluginToggleAction(pluginToggleInfo{key: "k@m", desired: false})
	if a.args[0] != "disable" {
		t.Fatalf("verb = %q, want disable", a.args[0])
	}
	hasApply := false
	for _, arg := range a.args {
		if arg == "--apply" {
			hasApply = true
		}
	}
	if !hasApply {
		t.Fatalf("apply args %v missing --apply", a.args)
	}
}

// ── pluginConfirmText ──────────────────────────────────────────────────────

func TestPluginConfirmTextDisableShowsDiff(t *testing.T) {
	title, body := pluginConfirmText(pluginToggleInfo{
		key: "ecc@market", desired: false,
		before: `"ecc@market": true`, after: `"ecc@market": false`, line: 152,
	})
	if title != tr("write.plugin.disableTitle") {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{"ecc@market", "152", `"ecc@market": false`, "→"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestPluginConfirmTextInsertHasNoArrow(t *testing.T) {
	_, body := pluginConfirmText(pluginToggleInfo{
		key: "k@m", desired: true, before: "", after: `"k@m": true`, line: 152,
	})
	if strings.Contains(body, "→") {
		t.Fatalf("an insert (empty before) should not render a before→after arrow:\n%s", body)
	}
	if !strings.Contains(body, `"k@m": true`) {
		t.Fatalf("insert body should show the new line:\n%s", body)
	}
}

func TestPluginConfirmTextOverrideCaveat(t *testing.T) {
	_, body := pluginConfirmText(pluginToggleInfo{key: "k@m", desired: true, override: true})
	if !strings.Contains(body, tr("write.plugin.overrideCaveat")) {
		t.Fatalf("override caveat missing:\n%s", body)
	}
	_, body = pluginConfirmText(pluginToggleInfo{key: "k@m", desired: true, override: false})
	if strings.Contains(body, tr("write.plugin.overrideCaveat")) {
		t.Fatalf("override caveat should be absent when override=false:\n%s", body)
	}
}

// ── selectFirstPlugin (test helper) ────────────────────────────────────────

// selectFirstPlugin expands the Plugins folder and lands the cursor on its first
// plugin item so selectedNode() returns a plugin node.
func selectFirstPlugin(m model) model {
	for i := range m.tree.folders {
		if m.tree.folders[i].kind == kindPlugin {
			m.tree.folders[i].expanded = true
		}
	}
	m.tree.rebuildVisible()
	for i, row := range m.tree.visible {
		if !row.isFolder && m.tree.folders[row.folderIdx].kind == kindPlugin {
			m.tree.cursor = i
			break
		}
	}
	return m
}

// ── w key on the Inventory tab ─────────────────────────────────────────────

func TestWOnInventoryPluginLaunchesProbe(t *testing.T) {
	m := loadedModel(120, 30)
	m = selectFirstPlugin(m)
	node, ok := m.tree.selectedNode()
	if !ok || node.kind != kindPlugin {
		t.Fatalf("selectFirstPlugin did not land on a plugin (ok=%v kind=%v)", ok, node.kind)
	}
	m.writesEnabled = true
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("writeRunning should be true while the dry-run probe is in flight")
	}
	if m.pending != nil {
		t.Fatal("pending must stay nil until the probe returns (no modal yet)")
	}
	if cmd == nil {
		t.Fatal("w on a plugin should return the probe cmd")
	}
}

func TestWOnInventoryNonPluginShowsHint(t *testing.T) {
	m := loadedModel(120, 30)
	// loadedModel leaves the cursor on the Skills folder header (a folder row), so
	// selectedNode returns ok=false — not a plugin.
	m.writesEnabled = true
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending must stay nil on a non-plugin row")
	}
	if !strings.Contains(m.writeStatus, tr("write.plugin.selectHint")) {
		t.Fatalf("expected the select-a-plugin hint, got %q", m.writeStatus)
	}
}

// ── pluginToggleMsg handling ───────────────────────────────────────────────

func TestPluginToggleMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true // the probe was in flight
	a := buildPluginToggleAction(pluginToggleInfo{key: "ecc@market", desired: false})
	mm, _ := m.Update(pluginToggleMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the probe resolves")
	}
	if m.pending == nil || m.pending.id != "plugin-toggle" {
		t.Fatal("a successful probe should open the plugin-toggle modal")
	}
}

func TestPluginToggleMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(pluginToggleMsg{err: errFmt("no enabledPlugins object")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("a probe error must NOT open a modal")
	}
	if m.writeOK {
		t.Fatal("writeOK should be false on a probe error")
	}
	if !strings.Contains(m.writeStatus, "no enabledPlugins object") {
		t.Fatalf("writeStatus %q should contain the engine message", m.writeStatus)
	}
}

// ── confirm modal end-to-end (render → y → apply → done) ───────────────────

func TestConfirmViewRendersPluginModal(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildPluginToggleAction(pluginToggleInfo{
		key: "ecc@everything-claude-code", desired: false,
		before: `"ecc@everything-claude-code": true`, after: `"ecc@everything-claude-code": false`, line: 152,
	})
	m.pending = &a
	out := m.View()
	for _, want := range []string{tr("write.plugin.disableTitle"), "ecc@everything-claude-code", "152"} {
		if !strings.Contains(out, want) {
			t.Fatalf("plugin modal missing %q:\n%s", want, out)
		}
	}
}

func TestPluginToggleConfirmYesRunsApply(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildPluginToggleAction(pluginToggleInfo{key: "ecc@market", desired: true})
	m.pending = &a
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should clear on y confirm")
	}
	if !m.writeRunning {
		t.Fatal("writeRunning should be true after confirming the apply")
	}
	if cmd == nil {
		t.Fatal("y confirm should return the apply cmd")
	}
}

func TestPluginToggleDoneMessage(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildPluginToggleAction(pluginToggleInfo{key: "ecc@market", desired: true})
	mm, cmd := m.Update(writeResultMsg{action: a, err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.plugin.done") {
		t.Fatalf("writeStatus = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.plugin.done"))
	}
	if cmd != nil {
		t.Fatal("plugin toggle has no refetch, so the result handler returns no cmd")
	}
}

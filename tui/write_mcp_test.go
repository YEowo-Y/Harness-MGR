package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// VERBATIM codex `enable|disable --type mcp context7 --target codex --format json`
// dry-run envelopes captured from the live engine, reusing the SAME config-edit result
// the plugin toggle decodes. An mcp_servers table has no `enabled` key by default, so
// an enable probe reports alreadyInState=true (a safe no-op) and a disable INSERTs
// `enabled = false` (diff before is "") — the latter also carries the engine's honest
// `config-edit-mcp-loader-unverified` caveat. The Go path reads ONLY result fields
// (Ok/AlreadyInState/Diff); these tests discard the diagnostics, but the arrays are
// kept faithful so the fixtures are a true capture.

const mcpEnableAlreadyJSON = `{"command":"enable","diagnostics":[{"code":"config-edit-dry-run","message":"mcp server 'context7' has no explicit 'enabled' key; Codex defaults to enabled, so it is already enabled. --apply would be a safe no-op (no key is written).","phase":"config-edit","severity":"info"}],"result":{"alreadyInState":true,"applied":false,"desired":true,"diff":null,"dryRun":true,"field":null,"kind":"mcp","name":"context7","ok":true,"snapshotId":null,"status":"already","target":"C:\\Users\\testuser\\.codex\\config.toml"},"version":1}`

const mcpDisableInsertJSON = `{"command":"disable","diagnostics":[{"code":"config-edit-mcp-loader-unverified","message":"inserting 'enabled = false' for mcp server 'context7'. Codex docs say this disables it, but it is UNVERIFIED on this machine (no live disabled instance). After --apply, restart Codex and confirm 'context7' is gone; if it still loads, run rollback to undo. Re-enabling later leaves an explicit 'enabled = true' line, not the original key-absent form.","phase":"config-edit","severity":"warn"},{"code":"config-edit-dry-run","message":"would set mcp 'context7' enabled=false in C:\\Users\\testuser\\.codex\\config.toml (auto-snapshot first → rollback can undo); re-run with --apply. Restart Codex to take effect.","phase":"config-edit","severity":"info"}],"result":{"alreadyInState":false,"applied":false,"desired":false,"diff":{"after":"enabled = false","before":"","line":2122},"dryRun":true,"field":null,"kind":"mcp","name":"context7","ok":true,"snapshotId":null,"status":"dry-run","target":"C:\\Users\\testuser\\.codex\\config.toml"},"version":1}`

// ── the MCP toggle reuses parseConfigEdit (same envelope as the plugin toggle) ──

func TestMcpToggleEnableAlreadyDecodes(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(mcpEnableAlreadyJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.Ok || !r.AlreadyInState {
		t.Fatalf("Ok/AlreadyInState = %v/%v, want true/true (a default-enabled server)", r.Ok, r.AlreadyInState)
	}
}

func TestMcpToggleDisableInsertDecodes(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(mcpDisableInsertJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.Ok || r.AlreadyInState {
		t.Fatalf("Ok/AlreadyInState = %v/%v, want true/false", r.Ok, r.AlreadyInState)
	}
	if r.Diff == nil || r.Diff.Before != "" || r.Diff.After != "enabled = false" || r.Diff.Line != 2122 {
		t.Fatalf("Diff = %+v, want INSERT before=\"\"/after=enabled=false/line=2122", r.Diff)
	}
}

// ── buildMcpToggleAction ───────────────────────────────────────────────────────

func TestBuildMcpToggleActionEnable(t *testing.T) {
	a := buildMcpToggleAction(mcpToggleInfo{server: "context7", desired: true})
	if a.id != "mcp-toggle" {
		t.Fatalf("id = %q, want mcp-toggle", a.id)
	}
	if a.mcp == nil || a.mcp.server != "context7" || !a.mcp.desired {
		t.Fatalf("mcp info should be set enable: %+v", a.mcp)
	}
	want := []string{"enable", "--type", "mcp", "context7", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
	// refetch is nil — the inventory tree does not show a codex MCP server's enabled
	// state, so re-reading it would reset the tree and show no change.
	if a.refetch != nil {
		t.Fatal("refetch should be nil (enabled state is invisible in the tree)")
	}
}

func TestBuildMcpToggleActionDisable(t *testing.T) {
	a := buildMcpToggleAction(mcpToggleInfo{server: "context7", desired: false})
	want := []string{"disable", "--type", "mcp", "context7", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
}

// ── mcpToggleConfirmText (both languages) ─────────────────────────────────────

func TestMcpToggleConfirmTextDisableInsert(t *testing.T) {
	for _, lang := range []language{langEN, langZH} {
		uiLang = lang
		title, body := mcpToggleConfirmText(mcpToggleInfo{
			server: "context7", desired: false, before: "", after: "enabled = false", line: 2122,
		})
		if title != tr("write.mcp.disableTitle") {
			t.Fatalf("[%v] title = %q, want disableTitle", lang, title)
		}
		for _, want := range []string{
			"context7",          // the server name (engine data, verbatim)
			"+ enabled = false", // an INSERT renders with a leading +, no arrow
			"config.toml",       // the diff-line label names config.toml, not settings.json
			tr("write.mcp.reversible"),
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("[%v] disable body missing %q:\n%s", lang, want, body)
			}
		}
	}
	uiLang = langEN
}

func TestMcpToggleConfirmTextEnable(t *testing.T) {
	uiLang = langEN
	title, body := mcpToggleConfirmText(mcpToggleInfo{server: "context7", desired: true})
	if title != tr("write.mcp.enableTitle") {
		t.Fatalf("title = %q, want enableTitle", title)
	}
	if !strings.Contains(body, tf("write.mcp.willEnable", "context7")) {
		t.Fatalf("enable body missing the willEnable line:\n%s", body)
	}
	// An enable carries no loader-unverified caveat (enabling sets a verifiable
	// enabled=true), so the modal must NOT show it.
	if strings.Contains(body, tr("write.mcp.unverifiedCaveat")) {
		t.Fatalf("enable body must NOT show the unverified caveat:\n%s", body)
	}
}

// mcpLoaderUnverified detects the engine's config-edit-mcp-loader-unverified caveat,
// which the live disable envelope carries (an INSERT of enabled=false) and the enable
// envelope does not.
func TestMcpLoaderUnverifiedDetectsCaveat(t *testing.T) {
	_, ddiags, err := parseConfigEdit([]byte(mcpDisableInsertJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit(disable) error: %v", err)
	}
	if !mcpLoaderUnverified(ddiags) {
		t.Fatalf("disable diags should carry the loader-unverified caveat: %+v", ddiags)
	}
	_, ediags, err := parseConfigEdit([]byte(mcpEnableAlreadyJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit(enable) error: %v", err)
	}
	if mcpLoaderUnverified(ediags) {
		t.Fatalf("enable diags must NOT carry the loader-unverified caveat: %+v", ediags)
	}
}

// When the dry-run flagged the loader-unverified caveat, the disable modal surfaces it
// (in both languages) so the user knows to restart Codex and confirm.
func TestMcpToggleConfirmTextUnverifiedCaveat(t *testing.T) {
	for _, lang := range []language{langEN, langZH} {
		uiLang = lang
		_, body := mcpToggleConfirmText(mcpToggleInfo{
			server: "context7", desired: false, before: "", after: "enabled = false", line: 2122, unverified: true,
		})
		if !strings.Contains(body, tr("write.mcp.unverifiedCaveat")) {
			t.Fatalf("[%v] disable body missing the unverified caveat:\n%s", lang, body)
		}
	}
	uiLang = langEN
}

// ── mcpToggleMsg handling ─────────────────────────────────────────────────────

func TestMcpToggleMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true // the dry-run probe was in flight
	a := buildMcpToggleAction(mcpToggleInfo{server: "context7", desired: false})
	mm, _ := m.Update(mcpToggleMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the dry-run resolves")
	}
	if m.pending == nil || m.pending.id != "mcp-toggle" {
		t.Fatal("a successful dry-run should open the mcp-toggle modal")
	}
}

func TestMcpToggleMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(mcpToggleMsg{err: errFmt("mcp server 'nope' not found in config.toml")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("a dry-run refusal must NOT open a modal")
	}
	if m.writeOK {
		t.Fatal("writeOK should be false on a refusal")
	}
	if !strings.Contains(m.writeStatus, "not found") {
		t.Fatalf("writeStatus %q should contain the engine message", m.writeStatus)
	}
}

// ── confirm modal end-to-end (render → y → apply → done) ──────────────────────

func TestConfirmViewRendersMcpToggleModal(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildMcpToggleAction(mcpToggleInfo{
		server: "context7", desired: false, before: "", after: "enabled = false", line: 2122,
	})
	m.pending = &a
	out := m.View()
	for _, want := range []string{tr("write.mcp.disableTitle"), "context7", "enabled = false"} {
		if !strings.Contains(out, want) {
			t.Fatalf("mcp-toggle modal missing %q:\n%s", want, out)
		}
	}
}

func TestMcpToggleConfirmYesRunsApply(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildMcpToggleAction(mcpToggleInfo{server: "context7", desired: false})
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

func TestMcpToggleDoneShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildMcpToggleAction(mcpToggleInfo{server: "context7", desired: false})
	mm, cmd := m.Update(writeResultMsg{action: a, err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.mcp.done") {
		t.Fatalf("writeStatus = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.mcp.done"))
	}
	// Like the plugin/skill toggles, the change is invisible in the tree, so it does
	// NOT refetch (refetch nil → no cmd).
	if cmd != nil {
		t.Fatal("a successful MCP toggle should NOT refetch (enabled state is invisible)")
	}
}

// ── w on an MCP row branches by target ────────────────────────────────────────

func selectFirstMcp(m model) model {
	for i := range m.tree.folders {
		if m.tree.folders[i].kind == kindMcp {
			m.tree.folders[i].expanded = true
		}
	}
	m.tree.rebuildVisible()
	for i, row := range m.tree.visible {
		if !row.isFolder && m.tree.folders[row.folderIdx].kind == kindMcp {
			m.tree.cursor = i
			break
		}
	}
	return m
}

// Under codex, "w" on an MCP row launches the toggle dry-run probe (no modal until
// mcpToggleMsg arrives) — mirrors the plugin toggle.
func TestCodexMcpWStartsToggle(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	m = selectFirstMcp(m)
	if node, ok := m.tree.selectedNode(); !ok || node.kind != kindMcp {
		t.Fatalf("selectFirstMcp did not land on an mcp row (ok=%v kind=%v)", ok, node.kind)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("codex: w on an mcp row should start the toggle dry-run (writeRunning true)")
	}
	if m.pending != nil {
		t.Fatal("codex: w must not open a modal until mcpToggleMsg returns")
	}
	if cmd == nil {
		t.Fatal("codex: w on an mcp row should return the probe cmd")
	}
}

// Under claude, "w" on an MCP row does NOT toggle (claude MCP is a different
// mechanism) — it shows the codex-only hint and starts no probe.
func TestClaudeMcpWShowsHint(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "claude"
	m.writesEnabled = true
	m = selectFirstMcp(m)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("claude: w on an mcp row must NOT start a probe")
	}
	if m.pending != nil {
		t.Fatal("claude: w on an mcp row must NOT open a modal")
	}
	if m.writeStatus != tr("write.mcp.claudeHint") {
		t.Fatalf("writeStatus = %q, want the codex-only hint", m.writeStatus)
	}
}

// ── i18n parity (every write.mcp.* key resolves in both languages) ────────────

func TestMcpToggleI18nParity(t *testing.T) {
	keys := []string{
		"write.mcp.enableTitle", "write.mcp.disableTitle",
		"write.mcp.willEnable", "write.mcp.willDisable",
		"write.mcp.reversible", "write.mcp.unverifiedCaveat",
		"write.mcp.done", "write.mcp.hint", "write.mcp.claudeHint",
	}
	for _, k := range keys {
		pair, ok := translations[k]
		if !ok {
			t.Fatalf("key %q is missing from the translations map", k)
		}
		if pair[langEN] == "" || pair[langZH] == "" {
			t.Fatalf("key %q has an empty translation: %+v", k, pair)
		}
	}
}

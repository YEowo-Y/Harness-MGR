package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// These JSON fixtures are REAL-shaped `remove <kind>:<name> --format json` dry-run
// envelopes (verified against the live engine), trimmed to the fields the TUI
// decodes: status/ok/dryRun/kind/name/target plus the top-level diagnostics.

const removeDryRunJSON = `{"command":"remove","diagnostics":[{"code":"remove-dry-run","message":"would delete C:\\Users\\testuser\\.claude\\agents\\analyst.md (an auto-snapshot would be taken first)","phase":"remove","severity":"info"}],"result":{"applied":false,"dryRun":true,"kind":"agent","lockAcquired":null,"name":"analyst","ok":true,"snapshotId":null,"status":"dry-run","target":"C:\\Users\\testuser\\.claude\\agents\\analyst.md"},"version":1}`

const removeRefusedJSON = `{"command":"remove","diagnostics":[{"code":"remove-target-not-found","message":"nothing to remove: agent:does-not-exist does not exist","phase":"remove","severity":"error"}],"result":{"applied":false,"dryRun":false,"kind":null,"name":null,"ok":false,"snapshotId":null,"status":"refused","target":null},"version":1}`

// ── parseRemove ─────────────────────────────────────────────────────────────

func TestParseRemoveDryRun(t *testing.T) {
	r, diags, err := parseRemove([]byte(removeDryRunJSON))
	if err != nil {
		t.Fatalf("parseRemove error: %v", err)
	}
	if !r.Ok || !r.DryRun {
		t.Fatalf("Ok/DryRun = %v/%v, want true/true", r.Ok, r.DryRun)
	}
	if r.Status != "dry-run" {
		t.Fatalf("Status = %q, want dry-run", r.Status)
	}
	if r.Kind != "agent" || r.Name != "analyst" {
		t.Fatalf("Kind/Name = %q/%q, want agent/analyst", r.Kind, r.Name)
	}
	if r.Target != `C:\Users\testuser\.claude\agents\analyst.md` {
		t.Fatalf("Target = %q", r.Target)
	}
	if r.Applied {
		t.Fatal("Applied should be false on a dry-run")
	}
	// The info dry-run diagnostic comes back alongside the result.
	if len(diags) != 1 || diags[0].Code != "remove-dry-run" || diags[0].Severity != "info" {
		t.Fatalf("diagnostics = %+v, want one info remove-dry-run", diags)
	}
}

func TestParseRemoveRefused(t *testing.T) {
	r, diags, err := parseRemove([]byte(removeRefusedJSON))
	if err != nil {
		t.Fatalf("parseRemove error: %v", err)
	}
	if r.Ok {
		t.Fatal("Ok should be false for a refusal")
	}
	if r.Status != "refused" {
		t.Fatalf("Status = %q, want refused", r.Status)
	}
	// The refusal carries an error-severity remove-target-not-found diagnostic.
	hasErr := false
	for _, d := range diags {
		if d.Code == "remove-target-not-found" && d.Severity == "error" {
			hasErr = true
		}
	}
	if !hasErr {
		t.Fatalf("diagnostics = %+v, want an error-severity remove-target-not-found", diags)
	}
	// refusalError surfaces the first error message (the prepare path uses this).
	if got := refusalError(diags).Error(); !strings.Contains(got, "nothing to remove") {
		t.Fatalf("refusalError = %q, want the engine refusal message", got)
	}
}

// ── buildRemoveAction ───────────────────────────────────────────────────────

func TestBuildRemoveActionArgs(t *testing.T) {
	a := buildRemoveAction(removeInfo{kind: "skill", name: "foo", target: "/p"})
	if a.id != "remove" {
		t.Fatalf("id = %q, want remove", a.id)
	}
	if a.remove == nil || a.remove.kind != "skill" || a.remove.name != "foo" {
		t.Fatalf("remove info should be set: %+v", a.remove)
	}
	want := []string{"remove", "skill:foo", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
	// refetch is fetchCmd (NOT nil) — a delete makes the row vanish, so re-reading the
	// inventory is the success feedback. Funcs are not comparable for equality, so we
	// only assert it is non-nil.
	if a.refetch == nil {
		t.Fatal("refetch should be non-nil (a delete re-reads the inventory)")
	}
}

func TestBuildRemoveActionEachKind(t *testing.T) {
	for _, kind := range []string{"skill", "agent", "command"} {
		a := buildRemoveAction(removeInfo{kind: kind, name: "x"})
		// The kind:name spec must reach the argv verbatim, immediately before --apply.
		hasSpec, hasApply := false, false
		for i, arg := range a.args {
			if arg == kind+":x" && i+1 < len(a.args) && a.args[i+1] == "--apply" {
				hasSpec = true
			}
			if arg == "--apply" {
				hasApply = true
			}
		}
		if !hasSpec {
			t.Fatalf("kind %q spec not placed before --apply in %v", kind, a.args)
		}
		if !hasApply {
			t.Fatalf("apply args %v missing --apply", a.args)
		}
	}
}

// ── removeConfirmText ───────────────────────────────────────────────────────

func TestRemoveConfirmTextSkillHasFolderWarn(t *testing.T) {
	for _, lang := range []language{langEN, langZH} {
		uiLang = lang
		title, body := removeConfirmText(removeInfo{
			kind: "skill", name: "seo", target: `/home/u/.claude/skills/seo`,
		})
		if title != tr("write.remove.title") {
			t.Fatalf("[%v] title = %q, want %q", lang, title, tr("write.remove.title"))
		}
		// The folder warning, the target path, and the willDelete-with-name are all present.
		for _, want := range []string{
			tr("write.remove.folderWarn"),
			`/home/u/.claude/skills/seo`,
			tf("write.remove.willDelete", "seo"),
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("[%v] skill body missing %q:\n%s", lang, want, body)
			}
		}
	}
	uiLang = langEN
}

func TestRemoveConfirmTextAgentHasNoFolderWarn(t *testing.T) {
	_, body := removeConfirmText(removeInfo{
		kind: "agent", name: "analyst", target: `/home/u/.claude/agents/analyst.md`,
	})
	if strings.Contains(body, tr("write.remove.folderWarn")) {
		t.Fatalf("an agent delete must NOT render the skill folder warning:\n%s", body)
	}
	// It still shows the name + the target path.
	for _, want := range []string{tf("write.remove.willDelete", "analyst"), `/home/u/.claude/agents/analyst.md`} {
		if !strings.Contains(body, want) {
			t.Fatalf("agent body missing %q:\n%s", want, body)
		}
	}
}

// ── x key on an Inventory component row ──────────────────────────────────────

func TestXOnInventorySkillLaunchesRemoveDryRun(t *testing.T) {
	m := loadedModel(120, 30)
	m = selectFirstSkill(m)
	node, ok := m.tree.selectedNode()
	if !ok || node.comp == nil {
		t.Fatalf("selectFirstSkill did not land on a component row (ok=%v)", ok)
	}
	m.writesEnabled = true
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("x on a component row should set writeRunning while the dry-run is in flight")
	}
	if m.pending != nil {
		t.Fatal("pending stays nil until removeMsg arrives")
	}
	if cmd == nil {
		t.Fatal("x should return the remove dry-run cmd")
	}
}

func TestXWithWritesDisabledHints(t *testing.T) {
	m := loadedModel(120, 30)
	m = selectFirstSkill(m)
	m.writesEnabled = false
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("x with writes disabled must not launch a dry-run")
	}
	if m.writeOK {
		t.Fatal("writeOK should be false when writes are disabled")
	}
	if m.writeStatus != tr("write.disabledHint") {
		t.Fatalf("writeStatus = %q, want the disabled hint", m.writeStatus)
	}
	if cmd != nil {
		t.Fatal("x with writes disabled dispatches no command")
	}
}

// ── removeMsg handling ──────────────────────────────────────────────────────

func TestRemoveMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true // the dry-run was in flight
	a := buildRemoveAction(removeInfo{kind: "agent", name: "analyst", target: "/p/analyst.md"})
	mm, _ := m.Update(removeMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the dry-run resolves")
	}
	if m.pending == nil || m.pending.id != "remove" {
		t.Fatal("a successful dry-run should open the remove modal")
	}
}

func TestRemoveMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(removeMsg{err: errFmt("nothing to remove: agent:x does not exist")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("a dry-run refusal must NOT open a modal")
	}
	if m.writeOK {
		t.Fatal("writeOK should be false on a refusal")
	}
	if !strings.Contains(m.writeStatus, "nothing to remove") {
		t.Fatalf("writeStatus %q should contain the engine message", m.writeStatus)
	}
}

// ── confirm modal end-to-end (render red → y → apply → done) ────────────────

func TestConfirmViewRendersRemoveModal(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildRemoveAction(removeInfo{kind: "skill", name: "seo", target: `/home/u/.claude/skills/seo`})
	m.pending = &a
	out := m.View()
	for _, want := range []string{
		tr("write.remove.title"),
		"seo",
		`/home/u/.claude/skills/seo`,
		tr("write.remove.folderWarn"),
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("remove modal missing %q:\n%s", want, out)
		}
	}
}

func TestRemoveConfirmYesRunsApply(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildRemoveAction(removeInfo{kind: "agent", name: "analyst", target: "/p/analyst.md"})
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

func TestRemoveDoneRefetches(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildRemoveAction(removeInfo{kind: "agent", name: "analyst", target: "/p/analyst.md"})
	mm, cmd := m.Update(writeResultMsg{action: a, err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.remove.done") {
		t.Fatalf("writeStatus = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.remove.done"))
	}
	// UNLIKE the toggles, a delete refetches the inventory so the deleted row vanishes.
	if cmd == nil {
		t.Fatal("a successful remove should return the refetch cmd (the row vanishes)")
	}
}

// ── i18n parity (every write.remove.* key resolves in both languages) ────────

func TestRemoveI18nParity(t *testing.T) {
	keys := []string{
		"write.remove.title", "write.remove.willDelete", "write.remove.pathLabel",
		"write.remove.folderWarn", "write.remove.reversible", "write.remove.done",
		"write.remove.hint", "write.remove.selectHint",
	}
	for _, k := range keys {
		pair, ok := translations[k]
		if !ok {
			t.Fatalf("key %q is missing from the translations map", k)
		}
		if pair[langEN] == "" {
			t.Fatalf("key %q has an empty English translation", k)
		}
		if pair[langZH] == "" {
			t.Fatalf("key %q has an empty 简体中文 translation", k)
		}
	}
}

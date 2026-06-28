package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// These JSON fixtures are REAL-shaped codex `enable|disable --type skill <name>
// --format json` dry-run envelopes (verified against the live engine), reusing the
// SAME config-edit result the plugin toggle decodes (alreadyInState + diff). The
// flip is keyed by NAME against config.toml [[skills.config]] name blocks.

const skillFlipEnableJSON = `{"command":"enable","diagnostics":[{"code":"config-edit-dry-run","message":"would set skill 'review' enabled=true in config.toml (auto-snapshot first); re-run with --apply.","phase":"config-edit","severity":"info"}],"result":{"alreadyInState":false,"applied":false,"desired":true,"diff":{"after":"enabled = true","before":"enabled = false","line":815},"dryRun":true,"field":"name","kind":"skill","name":"review","ok":true,"snapshotId":null,"status":"dry-run","target":"C:\\Users\\testuser\\.codex\\config.toml"},"version":1}`

const skillFlipNotFoundJSON = `{"command":"enable","diagnostics":[{"code":"config-edit-target-not-found","message":"skill 'a11y-audit' not found in C:\\Users\\testuser\\.codex\\config.toml","phase":"config-edit","severity":"error"}],"result":{"alreadyInState":false,"applied":false,"desired":null,"diff":null,"dryRun":false,"field":"name","kind":"skill","name":"a11y-audit","ok":false,"snapshotId":null,"status":"refused","target":"C:\\Users\\testuser\\.codex\\config.toml"},"version":1}`

// ── the skill flip reuses parseConfigEdit (same envelope as the plugin toggle) ──

func TestSkillFlipEnvelopeDecodes(t *testing.T) {
	r, diags, err := parseConfigEdit([]byte(skillFlipEnableJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.Ok || !r.DryRun || r.AlreadyInState {
		t.Fatalf("Ok/DryRun/AlreadyInState = %v/%v/%v, want true/true/false", r.Ok, r.DryRun, r.AlreadyInState)
	}
	if r.Diff == nil || r.Diff.Before != "enabled = false" || r.Diff.After != "enabled = true" || r.Diff.Line != 815 {
		t.Fatalf("Diff = %+v, want before/after/line = enabled=false/enabled=true/815", r.Diff)
	}
	if len(diags) != 1 || diags[0].Code != "config-edit-dry-run" {
		t.Fatalf("diagnostics = %+v, want one config-edit-dry-run", diags)
	}
}

func TestSkillFlipNotFoundRefusal(t *testing.T) {
	r, diags, err := parseConfigEdit([]byte(skillFlipNotFoundJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if r.Ok {
		t.Fatal("Ok should be false for a skill with no [[skills.config]] entry")
	}
	// refusalError (the prepare path) surfaces the engine's not-found message.
	if got := refusalError(diags).Error(); !strings.Contains(got, "not found") {
		t.Fatalf("refusalError = %q, want the engine not-found message", got)
	}
}

// ── buildSkillFlipAction ──────────────────────────────────────────────────────

func TestBuildSkillFlipActionEnable(t *testing.T) {
	a := buildSkillFlipAction(skillFlipInfo{name: "review", desired: true})
	if a.id != "skill-flip" {
		t.Fatalf("id = %q, want skill-flip", a.id)
	}
	if a.skillFlip == nil || a.skillFlip.name != "review" || !a.skillFlip.desired {
		t.Fatalf("skillFlip info should be set enable: %+v", a.skillFlip)
	}
	want := []string{"enable", "--type", "skill", "review", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
	// refetch is nil — the inventory tree does not show a codex skill's enabled state, so
	// re-reading it would reset the tree and show no change (same as the plugin toggle).
	if a.refetch != nil {
		t.Fatal("refetch should be nil (enabled state is invisible in the tree)")
	}
}

func TestBuildSkillFlipActionDisable(t *testing.T) {
	a := buildSkillFlipAction(skillFlipInfo{name: "review", desired: false})
	want := []string{"disable", "--type", "skill", "review", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
}

// ── skillFlipConfirmText (both languages) ─────────────────────────────────────

func TestSkillFlipConfirmTextEnable(t *testing.T) {
	for _, lang := range []language{langEN, langZH} {
		uiLang = lang
		title, body := skillFlipConfirmText(skillFlipInfo{
			name: "review", desired: true, before: "enabled = false", after: "enabled = true", line: 815,
		})
		if title != tr("write.skillFlip.enableTitle") {
			t.Fatalf("[%v] title = %q, want enableTitle", lang, title)
		}
		for _, want := range []string{
			"review",          // the skill name (engine data, verbatim)
			"enabled = true",  // the after diff fragment
			"enabled = false", // the before diff fragment
			"config.toml",     // the diff-line label names config.toml, not settings.json
			tr("write.skillFlip.reversible"),
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("[%v] enable body missing %q:\n%s", lang, want, body)
			}
		}
	}
	uiLang = langEN
}

func TestSkillFlipConfirmTextDisable(t *testing.T) {
	uiLang = langEN
	title, body := skillFlipConfirmText(skillFlipInfo{
		name: "review", desired: false, before: "enabled = true", after: "enabled = false", line: 815,
	})
	if title != tr("write.skillFlip.disableTitle") {
		t.Fatalf("title = %q, want disableTitle", title)
	}
	if !strings.Contains(body, tf("write.skillFlip.willDisable", "review")) {
		t.Fatalf("disable body missing the willDisable line:\n%s", body)
	}
}

// ── skillFlipMsg handling ─────────────────────────────────────────────────────

func TestSkillFlipMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true // the dry-run probe was in flight
	a := buildSkillFlipAction(skillFlipInfo{name: "review", desired: true})
	mm, _ := m.Update(skillFlipMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the dry-run resolves")
	}
	if m.pending == nil || m.pending.id != "skill-flip" {
		t.Fatal("a successful dry-run should open the skill-flip modal")
	}
}

func TestSkillFlipMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(skillFlipMsg{err: errFmt("skill 'a11y-audit' not found in config.toml")})
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

func TestConfirmViewRendersSkillFlipModal(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillFlipAction(skillFlipInfo{
		name: "review", desired: true, before: "enabled = false", after: "enabled = true", line: 815,
	})
	m.pending = &a
	out := m.View()
	for _, want := range []string{tr("write.skillFlip.enableTitle"), "review", "enabled = true"} {
		if !strings.Contains(out, want) {
			t.Fatalf("skill-flip modal missing %q:\n%s", want, out)
		}
	}
}

func TestSkillFlipConfirmYesRunsApply(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillFlipAction(skillFlipInfo{name: "review", desired: true})
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

func TestSkillFlipDoneShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillFlipAction(skillFlipInfo{name: "review", desired: true})
	mm, cmd := m.Update(writeResultMsg{action: a, err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.skillFlip.done") {
		t.Fatalf("writeStatus = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.skillFlip.done"))
	}
	// Like the plugin/visibility toggles, the flip's change is invisible in the tree, so
	// it does NOT refetch (refetch nil → no cmd).
	if cmd != nil {
		t.Fatal("a successful skill flip should NOT refetch (enabled state is invisible)")
	}
}

// ── i18n parity (every write.skillFlip.* key resolves in both languages) ──────

func TestSkillFlipI18nParity(t *testing.T) {
	keys := []string{
		"write.skillFlip.enableTitle", "write.skillFlip.disableTitle",
		"write.skillFlip.willEnable", "write.skillFlip.willDisable",
		"write.skillFlip.reversible", "write.skillFlip.done", "write.skillFlip.hint",
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

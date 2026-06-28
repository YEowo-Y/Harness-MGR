package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// These JSON fixtures are REAL-shaped `skill visibility <name> <state> --format
// json` dry-run envelopes (the flat config-edit result the TUI reuses), trimmed
// to the fields the TUI decodes: status/ok/dryRun/alreadyInState/diff.

const skillVisSetJSON = `{"result":{"alreadyInState":false,"applied":false,"diff":{"after":"\"seo\": \"name-only\"","before":"\"seo\": \"on\"","line":42},"dryRun":true,"kind":"skill","name":"seo","ok":true,"snapshotId":null,"state":"name-only","status":"dry-run","target":"claude"},"diagnostics":[],"version":1}`

const skillVisInsertJSON = `{"result":{"alreadyInState":false,"applied":false,"diff":{"after":"\"seo\": \"off\"","before":"","line":42},"dryRun":true,"kind":"skill","name":"seo","ok":true,"snapshotId":null,"state":"off","status":"dry-run","target":"claude"},"diagnostics":[],"version":1}`

const skillVisAlreadyJSON = `{"result":{"alreadyInState":true,"applied":false,"diff":null,"dryRun":true,"kind":"skill","name":"seo","ok":true,"snapshotId":null,"state":"on","status":"already","target":"claude"},"diagnostics":[{"code":"skill-visibility-already","severity":"info","message":"already on"}],"version":1}`

const skillVisRefusedJSON = `{"result":{"alreadyInState":false,"applied":false,"diff":null,"dryRun":false,"kind":"skill","name":"seo","ok":false,"snapshotId":null,"state":"off","status":"refused","target":"codex"},"diagnostics":[{"code":"skill-visibility-target-unsupported","severity":"error","message":"skill visibility is claude-only"}],"version":1}`

// ── parseConfigEdit reuse for skill-vis envelopes ───────────────────────────

func TestParseConfigEditSkillVisSetDiff(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(skillVisSetJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.Ok || !r.DryRun {
		t.Fatalf("Ok/DryRun = %v/%v, want true/true", r.Ok, r.DryRun)
	}
	if r.AlreadyInState {
		t.Fatal("AlreadyInState should be false for a real change")
	}
	if r.Diff == nil || r.Diff.Before != `"seo": "on"` || r.Diff.After != `"seo": "name-only"` {
		t.Fatalf("diff before/after = %+v", r.Diff)
	}
	if r.Diff.Line != 42 {
		t.Fatalf("diff line = %d, want 42", r.Diff.Line)
	}
}

func TestParseConfigEditSkillVisAlready(t *testing.T) {
	r, _, err := parseConfigEdit([]byte(skillVisAlreadyJSON))
	if err != nil {
		t.Fatalf("parseConfigEdit error: %v", err)
	}
	if !r.AlreadyInState {
		t.Fatal("AlreadyInState should be true for an already-in-state no-op")
	}
	if r.Diff != nil {
		t.Fatal("Diff should be nil for an already-in-state no-op")
	}
}

// ── buildSkillVisAction ─────────────────────────────────────────────────────

func TestBuildSkillVisActionArgs(t *testing.T) {
	a := buildSkillVisAction(skillVisInfo{name: "seo", state: "name-only"})
	if a.id != "skill-visibility" {
		t.Fatalf("id = %q", a.id)
	}
	if a.skillVis == nil || a.skillVis.state != "name-only" {
		t.Fatal("skillVis info should be set with the chosen state")
	}
	want := []string{"skill", "visibility", "seo", "name-only", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", a.args, want)
	}
	if a.refetch != nil {
		t.Fatal("refetch should be nil (the tree does not display visibility)")
	}
}

func TestBuildSkillVisActionHasApplyAndState(t *testing.T) {
	for _, state := range skillVisStates {
		a := buildSkillVisAction(skillVisInfo{name: "x", state: state})
		// The chosen state must reach the argv verbatim, immediately before --apply.
		hasState, hasApply := false, false
		for i, arg := range a.args {
			if arg == state && i+1 < len(a.args) && a.args[i+1] == "--apply" {
				hasState = true
			}
			if arg == "--apply" {
				hasApply = true
			}
		}
		if !hasState {
			t.Fatalf("state %q not placed before --apply in %v", state, a.args)
		}
		if !hasApply {
			t.Fatalf("apply args %v missing --apply", a.args)
		}
	}
}

// ── skillVisConfirmText ─────────────────────────────────────────────────────

func TestSkillVisConfirmTextShowsDiff(t *testing.T) {
	title, body := skillVisConfirmText(skillVisInfo{
		name: "seo", state: "name-only",
		before: `"seo": "on"`, after: `"seo": "name-only"`, line: 42,
	})
	if title != tr("write.skillVis.setTitle") {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{"seo", "name-only", "42", `"seo": "name-only"`, "→"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestSkillVisConfirmTextInsertHasNoArrow(t *testing.T) {
	_, body := skillVisConfirmText(skillVisInfo{
		name: "seo", state: "off", before: "", after: `"seo": "off"`, line: 42,
	})
	if strings.Contains(body, "→") {
		t.Fatalf("an insert (empty before) should not render a before→after arrow:\n%s", body)
	}
	if !strings.Contains(body, `"seo": "off"`) {
		t.Fatalf("insert body should show the new line:\n%s", body)
	}
}

// ── selectFirstSkill (test helper) ──────────────────────────────────────────

// selectFirstSkill lands the cursor on the first skill item so selectedNode()
// returns a skill node. The Skills folder starts expanded in newTreeModel.
func selectFirstSkill(m model) model {
	for i := range m.tree.folders {
		if m.tree.folders[i].kind == kindSkill {
			m.tree.folders[i].expanded = true
		}
	}
	m.tree.rebuildVisible()
	for i, row := range m.tree.visible {
		if !row.isFolder && m.tree.folders[row.folderIdx].kind == kindSkill {
			m.tree.cursor = i
			break
		}
	}
	return m
}

// ── w key on a skill row opens the picker ───────────────────────────────────

func TestWOnInventorySkillOpensPicker(t *testing.T) {
	m := loadedModel(120, 30)
	m = selectFirstSkill(m)
	node, ok := m.tree.selectedNode()
	if !ok || node.kind != kindSkill {
		t.Fatalf("selectFirstSkill did not land on a skill (ok=%v kind=%v)", ok, node.kind)
	}
	m.writesEnabled = true
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.visPick == nil {
		t.Fatal("w on a skill row should open the visibility picker")
	}
	if m.visPick.name != node.comp.Name {
		t.Fatalf("picker name = %q, want %q", m.visPick.name, node.comp.Name)
	}
	if m.visPick.cursor != 0 {
		t.Fatalf("picker cursor should start at 0, got %d", m.visPick.cursor)
	}
	if m.pending != nil {
		t.Fatal("pending must stay nil — the picker leads into the modal, not directly")
	}
	if m.writeRunning {
		t.Fatal("the picker itself does no write, so writeRunning must stay false")
	}
	if cmd != nil {
		t.Fatal("opening the picker dispatches no command")
	}
}

// ── picker cursor navigation + clamping ─────────────────────────────────────

func TestVisPickerCursorClamping(t *testing.T) {
	m := loadedModel(120, 30)
	m.visPick = &visPicker{name: "seo", cursor: 0}

	// Up at the top clamps at 0.
	m = pressKey(t, m, tea.KeyMsg{Type: tea.KeyUp})
	if m.visPick.cursor != 0 {
		t.Fatalf("up at top: cursor = %d, want 0", m.visPick.cursor)
	}
	// Down moves through every state and clamps at the last.
	for i := 0; i < len(skillVisStates)+3; i++ {
		m = pressKey(t, m, tea.KeyMsg{Type: tea.KeyDown})
	}
	last := len(skillVisStates) - 1
	if m.visPick.cursor != last {
		t.Fatalf("down past the end: cursor = %d, want %d (clamped)", m.visPick.cursor, last)
	}
	// j/k aliases work too: k moves up one.
	m = pressRune(t, m, 'k')
	if m.visPick.cursor != last-1 {
		t.Fatalf("k: cursor = %d, want %d", m.visPick.cursor, last-1)
	}
	m = pressRune(t, m, 'j')
	if m.visPick.cursor != last {
		t.Fatalf("j: cursor = %d, want %d", m.visPick.cursor, last)
	}
}

func TestVisPickerEnterLaunchesDryRun(t *testing.T) {
	m := loadedModel(120, 30)
	m.visPick = &visPicker{name: "seo", cursor: 1} // "name-only"
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(model)
	if m.visPick != nil {
		t.Fatal("Enter should close the picker")
	}
	if !m.writeRunning {
		t.Fatal("Enter should set writeRunning while the dry-run is in flight")
	}
	if m.pending != nil {
		t.Fatal("pending stays nil until skillVisMsg arrives")
	}
	if cmd == nil {
		t.Fatal("Enter should return the dry-run cmd")
	}
}

func TestVisPickerEscCancels(t *testing.T) {
	m := loadedModel(120, 30)
	m.visPick = &visPicker{name: "seo", cursor: 2}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = mm.(model)
	if m.visPick != nil {
		t.Fatal("Esc should cancel the picker")
	}
	if m.writeRunning {
		t.Fatal("cancelling launches no write")
	}
	if cmd != nil {
		t.Fatal("cancelling dispatches no command")
	}
}

// ── skillVisMsg handling ────────────────────────────────────────────────────

func TestSkillVisMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true // the dry-run was in flight
	a := buildSkillVisAction(skillVisInfo{name: "seo", state: "off"})
	mm, _ := m.Update(skillVisMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the dry-run resolves")
	}
	if m.pending == nil || m.pending.id != "skill-visibility" {
		t.Fatal("a successful dry-run should open the skill-visibility modal")
	}
}

func TestSkillVisMsgAlreadyInStateToast(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(skillVisMsg{alreadyInState: true, name: "seo", state: "on"})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("an already-in-state result must NOT open a modal")
	}
	if !m.writeOK {
		t.Fatal("writeOK should be true for a benign no-op")
	}
	if m.writeStatus != tf("write.skillVis.already", "seo", "on") {
		t.Fatalf("writeStatus = %q, want the already-in-state toast", m.writeStatus)
	}
}

func TestSkillVisMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(skillVisMsg{err: errFmt("skill visibility is claude-only")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("a dry-run error must NOT open a modal")
	}
	if m.writeOK {
		t.Fatal("writeOK should be false on a dry-run error")
	}
	if !strings.Contains(m.writeStatus, "skill visibility is claude-only") {
		t.Fatalf("writeStatus %q should contain the engine message", m.writeStatus)
	}
}

// ── confirm modal end-to-end (render → y → apply → done) ────────────────────

func TestVisPickerViewRenders(t *testing.T) {
	m := loadedModel(120, 30)
	m.visPick = &visPicker{name: "seo", cursor: 0}
	out := m.View()
	for _, want := range []string{tr("write.skillVis.title"), "seo", "on", "name-only", "user-invocable-only", "off"} {
		if !strings.Contains(out, want) {
			t.Fatalf("picker view missing %q:\n%s", want, out)
		}
	}
}

func TestConfirmViewRendersSkillVisModal(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillVisAction(skillVisInfo{
		name: "seo", state: "name-only",
		before: `"seo": "on"`, after: `"seo": "name-only"`, line: 42,
	})
	m.pending = &a
	out := m.View()
	for _, want := range []string{tr("write.skillVis.setTitle"), "seo", "name-only", "42"} {
		if !strings.Contains(out, want) {
			t.Fatalf("skill-vis modal missing %q:\n%s", want, out)
		}
	}
}

func TestSkillVisConfirmYesRunsApply(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillVisAction(skillVisInfo{name: "seo", state: "off"})
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

func TestSkillVisDoneMessage(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildSkillVisAction(skillVisInfo{name: "seo", state: "off"})
	mm, cmd := m.Update(writeResultMsg{action: a, err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.skillVis.done") {
		t.Fatalf("writeStatus = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.skillVis.done"))
	}
	if cmd != nil {
		t.Fatal("skill visibility has no refetch, so the result handler returns no cmd")
	}
}

// pressKey sends an arbitrary key message to the model and returns the next model.
func pressKey(t *testing.T, m model, key tea.KeyMsg) model {
	t.Helper()
	mm, _ := m.Update(key)
	return mm.(model)
}

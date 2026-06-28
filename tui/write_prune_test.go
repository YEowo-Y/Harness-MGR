package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// A REAL-shaped codex `remove skill:<name> --prune-config --format json` dry-run
// envelope (verified against the live engine): the remove result gains pruned[] +
// prunedCount describing the orphaned [[skills.config]] entries the same atomic
// snapshot would also remove.
const pruneDryRunJSON = `{"command":"remove","diagnostics":[{"code":"prune-config-dry-run","message":"would delete C:\\Users\\testuser\\.codex\\skills\\ab-test-setup + 2 orphaned config entries; ONE auto-snapshot would be taken first so a single rollback undoes BOTH.","phase":"prune-config","severity":"info"}],"result":{"applied":false,"dryRun":true,"kind":"skill","lockAcquired":null,"name":"ab-test-setup","ok":true,"pruned":[{"field":"name","value":"ab-test-setup"},{"field":"path","value":"C:/Users/testuser/.codex/skills/ab-test-setup/SKILL.md"}],"prunedCount":2,"snapshotId":null,"status":"dry-run","target":"C:\\Users\\testuser\\.codex\\skills\\ab-test-setup"},"version":1}`

// ── parseRemove decodes the prune fields ──────────────────────────────────────

func TestParseRemovePruneFields(t *testing.T) {
	r, _, err := parseRemove([]byte(pruneDryRunJSON))
	if err != nil {
		t.Fatalf("parseRemove error: %v", err)
	}
	if !r.Ok || r.Status != "dry-run" {
		t.Fatalf("Ok/Status = %v/%q, want true/dry-run", r.Ok, r.Status)
	}
	if r.PrunedCount != 2 || len(r.Pruned) != 2 {
		t.Fatalf("PrunedCount/len(Pruned) = %d/%d, want 2/2", r.PrunedCount, len(r.Pruned))
	}
	if r.Pruned[0].Field != "name" || r.Pruned[1].Field != "path" {
		t.Fatalf("pruned fields = %q/%q, want name/path", r.Pruned[0].Field, r.Pruned[1].Field)
	}
}

// A plain remove omits the prune fields — they must decode to the zero value, not error.
func TestParseRemovePlainHasNoPrune(t *testing.T) {
	r, _, err := parseRemove([]byte(removeDryRunJSON)) // from write_remove_test.go
	if err != nil {
		t.Fatalf("parseRemove error: %v", err)
	}
	if r.PrunedCount != 0 || r.Pruned != nil {
		t.Fatalf("plain remove should have no prune data: count=%d pruned=%v", r.PrunedCount, r.Pruned)
	}
}

// ── buildRemoveAction wires --prune-config only when prune is set ─────────────

func TestBuildRemoveActionPruneArgs(t *testing.T) {
	a := buildRemoveAction(removeInfo{kind: "skill", name: "ab-test-setup", target: "/p", prune: true, prunedCount: 2})
	want := []string{"remove", "skill:ab-test-setup", "--prune-config", "--apply", "--format", "json"}
	if strings.Join(a.args, " ") != strings.Join(want, " ") {
		t.Fatalf("prune args = %v, want %v", a.args, want)
	}
}

func TestBuildRemoveActionNoPruneOmitsFlag(t *testing.T) {
	a := buildRemoveAction(removeInfo{kind: "skill", name: "foo", target: "/p", prune: false})
	for _, arg := range a.args {
		if arg == "--prune-config" {
			t.Fatalf("a non-prune delete must NOT pass --prune-config: %v", a.args)
		}
	}
}

// ── removeConfirmText shows the prune count only on a prune delete ────────────

func TestRemoveConfirmTextPruneShowsCount(t *testing.T) {
	for _, lang := range []language{langEN, langZH} {
		uiLang = lang
		_, body := removeConfirmText(removeInfo{
			kind: "skill", name: "ab-test-setup", target: `/c/.codex/skills/ab-test-setup`,
			prune: true, prunedCount: 2,
		})
		if !strings.Contains(body, tf("write.remove.willPrune", 2)) {
			t.Fatalf("[%v] prune body missing the willPrune(2) line:\n%s", lang, body)
		}
	}
	uiLang = langEN
}

func TestRemoveConfirmTextNoPruneNoCountLine(t *testing.T) {
	uiLang = langEN
	_, body := removeConfirmText(removeInfo{kind: "skill", name: "seo", target: "/p", prune: false})
	// The willPrune line uses a %d; a non-prune delete must not render it at all.
	if strings.Contains(body, "prunes") {
		t.Fatalf("a non-prune delete must NOT mention pruning:\n%s", body)
	}
}

// ── removePicker navigation + launch ─────────────────────────────────────────

func TestRemovePickerCursorClamps(t *testing.T) {
	m := loadedModel(120, 30)
	m.removePick = &removePicker{name: "foo", cursor: 0}
	// Up at the top stays at 0.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("k")})
	m = mm.(model)
	if m.removePick.cursor != 0 {
		t.Fatalf("cursor = %d after up at top, want 0", m.removePick.cursor)
	}
	// Down moves to 1 (the last option).
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	if m.removePick.cursor != 1 {
		t.Fatalf("cursor = %d after down, want 1", m.removePick.cursor)
	}
	// Down at the bottom stays at 1 (clamped to len(removePickLabelKeys)-1).
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	if m.removePick.cursor != 1 {
		t.Fatalf("cursor = %d after down at bottom, want 1 (clamped)", m.removePick.cursor)
	}
}

func TestRemovePickerEnterLaunchesDryRun(t *testing.T) {
	for _, cursor := range []int{0, 1} { // delete-only AND delete+prune both launch
		m := loadedModel(120, 30)
		m.target = "codex"
		m.removePick = &removePicker{name: "ab-test-setup", cursor: cursor}
		mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		m = mm.(model)
		if m.removePick != nil {
			t.Fatalf("cursor %d: enter should close the picker", cursor)
		}
		if !m.writeRunning {
			t.Fatalf("cursor %d: enter should launch the dry-run (writeRunning true)", cursor)
		}
		if cmd == nil {
			t.Fatalf("cursor %d: enter should return the dry-run cmd", cursor)
		}
	}
}

func TestRemovePickerEscCancels(t *testing.T) {
	m := loadedModel(120, 30)
	m.removePick = &removePicker{name: "foo"}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = mm.(model)
	if m.removePick != nil {
		t.Fatal("esc should cancel the picker")
	}
	if m.writeRunning {
		t.Fatal("esc must not start any write")
	}
	if cmd != nil {
		t.Fatal("esc dispatches no command")
	}
}

// ── View dispatch + overlay mutual-exclusion ─────────────────────────────────

func TestRemovePickerViewRenders(t *testing.T) {
	m := loadedModel(120, 30)
	m.removePick = &removePicker{name: "ab-test-setup", cursor: 1}
	out := m.View()
	for _, want := range []string{
		tr("write.remove.pickTitle"),
		"ab-test-setup",
		tr("write.remove.pickDeleteOnly"),
		tr("write.remove.pickPrune"),
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("remove picker missing %q:\n%s", want, out)
		}
	}
}

// selectFirstAgent lands the cursor on the first agent item (mirrors
// selectFirstSkill) so the picker-is-skill-only guard can be tested on a non-skill row.
func selectFirstAgent(m model) model {
	for i := range m.tree.folders {
		if m.tree.folders[i].kind == kindAgent {
			m.tree.folders[i].expanded = true
		}
	}
	m.tree.rebuildVisible()
	for i, row := range m.tree.visible {
		if !row.isFolder && m.tree.folders[row.folderIdx].kind == kindAgent {
			m.tree.cursor = i
			break
		}
	}
	return m
}

// TestCodexXOnAgentDeletesDirectly pins that the delete picker is codex-SKILL-only:
// a codex AGENT row 'x' deletes directly (no [[skills.config]] to prune), launching
// the dry-run with prune=false — it must NOT open the picker.
func TestCodexXOnAgentDeletesDirectly(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	m = selectFirstAgent(m)
	if node, ok := m.tree.selectedNode(); !ok || node.kind != kindAgent {
		t.Fatalf("selectFirstAgent did not land on an agent (ok=%v kind=%v)", ok, node.kind)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = mm.(model)
	if m.removePick != nil {
		t.Fatal("codex: x on an AGENT must NOT open the skill-only prune picker")
	}
	if !m.writeRunning {
		t.Fatal("codex: x on an agent should launch the remove dry-run directly (writeRunning true)")
	}
	if cmd == nil {
		t.Fatal("codex: x on an agent should return the dry-run cmd")
	}
}

// ── i18n parity (every new write.remove.pick* / willPrune key resolves) ───────

func TestPruneI18nParity(t *testing.T) {
	keys := []string{
		"write.remove.pickTitle", "write.remove.pickHint",
		"write.remove.pickDeleteOnly", "write.remove.pickPrune", "write.remove.willPrune",
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

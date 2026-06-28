package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── targetArgs (pure helper) ──────────────────────────────────────────────────

// TestTargetArgs pins the pure flag-building seam: only "codex" gets an explicit
// --target flag; "" and "claude" return nil so the Claude call line stays
// byte-identical to before this slice.
func TestTargetArgs(t *testing.T) {
	if got := targetArgs("codex"); len(got) != 2 || got[0] != "--target" || got[1] != "codex" {
		t.Fatalf("targetArgs(codex) = %v, want [--target codex]", got)
	}
	if got := targetArgs("claude"); got != nil {
		t.Fatalf("targetArgs(claude) = %v, want nil (engine default)", got)
	}
	if got := targetArgs(""); got != nil {
		t.Fatalf("targetArgs(\"\") = %v, want nil (engine default)", got)
	}
	// Any unrecognized value also stays on the engine default (no flag) — only
	// "codex" ever scopes the command.
	if got := targetArgs("gemini"); got != nil {
		t.Fatalf("targetArgs(gemini) = %v, want nil", got)
	}
}

// ── T key flips target, persists, invalidates, refetches ──────────────────────

// TestTKeyFlipsTargetAndPersists verifies T toggles claude→codex→claude, returns a
// non-nil cmd (the persist + refetch batch), and re-arms the inventory + eager
// section fetches (so a switch shows fresh per-target data).
func TestTKeyFlipsTargetAndPersists(t *testing.T) {
	m := loadedModel(120, 30)
	if m.target != "claude" {
		t.Fatalf("loadedModel target = %q, want claude", m.target)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)
	if m.target != "codex" {
		t.Fatalf("after first T: target = %q, want codex", m.target)
	}
	if cmd == nil {
		t.Fatal("T should return a non-nil cmd (persist + refetch batch)")
	}
	// Caches must be invalidated + re-armed: inventory + the eager sections back in flight.
	if !m.loading || !m.detailLoading {
		t.Fatalf("after T: loading=%v detailLoading=%v, want both true", m.loading, m.detailLoading)
	}
	for _, v := range eagerSectionViews {
		if st := m.sections[v]; st == nil || !st.loading {
			t.Fatalf("after T: eager section %v not re-armed (loading=false)", v)
		}
	}
	// Second T flips back to claude.
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)
	if m.target != "claude" {
		t.Fatalf("after second T: target = %q, want claude", m.target)
	}
}

// TestTKeyInvalidatesCachedData verifies the switch drops stale per-target data:
// loaded section data + the raw snapshot list must be cleared so the old target's
// rows never show under the new target.
func TestTKeyInvalidatesCachedData(t *testing.T) {
	m := loadedModel(120, 30)
	// Seed some "loaded" state on a lazy section + the snapshot raw list.
	cfg := m.sections[viewConfig]
	cfg.loaded = true
	cfg.list = newSectionModel([]sectionItem{{title: "stale", id: "x"}})
	cfg.summaryKey = "summary.config"
	m.snapshotData = []Snapshot{{Id: "snap-1"}}
	// Precondition: loadedModel's tree has component rows (sampleDetail populates it).
	if len(m.detailData.Components) == 0 {
		t.Fatal("precondition: loadedModel should have detail components")
	}

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)

	if m.sections[viewConfig].loaded {
		t.Error("after T: viewConfig.loaded should be cleared (cache invalidated)")
	}
	if m.sections[viewConfig].summaryKey != "" {
		t.Errorf("after T: viewConfig.summaryKey = %q, want cleared", m.sections[viewConfig].summaryKey)
	}
	if m.snapshotData != nil {
		t.Errorf("after T: snapshotData = %v, want nil (belongs to old target)", m.snapshotData)
	}
	// The inventory data + tree are rebuilt from the zero value (the empty tree still
	// shows its 6 folder headers, but no item rows survive).
	if len(m.detailData.Components) != 0 {
		t.Errorf("after T: detailData.Components should be cleared, got %d", len(m.detailData.Components))
	}
	wantEmpty := newTreeModel(DetailData{})
	if len(m.tree.visible) != len(wantEmpty.visible) {
		t.Errorf("after T: tree has %d visible rows, want %d (rebuilt empty)", len(m.tree.visible), len(wantEmpty.visible))
	}
}

// TestTKeyResetsFilter verifies an active filter is dropped on a target switch (the
// row set changes, so a stale query must not carry over).
func TestTKeyResetsFilter(t *testing.T) {
	m := loadedModel(120, 30)
	// An APPLIED filter (not in filter-edit mode — in edit mode a "T" rune would be
	// typed into the query). Apply it through the model so the widget filter is set.
	m.filterQuery = "seo"
	m.applyFilter()
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})
	m = mm.(model)
	if m.filterQuery != "" {
		t.Errorf("after T: filterQuery = %q, want cleared", m.filterQuery)
	}
	if m.filterMode {
		t.Error("after T: filterMode should be cleared")
	}
}

// ── codex writes (slice 2a): w / x are LIVE; the active probe stays gated ──────

// TestCodexDriftWOpensModal verifies that under codex the Drift "w" opens the
// drift-update confirm modal (slice 2a makes codex drift-update live) — the slice-1
// read-only no-op is gone. On confirm the write routes through runWriteCmd under
// --target codex.
func TestCodexDriftWOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	// Jump to the Drift tab (key "9").
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	if m.currentView != viewDrift {
		t.Fatalf("currentView = %v, want viewDrift", m.currentView)
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending == nil || m.pending.id != "drift-update" {
		t.Fatal("codex: w on Drift should open the drift-update modal (slice 2a)")
	}
}

// TestCodexXStartsRemove verifies that under codex "x" on a removable row launches
// the remove dry-run (slice 2a makes codex remove live) — the slice-1 no-op is gone.
// The dry-run runs under --target codex; the modal opens only when removeMsg arrives.
func TestCodexXStartsRemove(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	m = selectFirstSkill(m)
	if node, ok := m.tree.selectedNode(); !ok || node.kind != kindSkill {
		t.Fatalf("selectFirstSkill did not land on a skill (ok=%v kind=%v)", ok, node.kind)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("codex: x should start the remove dry-run (writeRunning true)")
	}
	if m.pending != nil {
		t.Fatal("codex: x must not open a modal until removeMsg returns")
	}
	if cmd == nil {
		t.Fatal("codex: x should return the remove dry-run cmd")
	}
}

// TestCodexPluginWStartsDryRun verifies that under codex "w" on a plugin row
// launches the toggle dry-run probe (slice 2a) under --target codex — mirrors the
// claude path, proving removing the codex guard did not regress plugin toggle.
func TestCodexPluginWStartsDryRun(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	m = selectFirstPlugin(m)
	if node, ok := m.tree.selectedNode(); !ok || node.kind != kindPlugin {
		t.Fatalf("selectFirstPlugin did not land on a plugin (ok=%v kind=%v)", ok, node.kind)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("codex: w on a plugin should start the dry-run probe")
	}
	if m.pending != nil {
		t.Fatal("codex: w must not open a modal until pluginToggleMsg returns")
	}
	if cmd == nil {
		t.Fatal("codex: w on a plugin should return the probe cmd")
	}
}

// TestCodexSkillWShowsTodo verifies that under codex "w" on a skill row does NOT
// open the Claude 4-state visibility picker (a different operation) — codex skills
// flip via a binary enable/disable, which is slice 2b. Until then it shows a hint.
func TestCodexSkillWShowsTodo(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	m = selectFirstSkill(m)
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.visPick != nil {
		t.Fatal("codex: w on a skill must NOT open the Claude visibility picker")
	}
	if cmd != nil {
		t.Fatal("codex: w on a skill (2b TODO) should return no command")
	}
	if m.writeStatus != tr("write.skill.codexTodo") {
		t.Fatalf("codex: writeStatus = %q, want %q", m.writeStatus, tr("write.skill.codexTodo"))
	}
	if m.writeOK {
		t.Fatal("codex: writeOK should be false for the 2b-TODO hint")
	}
}

// TestCodexWOnSnapshotsLaunchesPreflight verifies that under codex "w" on a snapshot
// row launches the rollback dry-run preflight (slice 2a makes codex rollback live) —
// the slice-1 no-op is gone. The preflight + the safety snapshot + the restore all
// run under --target codex; the modal opens only when rollbackPrepMsg arrives.
func TestCodexWOnSnapshotsLaunchesPreflight(t *testing.T) {
	m := loadSnapshotsModel(t)
	m.target = "codex"
	m.writesEnabled = true
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("codex: w on a snapshot should start the rollback preflight (writeRunning true)")
	}
	if m.pending != nil {
		t.Fatal("codex: w must not open a modal until rollbackPrepMsg returns")
	}
	if cmd == nil {
		t.Fatal("codex: w on a snapshot should return the preflight cmd")
	}
}

// TestCodexActiveProbeNoop verifies that under codex, "a" (doctor active probes)
// no-ops with the read-only toast on the Doctor tab — the probe writes a transient
// governed-dir file, so it must never fire against codex.
func TestCodexActiveProbeNoop(t *testing.T) {
	m := loadedModel(120, 30)
	m.target = "codex"
	m.writesEnabled = true
	// Jump to the Doctor tab (tab 7, key "7").
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	if m.currentView != viewDoctor {
		t.Fatalf("currentView = %v, want viewDoctor", m.currentView)
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	m = mm.(model)
	if m.pending != nil || m.writeRunning {
		t.Fatal("codex: a must not start the active probe")
	}
	if cmd != nil {
		t.Fatal("codex: a must return no command")
	}
	if m.writeStatus != tr("write.codexReadOnly") {
		t.Fatalf("codex: writeStatus = %q, want %q", m.writeStatus, tr("write.codexReadOnly"))
	}
}

// TestClaudeWStillOpensModal is the byte-identical-path guard: with target=claude
// the w key behaves exactly as before (opens the drift-update modal). The codex
// guard must be a no-op when target!="codex".
func TestClaudeWStillOpensModal(t *testing.T) {
	m := loadedModel(120, 30) // target pinned to claude
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	m.writesEnabled = true
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending == nil || m.pending.id != "drift-update" {
		t.Fatal("claude: w should still open the drift-update modal (path unchanged)")
	}
}

// ── selftest stays claude regardless of target ────────────────────────────────

// TestSelftestTargetAgnostic verifies the selftest fetch command takes no target —
// sectionFetchCmd routes both targets to the same fetchSelftestCmd(cliPath) call,
// so selftest never gets scoped to a harness.
func TestSelftestTargetAgnostic(t *testing.T) {
	// fetchSelftestCmd takes only cliPath (a compile-time guarantee): this call would
	// not compile if a target param had been added.
	if cmd := fetchSelftestCmd("unused"); cmd == nil {
		t.Fatal("fetchSelftestCmd should return a non-nil cmd")
	}
	// sectionFetchCmd(viewSelftest, ...) returns non-nil for both targets (it ignores
	// the target arg for the selftest case).
	if sectionFetchCmd(viewSelftest, "unused", "claude") == nil {
		t.Fatal("sectionFetchCmd(viewSelftest, claude) should be non-nil")
	}
	if sectionFetchCmd(viewSelftest, "unused", "codex") == nil {
		t.Fatal("sectionFetchCmd(viewSelftest, codex) should be non-nil")
	}
}

// ── status bar surfaces the target indicator + T hint ─────────────────────────

// TestStatusBarShowsTargetIndicator verifies the bottom bar shows a PERSISTENT
// target badge naming the active harness — both claude and codex (not codex-only).
func TestStatusBarShowsTargetIndicator(t *testing.T) {
	m := loadedModel(120, 30)
	if out := statusBarView(m); !strings.Contains(out, tr("status.targetClaude")) {
		t.Fatalf("claude bar should show the claude badge %q:\n%s", tr("status.targetClaude"), out)
	}
	m.target = "codex"
	if out := statusBarView(m); !strings.Contains(out, tr("status.targetCodex")) {
		t.Fatalf("codex bar should show the codex badge %q:\n%s", tr("status.targetCodex"), out)
	}
}

// TestTKeyCaseInsensitive verifies both lowercase t and uppercase T flip the target
// (case-insensitive like the H/D/S tab jumps).
func TestTKeyCaseInsensitive(t *testing.T) {
	for _, key := range []string{"t", "T"} {
		m := loadedModel(120, 30)
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)})
		if got := mm.(model).target; got != "codex" {
			t.Errorf("%q should flip claude→codex, got %q", key, got)
		}
	}
}

// TestStatusBarFitsOneLineAt120 pins the Medium-fix invariant: the status bar must
// stay a SINGLE line at the canonical 120-col width across the target × write-mode ×
// tab combinations that previously pushed it to two lines. The persistent target
// badge and the x-delete hint are shown under BOTH targets; the width clip
// (MaxWidth(m.width-2) in statusBarView) is what holds the bar to one line.
func TestStatusBarFitsOneLineAt120(t *testing.T) {
	cases := []struct {
		name   string
		target string
		writes bool
		view   viewID
	}{
		{"claude/writesOff/inv", "claude", false, viewInventory},
		{"codex/writesOff/inv", "codex", false, viewInventory},
		{"claude/writesOn/inv", "claude", true, viewInventory},
		{"codex/writesOn/inv", "codex", true, viewInventory},
	}
	for _, c := range cases {
		m := loadedModel(120, 30)
		m.target = c.target
		m.writesEnabled = c.writes
		m.currentView = c.view
		if h := lipgloss.Height(statusBarView(m)); h != 1 {
			t.Errorf("%s: status bar is %d lines at width 120, want 1", c.name, h)
		}
	}
}

// TestCodexShowsDeleteHint verifies the "x delete" hint is advertised under BOTH
// targets on Inventory with write mode on — slice 2a makes codex remove live, so
// advertising it under codex is now honest (the slice-1 suppression is gone).
func TestCodexShowsDeleteHint(t *testing.T) {
	// Wide enough that the persistent target badge + the x-delete hint both fit
	// without the width clip dropping the rightmost hint.
	m := loadedModel(160, 30)
	m.writesEnabled = true
	m.currentView = viewInventory
	if out := statusBarView(m); !strings.Contains(out, tr("write.remove.hint")) {
		t.Fatalf("claude Inventory+writes should advertise the x-delete hint:\n%s", out)
	}
	m.target = "codex"
	if out := statusBarView(m); !strings.Contains(out, tr("write.remove.hint")) {
		t.Errorf("codex Inventory+writes should ALSO advertise the x-delete hint (remove is live in slice 2a):\n%s", out)
	}
}

// ── eagerSectionViews mirrors initialModel's eager sections ────────────────────

// TestEagerSectionViewsMatchInitialModel guards the invariant that switchTarget
// re-fetches exactly the sections initialModel loads up front (loading:true). A
// drift would leave a badge stale after a target switch (eager section never
// re-armed) or double-fetch a lazy one.
func TestEagerSectionViewsMatchInitialModel(t *testing.T) {
	m := initialModel("unused")
	want := map[viewID]bool{}
	for v, st := range m.sections {
		if st != nil && st.loading {
			want[v] = true
		}
	}
	if len(want) != len(eagerSectionViews) {
		t.Fatalf("eagerSectionViews has %d entries, initialModel loads %d eagerly", len(eagerSectionViews), len(want))
	}
	for _, v := range eagerSectionViews {
		if !want[v] {
			t.Errorf("eagerSectionViews lists %v but initialModel does not load it eagerly", v)
		}
	}
}

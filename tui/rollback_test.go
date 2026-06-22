package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// Real-shaped `rollback <id> --format json` dry-run envelopes, trimmed to the
// fields the TUI decodes.

const rollbackCleanJSON = `{"result":{"status":"dry-run","ok":true,"dryRun":true,"driftClean":true,"snapshotId":"2026-06-21T16-41-23Z"},"diagnostics":[{"severity":"info","code":"rollback-writes-disabled","message":"dry-run: pass --apply to perform the rollback"}],"version":1}`

const rollbackDriftJSON = `{"result":{"status":"refused-drift","ok":false,"dryRun":true,"driftClean":false,"snapshotId":"2026-06-21T16-41-23Z"},"diagnostics":[{"severity":"warn","code":"rollback-drift-detected","message":"live tree drifted: 1 file(s) changed since capture"},{"severity":"warn","code":"rollback-refused-drift","message":"refusing to roll back without --force"}],"version":1}`

const rollbackCorruptJSON = `{"result":{"status":"archive-corrupt","ok":false,"dryRun":true,"driftClean":true,"snapshotId":"2026-06-21T16-41-23Z"},"diagnostics":[{"severity":"error","code":"rollback-archive-corrupt","message":"archive failed verification; aborting before touching the live tree"}],"version":1}`

// loadSnapshotsModel returns a model on the Snapshots tab with the sample list
// (sampleSnapshots, defined in snapshots_test.go) loaded — both the section list
// and m.snapshotData are populated via snapshotsMsg.
func loadSnapshotsModel(t *testing.T) model {
	t.Helper()
	m := loadedModel(120, 30)
	mm, _ := m.Update(snapshotsMsg{data: sampleSnapshots()})
	m = mm.(model)
	m.currentView = viewSnapshots
	return m
}

// ── parseRollback ──────────────────────────────────────────────────────────

func TestParseRollbackClean(t *testing.T) {
	r, _, err := parseRollback([]byte(rollbackCleanJSON))
	if err != nil {
		t.Fatalf("parseRollback error: %v", err)
	}
	if r.Status != "dry-run" || !r.DriftClean || !r.Ok {
		t.Fatalf("clean parse = %+v", r)
	}
}

func TestParseRollbackDrift(t *testing.T) {
	r, diags, err := parseRollback([]byte(rollbackDriftJSON))
	if err != nil {
		t.Fatalf("parseRollback error: %v", err)
	}
	if r.Status != "refused-drift" || r.DriftClean {
		t.Fatalf("drift parse = %+v", r)
	}
	if len(diags) != 2 {
		t.Fatalf("want 2 diags, got %d", len(diags))
	}
}

func TestParseRollbackMalformed(t *testing.T) {
	if _, _, err := parseRollback([]byte("nope")); err == nil {
		t.Fatal("parseRollback should error on malformed JSON")
	}
}

// ── snapshotApplied (safety-snapshot self-check) ───────────────────────────

func TestSnapshotApplied(t *testing.T) {
	cases := []struct {
		name string
		json string
		want bool
	}{
		{"captured", `{"result":{"ok":true,"snapshotId":"2026-06-22T00-00-00Z"}}`, true},
		{"gate-unavailable", `{"result":{"ok":false,"snapshotId":null}}`, false}, // exit 0 but nothing written
		{"ok-but-no-id", `{"result":{"ok":true,"snapshotId":""}}`, false},
		{"malformed", `not json`, false},
	}
	for _, c := range cases {
		if got := snapshotApplied([]byte(c.json)); got != c.want {
			t.Errorf("%s: snapshotApplied = %v, want %v", c.name, got, c.want)
		}
	}
}

// ── refusal helpers ────────────────────────────────────────────────────────

func TestFirstProblemMessage(t *testing.T) {
	diags := []Diagnostic{
		{Severity: "info", Message: "skip"},
		{Severity: "warn", Message: "the real problem"},
	}
	if got := firstProblemMessage(diags); got != "the real problem" {
		t.Fatalf("firstProblemMessage = %q", got)
	}
	if got := firstProblemMessage(nil); got != "" {
		t.Fatalf("firstProblemMessage(nil) = %q", got)
	}
}

func TestRollbackRefusalErrorUsesDiag(t *testing.T) {
	_, diags, _ := parseRollback([]byte(rollbackCorruptJSON))
	err := rollbackRefusalError(diags, "archive-corrupt")
	if err == nil || !strings.Contains(err.Error(), "verification") {
		t.Fatalf("rollbackRefusalError = %v", err)
	}
}

func TestRollbackRefusalErrorFallback(t *testing.T) {
	err := rollbackRefusalError(nil, "drift-error")
	if err == nil || !strings.Contains(err.Error(), "drift-error") {
		t.Fatalf("fallback should include the status, got %v", err)
	}
}

// ── buildRollbackAction ────────────────────────────────────────────────────

func TestBuildRollbackAction(t *testing.T) {
	a := buildRollbackAction(rollbackInfo{id: "X", reason: "r", fileCount: 7, drifted: true})
	if a.id != "rollback" {
		t.Fatalf("id = %q", a.id)
	}
	if a.rollback == nil || !a.rollback.drifted || a.rollback.id != "X" {
		t.Fatal("rollback info not carried")
	}
	if a.run == nil {
		t.Fatal("run (the orchestration) must be set for a rollback action")
	}
	if len(a.args) != 0 {
		t.Fatalf("rollback uses run, not args; got args %v", a.args)
	}
}

// ── rollbackConfirmText ────────────────────────────────────────────────────

func TestRollbackConfirmTextClean(t *testing.T) {
	title, body := rollbackConfirmText(rollbackInfo{id: "X", reason: "enable ecc", fileCount: 683, drifted: false})
	if title != tr("write.rollback.title") {
		t.Fatalf("title = %q", title)
	}
	if strings.Contains(body, tr("write.rollback.driftWarn")) {
		t.Fatalf("clean rollback must not show the drift warning:\n%s", body)
	}
	for _, want := range []string{"683", tr("write.rollback.autoSnapshot")} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestRollbackConfirmTextDriftedWarns(t *testing.T) {
	_, body := rollbackConfirmText(rollbackInfo{id: "X", reason: "r", fileCount: 683, drifted: true})
	if !strings.Contains(body, tr("write.rollback.driftWarn")) {
		t.Fatalf("drifted rollback must lead with the drift warning:\n%s", body)
	}
}

// ── selectedSnapshot ───────────────────────────────────────────────────────

func TestSelectedSnapshotResolvesById(t *testing.T) {
	m := loadSnapshotsModel(t)
	snap, ok := m.selectedSnapshot()
	if !ok {
		t.Fatal("selectedSnapshot should resolve the first row")
	}
	if snap.Id != "2026-06-21T16-41-23Z" || snap.FileCount != 683 {
		t.Fatalf("resolved the wrong snapshot: %+v", snap)
	}
}

func TestSelectedSnapshotEmptyTab(t *testing.T) {
	m := loadedModel(120, 30) // no snapshotsMsg → empty Snapshots list
	m.currentView = viewSnapshots
	if _, ok := m.selectedSnapshot(); ok {
		t.Fatal("selectedSnapshot should be false on an empty tab")
	}
}

// ── w key on the Snapshots tab ─────────────────────────────────────────────

func TestWOnSnapshotsLaunchesPreflight(t *testing.T) {
	m := loadSnapshotsModel(t)
	m.writesEnabled = true
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if !m.writeRunning {
		t.Fatal("writeRunning should be true while the rollback preflight runs")
	}
	if m.pending != nil {
		t.Fatal("pending must stay nil until the preflight returns")
	}
	if cmd == nil {
		t.Fatal("w on a snapshot row should return the preflight cmd")
	}
}

func TestWOnSnapshotsEmptyShowsHint(t *testing.T) {
	m := loadedModel(120, 30) // empty Snapshots list
	m.currentView = viewSnapshots
	m.writesEnabled = true
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending must stay nil with no selectable snapshot")
	}
	if !strings.Contains(m.writeStatus, tr("write.rollback.selectHint")) {
		t.Fatalf("expected the select-a-snapshot hint, got %q", m.writeStatus)
	}
}

// ── rollbackPrepMsg / rollbackResultMsg handling ───────────────────────────

func TestRollbackPrepMsgOpensModal(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	a := buildRollbackAction(rollbackInfo{id: "X", reason: "r", fileCount: 683})
	mm, _ := m.Update(rollbackPrepMsg{action: a})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should clear when the preflight resolves")
	}
	if m.pending == nil || m.pending.id != "rollback" {
		t.Fatal("a clean preflight should open the rollback modal")
	}
}

func TestRollbackPrepMsgErrorShowsStatus(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(rollbackPrepMsg{err: errFmt("archive failed verification")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("a non-rollbackable preflight must NOT open a modal")
	}
	if m.writeOK || !strings.Contains(m.writeStatus, "verification") {
		t.Fatalf("expected a failure status with the engine message, got ok=%v %q", m.writeOK, m.writeStatus)
	}
}

func TestRollbackResultSuccessRefetches(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, cmd := m.Update(rollbackResultMsg{err: nil})
	m = mm.(model)
	if !m.writeOK || m.writeStatus != tr("write.rollback.done") {
		t.Fatalf("status = %q (ok=%v), want %q", m.writeStatus, m.writeOK, tr("write.rollback.done"))
	}
	if cmd == nil {
		t.Fatal("a successful rollback should refetch counts + the snapshot list")
	}
}

func TestRollbackResultFailure(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(rollbackResultMsg{err: errFmt("safety snapshot failed; rollback aborted")})
	m = mm.(model)
	if m.writeOK {
		t.Fatal("writeOK should be false on a rollback failure")
	}
	if !strings.Contains(m.writeStatus, "aborted") {
		t.Fatalf("writeStatus %q should carry the failure", m.writeStatus)
	}
}

// ── confirm modal render ───────────────────────────────────────────────────

func TestConfirmViewRendersRollbackClean(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildRollbackAction(rollbackInfo{id: "2026-06-21T16-41-23Z", reason: "enable ecc", fileCount: 683, drifted: false})
	m.pending = &a
	out := m.View()
	if !strings.Contains(out, tr("write.rollback.title")) {
		t.Fatalf("rollback modal missing title:\n%s", out)
	}
	if !strings.Contains(out, "683") {
		t.Fatalf("rollback modal missing file count:\n%s", out)
	}
	if strings.Contains(out, "OVERWRITE") {
		t.Fatalf("a clean rollback must not show the OVERWRITE warning:\n%s", out)
	}
}

func TestConfirmViewRendersRollbackDriftWarning(t *testing.T) {
	m := loadedModel(120, 30)
	a := buildRollbackAction(rollbackInfo{id: "X", reason: "r", fileCount: 683, drifted: true})
	m.pending = &a
	out := m.View()
	if !strings.Contains(out, "OVERWRITE") {
		t.Fatalf("a drifted rollback must show the OVERWRITE warning:\n%s", out)
	}
}

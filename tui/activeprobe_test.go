package main

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── activeProbeAction shape ───────────────────────────────────────────────────

func TestActiveProbeActionShape(t *testing.T) {
	wa := activeProbeAction()
	if wa.id != "doctor-active-probes" {
		t.Fatalf("id = %q, want %q", wa.id, "doctor-active-probes")
	}
	if wa.run == nil {
		t.Fatal("run should be non-nil")
	}
	if len(wa.args) != 0 {
		t.Fatalf("args = %v, want empty", wa.args)
	}
}

// ── "a" key on Doctor tab, writes OFF → hint, no modal ───────────────────────

func TestAKeyDoctorWritesOffShowsHint(t *testing.T) {
	m := loadedModel(120, 30)
	// Switch to viewDoctor (tab 7, key "7").
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	if m.currentView != viewDoctor {
		t.Fatalf("currentView = %v, want viewDoctor", m.currentView)
	}
	// writesEnabled defaults to false.
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should be nil when writes are off")
	}
	want := tr("write.activeProbe.disabled")
	if m.writeStatus != want {
		t.Fatalf("writeStatus = %q, want %q", m.writeStatus, want)
	}
}

// ── "a" key on Doctor tab, writes ON → modal opens ───────────────────────────

func TestAKeyDoctorWritesOnOpensConfirm(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("7")})
	m = mm.(model)
	m.writesEnabled = true
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	m = mm.(model)
	if m.pending == nil {
		t.Fatal("pending should be non-nil after a on Doctor tab with writes on")
	}
	if m.pending.id != "doctor-active-probes" {
		t.Fatalf("pending.id = %q, want %q", m.pending.id, "doctor-active-probes")
	}
}

// ── "a" key on non-Doctor tab → no-op ────────────────────────────────────────

func TestAKeyNonDoctorNoop(t *testing.T) {
	m := loadedModel(120, 30)
	// stays on viewInventory (the default).
	m.writesEnabled = true
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should be nil on non-Doctor tab")
	}
}

// ── confirming active probe dispatches the run cmd ────────────────────────────

func TestActiveProbeConfirmDispatches(t *testing.T) {
	m := loadedModel(120, 30)
	wa := activeProbeAction()
	m.pending = &wa
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should be nil after y confirm")
	}
	if !m.writeRunning {
		t.Fatal("writeRunning should be true after y confirm")
	}
	if cmd == nil {
		t.Fatal("returned cmd should be non-nil (the active probe command)")
	}
}

// ── doctorMsg clears writeRunning ─────────────────────────────────────────────

func TestDoctorMsgClearsWriteRunning(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(doctorMsg{data: sampleDoctorReport()})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should be false after doctorMsg")
	}
}

// ── active-probe success sets the green "done" toast ─────────────────────────

// TestActiveProbeSuccessToast: a doctorMsg arriving while writeRunning is true (the
// confirmed active-probe path) sets the green "done" status-bar toast — parity with
// the drift write-action's writeResultMsg success feedback.
func TestActiveProbeSuccessToast(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(doctorMsg{data: sampleDoctorReport()})
	m = mm.(model)
	if m.writeStatus != tr("write.activeProbe.done") {
		t.Fatalf("writeStatus = %q, want %q", m.writeStatus, tr("write.activeProbe.done"))
	}
	if !m.writeOK {
		t.Fatal("writeOK should be true after a successful active-probe run")
	}
}

// ── active-probe failure surfaces a red error toast ──────────────────────────

// TestActiveProbeFailureToast: a doctorMsg carrying an error while writeRunning is
// true sets a red failure toast, mirroring the drift writeResultMsg error path.
func TestActiveProbeFailureToast(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	mm, _ := m.Update(doctorMsg{err: errors.New("boom")})
	m = mm.(model)
	if !strings.Contains(m.writeStatus, tr("write.failed")) {
		t.Fatalf("writeStatus = %q, want it to contain %q", m.writeStatus, tr("write.failed"))
	}
	if m.writeOK {
		t.Fatal("writeOK should be false after a failed active-probe run")
	}
}

// ── passive doctorMsg stays silent (no toast) ────────────────────────────────

// TestPassiveDoctorMsgNoToast: a doctorMsg from the passive fetch (startup / "r"
// refresh, where writeRunning was never set) must NOT set a status-bar toast — the
// wasActiveRun guard keeps passive refreshes silent.
func TestPassiveDoctorMsgNoToast(t *testing.T) {
	m := loadedModel(120, 30)
	// writeRunning defaults to false (a passive refresh).
	mm, _ := m.Update(doctorMsg{data: sampleDoctorReport()})
	m = mm.(model)
	if m.writeStatus != "" {
		t.Fatalf("writeStatus = %q, want empty (passive refresh must stay silent)", m.writeStatus)
	}
}

// ── regression: drift confirm still uses runWriteCmd path ────────────────────

// TestDriftConfirmStillUsesWriteResultPath guards that the run-generalization
// did not break the drift-update flow. drift-update has run==nil, so its
// confirm must still go through runWriteCmd (returning a writeResultMsg path),
// not the custom run path.
func TestDriftConfirmStillUsesWriteResultPath(t *testing.T) {
	m := loadedModel(120, 30)
	wa, ok := writeActionFor(viewDrift)
	if !ok {
		t.Fatal("writeActionFor(viewDrift) returned ok=false")
	}
	// Drift's run field must be nil (uses runWriteCmd).
	if wa.run != nil {
		t.Fatal("drift writeAction.run should be nil (uses runWriteCmd path)")
	}
	m.pending = &wa
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should be nil after y confirm")
	}
	if !m.writeRunning {
		t.Fatal("writeRunning should be true after y confirm on drift")
	}
	if cmd == nil {
		t.Fatal("returned cmd should be non-nil")
	}
}

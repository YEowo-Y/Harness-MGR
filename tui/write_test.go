package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── writeActionFor registry ───────────────────────────────────────────────────

func TestWriteActionForDrift(t *testing.T) {
	wa, ok := writeActionFor(viewDrift)
	if !ok {
		t.Fatal("writeActionFor(viewDrift) returned ok=false, want true")
	}
	if wa.id != "drift-update" {
		t.Fatalf("id = %q, want %q", wa.id, "drift-update")
	}
	hasUpdate := false
	for _, arg := range wa.args {
		if arg == "--update" {
			hasUpdate = true
		}
	}
	if !hasUpdate {
		t.Fatalf("args %v missing --update", wa.args)
	}
	if wa.refetch == nil {
		t.Fatal("refetch should be non-nil")
	}
}

func TestWriteActionForNonWriteTabs(t *testing.T) {
	// Every tab EXCEPT viewDrift must have no write action — guards against a
	// future Phase-3 entry being wired to the wrong tab.
	for v := viewInventory; v < tabCount; v++ {
		if v == viewDrift {
			continue
		}
		if _, ok := writeActionFor(v); ok {
			t.Errorf("writeActionFor(%v) returned ok=true, want false", v)
		}
	}
}

func TestWriteArgsNeverContainSnapshotRollbackApply(t *testing.T) {
	wa, _ := writeActionFor(viewDrift)
	forbidden := []string{"snapshot", "rollback", "apply"}
	for _, arg := range wa.args {
		for _, f := range forbidden {
			if arg == f {
				t.Errorf("drift action args contain forbidden Phase-3 verb %q", f)
			}
		}
	}
}

// ── w key opens confirm modal ─────────────────────────────────────────────────

func TestWKeyOpensConfirmOnDrift(t *testing.T) {
	m := loadedModel(120, 30)
	// Switch to viewDrift (tab 9, key "9").
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	if m.currentView != viewDrift {
		t.Fatalf("currentView = %v, want viewDrift", m.currentView)
	}
	m.writesEnabled = true // opt-in gate must be on for w to open the modal
	// Press "w".
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending == nil {
		t.Fatal("pending should be non-nil after w on viewDrift")
	}
	if m.pending.id != "drift-update" {
		t.Fatalf("pending.id = %q, want %q", m.pending.id, "drift-update")
	}
}

func TestWKeyNoopOnInventory(t *testing.T) {
	m := loadedModel(120, 30)
	if m.currentView != viewInventory {
		t.Fatalf("expected viewInventory after loadedModel, got %v", m.currentView)
	}
	m.writesEnabled = true // enable writes so absence of action is due to no-action, not the gate
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending should remain nil after w on viewInventory")
	}
}

// TestWKeyNoopWhileWriteRunning is the re-entrancy guard: once a write is in
// flight (writeRunning, pending already nil), pressing "w" must NOT open a second
// confirm modal — otherwise a second concurrent drift --update could be started.
func TestWKeyNoopWhileWriteRunning(t *testing.T) {
	m := loadedModel(120, 30)
	// Land on the Drift tab, where "w" would otherwise open the modal.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	m.writesEnabled = true // enable writes so the re-entrancy guard is what blocks, not the gate
	m.writeRunning = true  // a write is in flight
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("pending must stay nil: w is a no-op while a write is in flight")
	}
}

// ── confirm modal key handling ────────────────────────────────────────────────

func TestConfirmCancelKeys(t *testing.T) {
	cancelKeys := []tea.KeyMsg{
		{Type: tea.KeyRunes, Runes: []rune("n")},
		{Type: tea.KeyEsc},
		{Type: tea.KeyRunes, Runes: []rune("q")},
	}
	for _, key := range cancelKeys {
		m := loadedModel(120, 30)
		wa, _ := writeActionFor(viewDrift)
		m.pending = &wa
		mm, _ := m.Update(key)
		m = mm.(model)
		if m.pending != nil {
			t.Errorf("key %q: pending should be nil after cancel, got non-nil", key.String())
		}
	}
}

func TestConfirmYesStartsWriteAndClearsPending(t *testing.T) {
	m := loadedModel(120, 30)
	wa, _ := writeActionFor(viewDrift)
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
		t.Fatal("returned cmd should be non-nil (the write command)")
	}
}

func TestConfirmModalSwallowsOtherKeys(t *testing.T) {
	m := loadedModel(120, 30)
	wa, _ := writeActionFor(viewDrift)
	m.pending = &wa
	prevView := m.currentView
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	if m.pending == nil {
		t.Fatal("pending should remain non-nil (key swallowed by modal)")
	}
	if m.currentView != prevView {
		t.Fatalf("currentView changed from %v to %v, should be unchanged", prevView, m.currentView)
	}
}

// ── writeResultMsg handling ───────────────────────────────────────────────────

func TestWriteResultSuccess(t *testing.T) {
	m := loadedModel(120, 30)
	wa, _ := writeActionFor(viewDrift)
	mm, cmd := m.Update(writeResultMsg{action: wa, err: nil})
	m = mm.(model)
	if m.writeRunning {
		t.Fatal("writeRunning should be false after result")
	}
	if !m.writeOK {
		t.Fatal("writeOK should be true on success")
	}
	want := tr("write.drift.done")
	if m.writeStatus != want {
		t.Fatalf("writeStatus = %q, want %q", m.writeStatus, want)
	}
	if cmd == nil {
		t.Fatal("returned cmd should be non-nil (the refetch)")
	}
}

func TestWriteResultFailure(t *testing.T) {
	m := loadedModel(120, 30)
	wa, _ := writeActionFor(viewDrift)
	mm, _ := m.Update(writeResultMsg{action: wa, err: errFmt("boom")})
	m = mm.(model)
	if m.writeOK {
		t.Fatal("writeOK should be false on error")
	}
	if !strings.Contains(m.writeStatus, "boom") {
		t.Fatalf("writeStatus %q should contain %q", m.writeStatus, "boom")
	}
	if !strings.Contains(m.writeStatus, tr("write.failed")) {
		t.Fatalf("writeStatus %q should contain %q", m.writeStatus, tr("write.failed"))
	}
}

// ── writeStatus cleared on next key ──────────────────────────────────────────

func TestWriteStatusClearedOnNextKey(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeStatus = "x"
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	m = mm.(model)
	if m.writeStatus != "" {
		t.Fatalf("writeStatus should be cleared on next key, got %q", m.writeStatus)
	}
}

// ── confirmView renders title, body, prompt ───────────────────────────────────

func TestConfirmViewRendersTitleBodyPrompt(t *testing.T) {
	m := loadedModel(120, 30)
	wa, _ := writeActionFor(viewDrift)
	m.pending = &wa
	out := m.View()
	if !strings.Contains(out, tr("write.drift.title")) {
		t.Fatalf("confirm view missing title %q:\n%s", tr("write.drift.title"), out)
	}
	if !strings.Contains(out, tr("write.confirmYes")) {
		t.Fatalf("confirm view missing confirmYes %q:\n%s", tr("write.confirmYes"), out)
	}
	if !strings.Contains(out, tr("write.confirmNo")) {
		t.Fatalf("confirm view missing confirmNo %q:\n%s", tr("write.confirmNo"), out)
	}
}

// ── statusBarView shows write hint on Drift tab ───────────────────────────────

func TestStatusBarShowsWriteHintOnDrift(t *testing.T) {
	m := loadedModel(120, 30)
	// Switch to Drift tab with writes enabled — hint only shows when mode is on.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")})
	m = mm.(model)
	m.writesEnabled = true
	out := statusBarView(m)
	if !strings.Contains(out, tr("write.drift.hint")) {
		t.Fatalf("status bar on Drift missing write hint %q:\n%s", tr("write.drift.hint"), out)
	}

	// Inventory tab should NOT show the write hint (no write action, regardless of mode).
	m2 := loadedModel(120, 30)
	m2.writesEnabled = true
	out2 := statusBarView(m2)
	if strings.Contains(out2, tr("write.drift.hint")) {
		t.Fatalf("status bar on Inventory should not contain write hint %q:\n%s", tr("write.drift.hint"), out2)
	}
}

// ── anyLoading includes writeRunning ─────────────────────────────────────────

func TestAnyLoadingIncludesWriteRunning(t *testing.T) {
	m := loadedModel(120, 30)
	m.writeRunning = true
	if !m.anyLoading() {
		t.Fatal("anyLoading() should be true when writeRunning is true")
	}
}

// ── opt-in write mode gate + W toggle ────────────────────────────────────────

func TestWKeyDisabledWhenWritesOff(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")}) // viewDrift
	m = mm.(model)
	// writesEnabled defaults to false in loadedModel.
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending != nil {
		t.Fatal("w must not open the modal while write mode is off")
	}
	if !strings.Contains(m.writeStatus, tr("write.disabledHint")) {
		t.Fatalf("expected the disabled hint, got writeStatus=%q", m.writeStatus)
	}
}

func TestWToggleEnablesDisablesAndPersists(t *testing.T) {
	m := loadedModel(120, 30)
	if m.writesEnabled {
		t.Fatal("writesEnabled should default to false")
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("W")})
	m = mm.(model)
	if !m.writesEnabled {
		t.Fatal("W should enable write mode")
	}
	if m.writeStatus != tr("write.modeOn") {
		t.Fatalf("writeStatus=%q, want %q", m.writeStatus, tr("write.modeOn"))
	}
	if cmd == nil {
		t.Fatal("W should return a (persist) cmd")
	}
	mm, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("W")})
	m = mm.(model)
	if m.writesEnabled {
		t.Fatal("second W should disable write mode")
	}
	if m.writeStatus != tr("write.modeOff") {
		t.Fatalf("writeStatus=%q, want %q", m.writeStatus, tr("write.modeOff"))
	}
	if cmd == nil {
		t.Fatal("second W (disable) should also return a (persist) cmd")
	}
}

func TestWKeyOpensModalWhenWritesOn(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("9")}) // viewDrift
	m = mm.(model)
	m.writesEnabled = true
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("w")})
	m = mm.(model)
	if m.pending == nil || m.pending.id != "drift-update" {
		t.Fatal("w should open the drift-update modal when write mode is on")
	}
}

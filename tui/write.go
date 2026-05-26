package main

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── Confirm-gated write actions (Phase A) ──────────────────────────────────
//
// The TUI is read-only by default. A writeAction is the single, explicit path by
// which a key press can run a state-changing CLI command — and only after the
// user confirms it in a modal. Phase A wires exactly ONE action: `drift --update`,
// which writes only the .mgr-state lockfile (gate-safe). The engine's
// assertWritable gate is the real safety boundary regardless of caller; this modal
// is the explicit-consent UX guard. Phase-3 writes (snapshot / rollback / apply)
// become additional entries in writeActionFor behind the SAME modal + runWriteCmd
// pipeline — they are deliberately NOT added here (they sit behind the 30-day
// stability gate).
//
// SAFETY: each action's args are hardcoded constants — no user input ever reaches
// the command line, so there is no injection surface.

// writeAction describes one confirm-gated write. titleKey/bodyKey/doneKey/hintKey
// are i18n keys resolved at render time; args is the exact CLI argv; refetch is the
// READ command re-run after a successful write so the UI reflects it.
type writeAction struct {
	id       string
	titleKey string
	bodyKey  string
	doneKey  string
	hintKey  string
	args     []string
	refetch  func(cliPath string) tea.Cmd
	// run, when non-nil, is the on-confirm command used INSTEAD of the default
	// runWriteCmd(args) path — for a confirmed action whose result is handled by a
	// specific msg (e.g. active probes → doctorMsg) rather than a writeResultMsg.
	run func(cliPath string) tea.Cmd
}

// writeActionFor returns the write action available on view v, or ok=false when the
// tab has none. This registry is the single extension point Phase 3 will grow.
func writeActionFor(v viewID) (writeAction, bool) {
	switch v {
	case viewDrift:
		return writeAction{
			id:       "drift-update",
			titleKey: "write.drift.title",
			bodyKey:  "write.drift.body",
			doneKey:  "write.drift.done",
			hintKey:  "write.drift.hint",
			args:     []string{"drift", "--update", "--format", "json"},
			refetch:  fetchDriftCmd,
		}, true
	default:
		return writeAction{}, false
	}
}

// activeProbeAction is the confirm-gated "run the doctor's active probes" action.
// It is NOT in writeActionFor (it is not a per-tab "w" write); it is triggered by
// the Doctor tab's "a" key. run = fetchDoctorActiveCmd, so the confirmed result
// arrives as a doctorMsg and updates the Doctor tab in place.
func activeProbeAction() writeAction {
	return writeAction{
		id:       "doctor-active-probes",
		titleKey: "write.activeProbe.title",
		bodyKey:  "write.activeProbe.body",
		hintKey:  "write.activeProbe.hint",
		run:      fetchDoctorActiveCmd,
	}
}

// writeResultMsg carries the outcome of a confirm-gated write action.
type writeResultMsg struct {
	action writeAction
	err    error
}

// runWriteCmd runs the action's hardcoded CLI command (a state-changing write) and
// reports a writeResultMsg. stdout is discarded — the subsequent refetch re-reads
// authoritative state. This is the ONLY function that runs a write, and it is
// reached ONLY from the confirm modal's y/enter branch.
func runWriteCmd(cliPath string, a writeAction) tea.Cmd {
	return func() tea.Msg {
		_, err := runJSON(cliPath, a.args...)
		return writeResultMsg{action: a, err: err}
	}
}

// confirmView renders the centered confirm modal for m.pending, mirroring
// helpView's overlay. An amber border + title signal a state-changing action.
func confirmView(m model) string {
	width, height := m.width, m.height
	if width < 1 || height < 1 {
		return ""
	}
	if m.pending == nil {
		return dashboardView(m)
	}
	a := m.pending

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorOrange)
	bodyStyle := lipgloss.NewStyle().Foreground(labelGray)
	dim := lipgloss.NewStyle().Foreground(statusDim)
	gap := lipgloss.NewStyle().Foreground(tabDim).Render("   ")

	const modalInner = 56
	body := bodyStyle.Width(modalInner).Render(tr(a.bodyKey))
	prompt := keyStyle.Render("y") + dim.Render(" "+tr("write.confirmYes")) +
		gap + keyStyle.Render("n") + dim.Render(" "+tr("write.confirmNo"))

	var b strings.Builder
	b.WriteString(titleStyle.Render(glyph("✎", "!") + " " + tr(a.titleKey)))
	b.WriteString("\n\n")
	b.WriteString(body)
	b.WriteString("\n\n")
	b.WriteString(prompt)

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorOrange).
		Padding(1, 3).
		Render(b.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

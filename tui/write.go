package main

import (
	"errors"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── Confirm-gated write actions ────────────────────────────────────────────
//
// The TUI is read-only by default. A writeAction is the single, explicit path by
// which a key press can run a state-changing CLI command — and only after the
// user confirms it in a modal. Two kinds of action exist:
//
//   - Tab-level, target-LESS actions registered in writeActionFor: `drift
//     --update` (writes only the .mgr-state lockfile) + the Doctor active probes.
//     Their args are hardcoded constants — no user input reaches the command line.
//   - The Inventory tab's per-plugin enable/disable (preparePluginToggleCmd +
//     buildPluginToggleAction): a TARGETED config write. The selected plugin's
//     key flows into the argv (via the engine's exec, NOT a shell, so there is no
//     injection surface), and a DRY-RUN preview is shown in the modal before the
//     real --apply. The engine validates the key, is dry-run by default, and
//     auto-snapshots every write so rollback can undo it.
//
// The engine's assertWritable gate is the real safety boundary regardless of
// caller; this modal is the explicit-consent UX guard. Snapshot / rollback writes
// are still deliberately NOT wired into the TUI.

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
	// plugin, when non-nil, marks a per-plugin enable/disable action: confirmView
	// composes its title/body from this preview (resolved at render time, so no
	// i18n runs in the off-thread prepare Cmd). args still hold the real --apply
	// command run on confirm.
	plugin *pluginToggleInfo
}

// pluginToggleInfo carries what the confirm modal needs to describe a resolved
// plugin enable/disable, all derived from the dry-run preview. before/after/line
// are the engine's diff fragments (before is "" for an INSERT). override is true
// when settings.local.json shadows this plugin (so the write to settings.json may
// not change the EFFECTIVE state — surfaced as a caveat).
type pluginToggleInfo struct {
	key      string
	desired  bool // true = enable, false = disable
	before   string
	after    string
	line     int
	override bool
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

// ── Plugin enable/disable (Inventory tab) ──────────────────────────────────

// buildPluginToggleAction builds the confirm-gated apply action from a resolved
// toggle intent. args are the REAL --apply command run on confirm; plugin holds
// the preview confirmView renders. Pure — no exec.
//
// refetch is nil ON PURPOSE: the inventory `enabled` field reflects
// installed_plugins.json, NOT settings.json's enabledPlugins (the authoritative
// signal this writes), so a refetch would show no change AND reset the tree's
// expand/cursor state. The status-bar toast is the feedback instead.
func buildPluginToggleAction(info pluginToggleInfo) writeAction {
	verb := "disable"
	if info.desired {
		verb = "enable"
	}
	return writeAction{
		id:      "plugin-toggle",
		doneKey: "write.plugin.done",
		hintKey: "write.plugin.hint",
		args:    []string{verb, "--type", "plugin", info.key, "--apply", "--format", "json"},
		plugin:  &info,
	}
}

// pluginToggleOverride reports whether the dry-run diagnostics include the
// settings.local.json precedence caveat (effective state may not change).
func pluginToggleOverride(diags []Diagnostic) bool {
	for _, d := range diags {
		if d.Code == "plugin-toggle-overridden-by-local" {
			return true
		}
	}
	return false
}

// firstErrorMessage returns the first error-severity diagnostic message, or "".
func firstErrorMessage(diags []Diagnostic) string {
	for _, d := range diags {
		if d.Severity == "error" {
			return d.Message
		}
	}
	return ""
}

// refusalError turns a refusal's diagnostics into an error — its first error
// message, or a generic fallback when none is present.
func refusalError(diags []Diagnostic) error {
	if msg := firstErrorMessage(diags); msg != "" {
		return errors.New(msg)
	}
	return errors.New("plugin toggle refused")
}

// preparePluginToggleCmd is the off-thread PROBE half of the plugin confirm-apply
// flow. It dry-runs an `enable` to learn the authoritative settings.json state
// (AlreadyInState ⇒ already enabled), picks the OPPOSITE verb, fetches that
// direction's preview, and returns a pluginToggleMsg with a ready-to-confirm
// action — or an err (refusal / exec failure) the handler surfaces in the status
// bar WITHOUT opening a modal. It NEVER writes (dry-run only); the real write
// happens only after the user confirms the returned action.
func preparePluginToggleCmd(cliPath, key string) tea.Cmd {
	return func() tea.Msg {
		// Probe with an enable dry-run: AlreadyInState ⇒ the plugin is already enabled.
		probe, pdiags, err := fetchPluginToggleDry(cliPath, key, true)
		if err != nil {
			return pluginToggleMsg{err: err}
		}
		if !probe.Ok {
			return pluginToggleMsg{err: refusalError(pdiags)}
		}
		desired := !probe.AlreadyInState // flip whatever the current state is

		preview, diags := probe, pdiags
		if !desired {
			// The probe was an enable; fetch the disable-direction preview instead.
			d, ddiags, derr := fetchPluginToggleDry(cliPath, key, false)
			if derr != nil {
				return pluginToggleMsg{err: derr}
			}
			if !d.Ok {
				return pluginToggleMsg{err: refusalError(ddiags)}
			}
			preview, diags = d, ddiags
		}

		info := pluginToggleInfo{key: key, desired: desired, override: pluginToggleOverride(diags)}
		if preview.Diff != nil {
			info.before, info.after, info.line = preview.Diff.Before, preview.Diff.After, preview.Diff.Line
		}
		return pluginToggleMsg{action: buildPluginToggleAction(info)}
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

// pluginConfirmText composes the confirm modal's title + body for a plugin
// enable/disable from its dry-run preview. The key and diff fragments are engine
// DATA (shown verbatim); only the surrounding prose is translated. Called at
// render time on the UI thread, so reading uiLang via tr/tf is race-free.
func pluginConfirmText(p pluginToggleInfo) (title, body string) {
	if p.desired {
		title = tr("write.plugin.enableTitle")
		body = tf("write.plugin.willEnable", p.key)
	} else {
		title = tr("write.plugin.disableTitle")
		body = tf("write.plugin.willDisable", p.key)
	}
	if p.after != "" {
		change := p.before + "  →  " + p.after
		if p.before == "" {
			change = "+ " + p.after // an INSERT: the key did not exist yet
		}
		body += "\n\n" + tf("write.plugin.change", "settings.json", p.line) + "\n" + change
	}
	body += "\n\n" + tr("write.plugin.reversible")
	if p.override {
		body += "\n\n" + tr("write.plugin.overrideCaveat")
	}
	return title, body
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

	// A plugin-toggle action composes its title/body from the dry-run preview at
	// render time; every other action uses its static i18n keys.
	titleText, bodyText := tr(a.titleKey), tr(a.bodyKey)
	if a.plugin != nil {
		titleText, bodyText = pluginConfirmText(*a.plugin)
	}

	const modalInner = 56
	body := bodyStyle.Width(modalInner).Render(bodyText)
	prompt := keyStyle.Render("y") + dim.Render(" "+tr("write.confirmYes")) +
		gap + keyStyle.Render("n") + dim.Render(" "+tr("write.confirmNo"))

	var b strings.Builder
	b.WriteString(titleStyle.Render(glyph("✎", "!") + " " + titleText))
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

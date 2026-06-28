package main

import (
	"errors"
	"fmt"
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
//   - Tab-level actions registered in writeActionFor: `drift --update` (writes
//     only the .mgr-state lockfile) + the Doctor active probes. Their args are
//     hardcoded constants — no user input reaches the command line — but they are
//     scoped to the active target (drift-update runs under --target codex when the
//     codex harness is active; active probes stay gated to claude).
//   - The Inventory tab's per-plugin enable/disable (preparePluginToggleCmd +
//     buildPluginToggleAction): a TARGETED config write. The selected plugin's
//     key flows into the argv (via the engine's exec, NOT a shell, so there is no
//     injection surface), and a DRY-RUN preview is shown in the modal before the
//     real --apply. The engine validates the key, is dry-run by default, and
//     auto-snapshots every write so rollback can undo it.
//
// The engine's assertWritable gate is the real safety boundary regardless of
// caller; this modal is the explicit-consent UX guard. A standalone `snapshot`
// capture is still not a TUI action (rollback takes its own safety snapshot
// internally before restoring).

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
	refetch  func(cliPath, target string) tea.Cmd
	// run, when non-nil, is the on-confirm command used INSTEAD of the default
	// runWriteCmd(args) path — for a confirmed action whose result is handled by a
	// specific msg (e.g. active probes → doctorMsg) rather than a writeResultMsg.
	// Both refetch and run take the active target so a codex write re-reads / runs
	// under --target codex; the claude default ("") keeps that path byte-identical.
	run func(cliPath, target string) tea.Cmd
	// plugin, when non-nil, marks a per-plugin enable/disable action: confirmView
	// composes its title/body from this preview (resolved at render time, so no
	// i18n runs in the off-thread prepare Cmd). args still hold the real --apply
	// command run on confirm.
	plugin *pluginToggleInfo
	// rollback, when non-nil, marks a snapshot-rollback action: confirmView composes
	// its title/body from this preview and renders the modal in danger (red) styling
	// when the live tree drifted. The on-confirm work runs via the run field (a
	// two-step safety-snapshot-then-rollback orchestration), not args.
	rollback *rollbackInfo
	// skillVis, when non-nil, marks a per-skill visibility action (Inventory tab):
	// confirmView composes its title/body from this preview. args still hold the real
	// --apply command run on confirm. Mirrors the plugin field, but the target state
	// is chosen in the visibility picker before the dry-run runs.
	skillVis *skillVisInfo
	// skillFlip, when non-nil, marks a codex per-skill enable/disable flip (Inventory
	// tab, codex target): confirmView composes its title/body from this preview. args
	// hold the real --apply flip run on confirm. Mirrors the plugin field exactly (a
	// binary toggle whose direction the dry-run probe decides), but writes config.toml
	// [[skills.config]] enabled rather than settings.json enabledPlugins.
	skillFlip *skillFlipInfo
	// remove, when non-nil, marks a component-delete action (Inventory tab):
	// confirmView composes its title/body from this preview AND renders the modal in
	// danger red (a destructive delete). args still hold the real --apply delete run
	// on confirm; refetch is fetchCmd so the deleted row vanishes from the tree.
	remove *removeInfo
}

// rollbackInfo carries what the confirm modal needs to describe a resolved
// snapshot rollback, derived from the dry-run preflight + the selected snapshot.
// drifted is true when the live tree changed since the snapshot was captured (the
// engine would refuse without --force); the modal then warns in red and the apply
// passes --force. fileCount/reason come from the snapshot list (the rollback
// result carries neither).
type rollbackInfo struct {
	id        string
	reason    string
	fileCount int
	drifted   bool
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

// skillVisInfo carries what the confirm modal needs to describe a resolved
// per-skill visibility change, all derived from the dry-run preview. state is the
// chosen engine enum value ("on"|"name-only"|"user-invocable-only"|"off");
// before/after/line are the engine's diff fragments (before is "" for an INSERT
// when the skill has no override yet).
type skillVisInfo struct {
	name   string
	state  string
	before string
	after  string
	line   int
}

// skillFlipInfo carries what the confirm modal needs to describe a resolved codex
// skill enable/disable flip, all derived from the dry-run preview. desired is the
// direction (true = enable, false = disable) the probe picked; before/after/line
// are the engine's config.toml diff fragments (before is "" for an INSERT, though a
// skills.config block always carries enabled so a flip is normally a replace). path
// is "" when the skill resolved by NAME (the apply uses the bare-name positional) or
// the skill's absolute path when it resolved by --path (a path-keyed entry with no
// name block — the apply then selects by --path). name is still the display name in
// the modal either way (it is the skill's name, just not how config.toml keys it).
type skillFlipInfo struct {
	name    string
	path    string
	desired bool
	before  string
	after   string
	line    int
}

// removeInfo carries what the confirm modal needs to describe a resolved component
// delete, derived from the dry-run preview. kind is "skill"|"agent"|"command";
// target is the engine-resolved absolute path (a FILE for agent/command, a whole
// DIRECTORY for skill — the skill case adds a folder warning in the modal). prune is
// true for a codex skill delete that also prunes its orphaned [[skills.config]]
// entries (--prune-config); prunedCount is how many the dry-run reported (shown in
// the modal so the config edits are visible before confirming).
type removeInfo struct {
	kind        string
	name        string
	target      string
	prune       bool
	prunedCount int
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
			// The post-write refetch re-reads drift under the SAME target the write
			// ran against (slice 2a: codex drift-update is live). runWriteCmd appends
			// --target codex to the args above when the active target is codex.
			refetch: func(cli, target string) tea.Cmd { return fetchDriftCmd(cli, target) },
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
		// Active probes stay gated under codex (the "a" entry point no-ops there and
		// the Doctor tab hides the hint), so this run only ever fires under claude.
		// It still forwards target for signature uniformity (codex never reaches it).
		run: func(cli, target string) tea.Cmd { return fetchDoctorActiveCmd(cli, target) },
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
// message, or a generic fallback when none is present. Shared by the plugin
// toggle and the skill-visibility prepare paths, so the fallback is action-neutral
// (the engine always emits an error-severity diagnostic on a real refusal, so the
// fallback is a defensive last resort rather than the usual message).
func refusalError(diags []Diagnostic) error {
	if msg := firstErrorMessage(diags); msg != "" {
		return errors.New(msg)
	}
	return errors.New("write refused")
}

// preparePluginToggleCmd is the off-thread PROBE half of the plugin confirm-apply
// flow. It dry-runs an `enable` to learn the authoritative settings.json state
// (AlreadyInState ⇒ already enabled), picks the OPPOSITE verb, fetches that
// direction's preview, and returns a pluginToggleMsg with a ready-to-confirm
// action — or an err (refusal / exec failure) the handler surfaces in the status
// bar WITHOUT opening a modal. It NEVER writes (dry-run only); the real write
// happens only after the user confirms the returned action.
func preparePluginToggleCmd(cliPath, target, key string) tea.Cmd {
	return func() tea.Msg {
		// Probe with an enable dry-run: AlreadyInState ⇒ the plugin is already enabled.
		probe, pdiags, err := fetchPluginToggleDry(cliPath, target, key, true)
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
			d, ddiags, derr := fetchPluginToggleDry(cliPath, target, key, false)
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

// ── Codex skill enable/disable flip (Inventory tab, codex target) ───────────

// buildSkillFlipAction builds the confirm-gated apply action from a resolved codex
// skill-flip intent. args are the REAL --apply flip run on confirm; skillFlip holds
// the preview confirmView renders. Pure — no exec. Mirrors buildPluginToggleAction.
//
// refetch is nil ON PURPOSE: the inventory tree does not display a codex skill's
// enabled state (it comes from config.toml, not the discovered file), so a refetch
// would show no visible change AND reset the tree's expand/cursor state (same
// reasoning as the plugin/skill-visibility toggles). The status-bar toast is the
// feedback instead.
func buildSkillFlipAction(info skillFlipInfo) writeAction {
	verb := "disable"
	if info.desired {
		verb = "enable"
	}
	// Select by --path for a path-keyed skill (no name block), else by the bare-name
	// positional — the SAME selector the dry-run probe resolved with, so apply targets
	// the exact entry the modal previewed.
	args := []string{verb, "--type", "skill"}
	if info.path != "" {
		args = append(args, "--path", info.path)
	} else {
		args = append(args, info.name)
	}
	args = append(args, "--apply", "--format", "json")
	return writeAction{
		id:        "skill-flip",
		doneKey:   "write.skillFlip.done",
		hintKey:   "write.skillFlip.hint",
		args:      args,
		skillFlip: &info,
	}
}

// toConfigTomlPath converts a discovered skill path to the forward-slash form Codex
// stores in config.toml's [[skills.config]] path entries. The engine's --path skill
// selector compares the path LITERALLY (never normalizes), and inventory paths arrive
// with the OS separator (backslashes on Windows), so a raw Windows path would never
// match a `path = "C:/Users/…"` entry — the flip would refuse despite the entry
// existing. Dogfood-confirmed: the backslash form refuses, the forward-slash form
// resolves. Pure; idempotent on an already-forward-slash path.
func toConfigTomlPath(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// prepareSkillFlipCmd is the off-thread PROBE half of the codex skill-flip
// confirm-apply flow. It dry-runs an `enable` to learn the authoritative
// config.toml state (AlreadyInState ⇒ already enabled), picks the OPPOSITE verb,
// fetches that direction's preview, and returns a skillFlipMsg with a
// ready-to-confirm action — or an err (refusal / exec failure) the handler surfaces
// in the status bar WITHOUT opening a modal. It NEVER writes (dry-run only); the real
// flip happens only after the user confirms the returned action. Mirrors
// preparePluginToggleCmd, but --type skill against config.toml.
//
// SELECTOR: it probes by NAME first (byte-identical to before for a skill that has a
// [[skills.config]] name block). When the name doesn't cleanly resolve — no name
// block, or an ambiguous one — and the row carries an absolute path, it retries by
// --path, the engine's unique disambiguator. This covers the ~51% of codex skills
// that are path-keyed only. selPath tracks which selector won so the direction
// re-probe and the apply args use the SAME one. If neither resolves, the path (or
// name) refusal surfaces as a status-bar toast — fail-closed, no modal.
func prepareSkillFlipCmd(cliPath, target, name, path string) tea.Cmd {
	return func() tea.Msg {
		// Probe with an enable dry-run: AlreadyInState ⇒ the skill is already enabled.
		// Name first; fall back to --path on a name refusal when the row has a path.
		selPath := ""
		probe, pdiags, err := fetchSkillFlipDry(cliPath, target, name, "", true)
		if err != nil {
			return skillFlipMsg{err: err}
		}
		if !probe.Ok && path != "" {
			// config.toml stores forward-slash paths; normalize so the engine's literal
			// --path compare matches (dogfood: the raw backslash form refuses).
			selPath = toConfigTomlPath(path)
			probe, pdiags, err = fetchSkillFlipDry(cliPath, target, "", selPath, true)
			if err != nil {
				return skillFlipMsg{err: err}
			}
		}
		if !probe.Ok {
			return skillFlipMsg{err: refusalError(pdiags)}
		}
		desired := !probe.AlreadyInState // flip whatever the current state is

		preview := probe
		if !desired {
			// The probe was an enable; fetch the disable-direction preview with the
			// SAME selector (selPath != "" ⇒ --path, else the bare name).
			d, ddiags, derr := fetchSkillFlipDry(cliPath, target, name, selPath, false)
			if derr != nil {
				return skillFlipMsg{err: derr}
			}
			if !d.Ok {
				return skillFlipMsg{err: refusalError(ddiags)}
			}
			preview = d
		}

		info := skillFlipInfo{name: name, path: selPath, desired: desired}
		if preview.Diff != nil {
			info.before, info.after, info.line = preview.Diff.Before, preview.Diff.After, preview.Diff.Line
		}
		return skillFlipMsg{action: buildSkillFlipAction(info)}
	}
}

// ── Skill visibility (Inventory tab) ────────────────────────────────────────

// buildSkillVisAction builds the confirm-gated apply action from a resolved
// visibility intent. args are the REAL --apply command run on confirm; skillVis
// holds the preview confirmView renders. Pure — no exec.
//
// refetch is nil ON PURPOSE: the inventory tree does not display a skill's
// visibility, so a refetch would show no visible change AND reset the tree's
// expand/cursor state (same reasoning as the plugin toggle). The status-bar toast
// is the feedback instead.
func buildSkillVisAction(info skillVisInfo) writeAction {
	return writeAction{
		id:       "skill-visibility",
		doneKey:  "write.skillVis.done",
		hintKey:  "write.skillVis.hint",
		args:     []string{"skill", "visibility", info.name, info.state, "--apply", "--format", "json"},
		skillVis: &info,
	}
}

// prepareSkillVisCmd is the off-thread PROBE half of the skill-visibility
// confirm-apply flow. The target state was already chosen in the picker, so it
// dry-runs THAT state directly (no probe-then-flip like the binary plugin
// toggle): AlreadyInState ⇒ a no-op the handler reports as a status-bar toast;
// otherwise it builds a ready-to-confirm action carrying the diff preview. It
// returns a skillVisMsg with an err (refusal / exec failure) the handler surfaces
// in the status bar WITHOUT opening a modal. It NEVER writes (dry-run only); the
// real write happens only after the user confirms the returned action.
func prepareSkillVisCmd(cliPath, name, state string) tea.Cmd {
	return func() tea.Msg {
		preview, diags, err := fetchSkillVisDry(cliPath, name, state)
		if err != nil {
			return skillVisMsg{err: err}
		}
		if !preview.Ok {
			return skillVisMsg{err: refusalError(diags)}
		}
		if preview.AlreadyInState {
			return skillVisMsg{alreadyInState: true, name: name, state: state}
		}
		info := skillVisInfo{name: name, state: state}
		if preview.Diff != nil {
			info.before, info.after, info.line = preview.Diff.Before, preview.Diff.After, preview.Diff.Line
		}
		return skillVisMsg{action: buildSkillVisAction(info)}
	}
}

// ── Component delete / remove (Inventory tab) ───────────────────────────────

// buildRemoveAction builds the confirm-gated DELETE action from a resolved remove
// intent. args are the REAL --apply command run on confirm; remove holds the
// preview confirmView renders in danger red. Pure — no exec.
//
// refetch is fetchCmd (re-reads the inventory) ON PURPOSE — UNLIKE the idempotent
// plugin / skill-visibility toggles whose change is invisible in the tree, a delete
// makes the row VANISH, so re-reading the inventory is the honest feedback that the
// delete succeeded.
func buildRemoveAction(info removeInfo) writeAction {
	// A codex skill delete with prune adds --prune-config so the same atomic snapshot
	// also removes the skill's orphaned [[skills.config]] entries. The flag sits
	// before --apply, mirroring the engine's CLI shape. Plain removes omit it.
	args := []string{"remove", info.kind + ":" + info.name}
	if info.prune {
		args = append(args, "--prune-config")
	}
	args = append(args, "--apply", "--format", "json")
	return writeAction{
		id:      "remove",
		doneKey: "write.remove.done",
		hintKey: "write.remove.hint",
		args:    args,
		remove:  &info,
		// The post-delete refetch re-reads the inventory under the SAME target the
		// delete ran against (slice 2a: codex remove is live) so the deleted row
		// vanishes from the correct harness's tree.
		refetch: func(cli, target string) tea.Cmd { return fetchCmd(cli, target) },
	}
}

// prepareRemoveCmd is the off-thread PROBE half of the remove confirm-apply flow.
// It dry-runs the delete to resolve + validate the target path WITHOUT writing, and
// returns a removeMsg with a ready-to-confirm action — or an err (target not found
// / wrong type / symlink refusal / exec failure) the handler surfaces in the status
// bar WITHOUT opening a modal. It NEVER writes (dry-run only); the real delete
// happens only after the user confirms the returned action.
func prepareRemoveCmd(cliPath, target, kind, name string, prune bool) tea.Cmd {
	return func() tea.Msg {
		preview, diags, err := fetchRemoveDry(cliPath, target, kind, name, prune)
		if err != nil {
			return removeMsg{err: err}
		}
		if !preview.Ok {
			return removeMsg{err: refusalError(diags)}
		}
		return removeMsg{action: buildRemoveAction(removeInfo{
			kind: kind, name: name, target: preview.Target,
			prune: prune, prunedCount: preview.PrunedCount,
		})}
	}
}

// ── Snapshot rollback (Snapshots tab) ──────────────────────────────────────

// buildRollbackAction builds the confirm-gated rollback action. On confirm the
// run field orchestrates the two-step safety-snapshot-then-rollback (NOT the
// default args path); rollback carries the preview confirmView renders.
func buildRollbackAction(info rollbackInfo) writeAction {
	return writeAction{
		id:       "rollback",
		rollback: &info,
		run:      func(cli, target string) tea.Cmd { return runRollbackCmd(cli, target, info.id, info.drifted) },
	}
}

// firstProblemMessage returns the first error- or warn-severity diagnostic
// message, or "" when there is none.
func firstProblemMessage(diags []Diagnostic) string {
	for _, d := range diags {
		if d.Severity == "error" || d.Severity == "warn" {
			return d.Message
		}
	}
	return ""
}

// rollbackRefusalError turns a non-rollbackable preflight (archive-corrupt / a
// non-drift error status) into an error for the status bar — the first problem
// message, or a status-based fallback.
func rollbackRefusalError(diags []Diagnostic, status string) error {
	if msg := firstProblemMessage(diags); msg != "" {
		return errors.New(msg)
	}
	return fmt.Errorf("snapshot cannot be rolled back (%s)", status)
}

// prepareRollbackCmd is the off-thread PROBE half of the rollback confirm-apply
// flow. It dry-runs the rollback to read the preflight (drift state + archive
// verify) WITHOUT writing, classifies the outcome, and returns a rollbackPrepMsg
// with a ready-to-confirm action — or an err the handler shows in the status bar
// WITHOUT opening a modal (archive-corrupt or any non-drift refusal). A
// refused-drift outcome is offerable: the action will pass --force, and the
// confirm step takes a safety snapshot first.
func prepareRollbackCmd(cliPath, target string, snap Snapshot) tea.Cmd {
	return func() tea.Msg {
		probe, diags, err := fetchRollbackDry(cliPath, target, snap.Id)
		if err != nil {
			return rollbackPrepMsg{err: err}
		}
		var drifted bool
		switch probe.Status {
		case "dry-run": // preflight clean — rollback would restore without --force
			drifted = false
		case "refused-drift": // live tree changed since capture — offerable with --force
			drifted = true
		default:
			// archive-corrupt / drift-error / any other status: NOT rollbackable
			// (--force bypasses only drift, not the archive verify). Refuse, no modal.
			return rollbackPrepMsg{err: rollbackRefusalError(diags, probe.Status)}
		}
		info := rollbackInfo{id: snap.Id, reason: snap.Reason, fileCount: snap.FileCount, drifted: drifted}
		return rollbackPrepMsg{action: buildRollbackAction(info)}
	}
}

// runRollbackCmd is the on-confirm orchestration: it takes a SAFETY SNAPSHOT of
// the current state first (so this rollback is itself undoable), then rolls the
// chosen snapshot back onto the live tree, passing --force only when the tree
// drifted (the safety snapshot already captured the changes --force overwrites).
// A failed safety snapshot ABORTS before the rollback touches anything. Reports a
// rollbackResultMsg. The real writes go through the engine's gate + auto-snapshot.
// target scopes BOTH the safety snapshot and the rollback to the active harness
// (slice 2a: codex rollback is live), so a codex rollback snapshots + restores the
// codex tree, never the claude one.
func runRollbackCmd(cliPath, target, id string, drifted bool) tea.Cmd {
	return func() tea.Msg {
		// Capture the envelope and ASSERT a real snapshot was written — a
		// write-gate-unavailable run can exit 0 with ok:false and nothing captured,
		// which would silently make this rollback NON-undoable. Refuse in that case.
		out, err := runJSON(cliPath, target, "snapshot", "--apply", "--format", "json")
		if err != nil {
			return rollbackResultMsg{err: fmt.Errorf("safety snapshot failed; rollback aborted: %w", err)}
		}
		if !snapshotApplied(out) {
			return rollbackResultMsg{err: errors.New("safety snapshot did not capture (write gate unavailable?); rollback aborted")}
		}
		args := []string{"rollback", id, "--apply", "--format", "json"}
		if drifted {
			args = append(args, "--force")
		}
		if _, err := runJSON(cliPath, target, args...); err != nil {
			return rollbackResultMsg{err: err}
		}
		return rollbackResultMsg{err: nil}
	}
}

// rollbackConfirmText composes the confirm modal's title + body for a snapshot
// rollback. A drifted rollback leads with a danger warning (the modal also turns
// red). reason/id are engine DATA shown verbatim; the prose is translated. Called
// at render time on the UI thread, so reading uiLang via tr/tf is race-free.
func rollbackConfirmText(info rollbackInfo) (title, body string) {
	title = tr("write.rollback.title")
	reason := info.reason
	if reason == "" {
		reason = info.id
	}
	if info.drifted {
		body = tr("write.rollback.driftWarn") + "\n\n"
	}
	body += tf("write.rollback.body", reason, info.fileCount)
	body += "\n\n" + tr("write.rollback.autoSnapshot")
	body += "\n\n" + tr("write.rollback.restart")
	return title, body
}

// writeResultMsg carries the outcome of a confirm-gated write action.
type writeResultMsg struct {
	action writeAction
	err    error
}

// runWriteCmd runs the action's hardcoded CLI command (a state-changing write) and
// reports a writeResultMsg. stdout is discarded — the subsequent refetch re-reads
// authoritative state. This is the ONLY function that runs a write, and it is
// reached ONLY from the confirm modal's y/enter branch. target scopes the write to
// the active harness (slice 2a: codex drift-update is live) by appending --target
// codex to the action's args; the claude default ("") keeps the args unchanged.
func runWriteCmd(cliPath, target string, a writeAction) tea.Cmd {
	return func() tea.Msg {
		_, err := runJSON(cliPath, target, a.args...)
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

// skillVisConfirmText composes the confirm modal's title + body for a per-skill
// visibility change from its dry-run preview. The skill name, the chosen state
// (an engine enum value), and the diff fragments are engine DATA shown verbatim;
// only the surrounding prose is translated. Called at render time on the UI
// thread, so reading uiLang via tr/tf is race-free. Reuses write.plugin.change
// for the diff line label.
func skillVisConfirmText(info skillVisInfo) (title, body string) {
	title = tr("write.skillVis.setTitle")
	body = tf("write.skillVis.willSet", info.name, info.state)
	if info.after != "" {
		change := info.before + "  →  " + info.after
		if info.before == "" {
			change = "+ " + info.after // an INSERT: the skill had no override yet
		}
		body += "\n\n" + tf("write.plugin.change", "settings.json", info.line) + "\n" + change
	}
	body += "\n\n" + tr("write.skillVis.reversible")
	return title, body
}

// skillFlipConfirmText composes the confirm modal's title + body for a codex skill
// enable/disable flip from its dry-run preview. The skill name and the config.toml
// diff fragments are engine DATA (shown verbatim); only the surrounding prose is
// translated. Called at render time on the UI thread, so reading uiLang via tr/tf is
// race-free. Mirrors pluginConfirmText but names config.toml + Codex. Reuses
// write.plugin.change for the diff-line label.
func skillFlipConfirmText(info skillFlipInfo) (title, body string) {
	if info.desired {
		title = tr("write.skillFlip.enableTitle")
		body = tf("write.skillFlip.willEnable", info.name)
	} else {
		title = tr("write.skillFlip.disableTitle")
		body = tf("write.skillFlip.willDisable", info.name)
	}
	if info.after != "" {
		change := info.before + "  →  " + info.after
		if info.before == "" {
			change = "+ " + info.after // an INSERT: the block had no enabled key yet
		}
		body += "\n\n" + tf("write.plugin.change", "config.toml", info.line) + "\n" + change
	}
	body += "\n\n" + tr("write.skillFlip.reversible")
	return title, body
}

// removeConfirmText composes the confirm modal's title + body for a component
// delete from its dry-run preview. The name + engine-resolved target path are
// engine DATA shown verbatim; only the surrounding prose is translated. A skill
// delete adds a whole-folder warning. The modal renders in danger red (see
// confirmView). Called at render time on the UI thread, so reading uiLang via
// tr/tf is race-free.
func removeConfirmText(info removeInfo) (title, body string) {
	title = tr("write.remove.title")
	body = tf("write.remove.willDelete", info.name)
	if info.target != "" {
		body += "\n\n" + tr("write.remove.pathLabel") + "\n" + info.target
	}
	if info.kind == "skill" {
		body += "\n\n" + tr("write.remove.folderWarn")
	}
	// A codex prune delete also removes the skill's orphaned config.toml entries — show
	// how many so the config edits are visible before confirming (the same single
	// snapshot covers both, so one rollback undoes the whole thing).
	if info.prune {
		body += "\n\n" + tf("write.remove.willPrune", info.prunedCount)
	}
	body += "\n\n" + tr("write.remove.reversible")
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

	bodyStyle := lipgloss.NewStyle().Foreground(labelGray)
	dim := lipgloss.NewStyle().Foreground(statusDim)
	gap := lipgloss.NewStyle().Foreground(tabDim).Render("   ")

	// Resolve the title/body. A plugin-toggle or rollback action composes them from
	// its dry-run preview at render time; every other action uses its static i18n
	// keys. A drifted rollback escalates the modal accent from amber to danger red.
	titleText, bodyText := tr(a.titleKey), tr(a.bodyKey)
	accentCol := colorOrange
	switch {
	case a.plugin != nil:
		titleText, bodyText = pluginConfirmText(*a.plugin)
	case a.skillVis != nil:
		titleText, bodyText = skillVisConfirmText(*a.skillVis)
	case a.skillFlip != nil:
		titleText, bodyText = skillFlipConfirmText(*a.skillFlip)
	case a.remove != nil:
		titleText, bodyText = removeConfirmText(*a.remove)
		accentCol = colorRed // a destructive delete → danger styling (same red as a drifted rollback)
	case a.rollback != nil:
		titleText, bodyText = rollbackConfirmText(*a.rollback)
		if a.rollback.drifted {
			accentCol = colorRed
		}
	}
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(accentCol)

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
		BorderForeground(accentCol).
		Padding(1, 3).
		Render(b.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// visPickerView renders the centered skill-visibility picker for m.visPick,
// mirroring confirmView's amber overlay. It lists the four skillVisStates (engine
// enum values shown verbatim — NOT translated), the cursor row marked with a
// "▸ " accent prefix and brightened, the rest dimmed, plus a footer key hint.
func visPickerView(m model) string {
	width, height := m.width, m.height
	if width < 1 || height < 1 {
		return ""
	}
	if m.visPick == nil {
		return dashboardView(m)
	}

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorOrange)
	nameStyle := lipgloss.NewStyle().Foreground(labelGray)
	dim := lipgloss.NewStyle().Foreground(statusDim)

	var b strings.Builder
	b.WriteString(titleStyle.Render(glyph("✎", "!") + " " + tr("write.skillVis.title")))
	b.WriteString("\n\n")
	b.WriteString(nameStyle.Render(m.visPick.name))
	b.WriteString("\n\n")

	for i, state := range skillVisStates {
		if i == m.visPick.cursor {
			row := keyStyle.Bold(true).Render(glyph("▸", ">") + " " + state)
			b.WriteString(row)
		} else {
			b.WriteString(dim.Render("  " + state))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n" + lipgloss.NewStyle().Foreground(configGray).Render(tr("write.skillVis.pickHint")))

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorOrange).
		Padding(1, 3).
		Render(b.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// removePickLabelKeys are the two codex-skill-delete options, in cursor order:
// index 0 = delete the skill only (prune=false), index 1 = also prune the orphaned
// config.toml entries (prune=true). Unlike the skill-visibility picker (which shows
// raw engine enum values), these are human labels, so they are translated at render.
var removePickLabelKeys = []string{"write.remove.pickDeleteOnly", "write.remove.pickPrune"}

// removePickerView renders the centered codex-skill-delete picker for m.removePick,
// mirroring visPickerView's amber overlay. It offers two options — delete only, or
// delete + prune the orphaned [[skills.config]] entries — the cursor row marked with
// a "▸ " accent prefix and brightened, the other dimmed, plus a footer key hint. The
// chosen option's prune flag flows into the dry-run, then the RED confirm modal.
func removePickerView(m model) string {
	width, height := m.width, m.height
	if width < 1 || height < 1 {
		return ""
	}
	if m.removePick == nil {
		return dashboardView(m)
	}

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorOrange)
	nameStyle := lipgloss.NewStyle().Foreground(labelGray)
	dim := lipgloss.NewStyle().Foreground(statusDim)

	var b strings.Builder
	b.WriteString(titleStyle.Render(glyph("✎", "!") + " " + tr("write.remove.pickTitle")))
	b.WriteString("\n\n")
	b.WriteString(nameStyle.Render(m.removePick.name))
	b.WriteString("\n\n")

	for i, key := range removePickLabelKeys {
		if i == m.removePick.cursor {
			b.WriteString(keyStyle.Bold(true).Render(glyph("▸", ">") + " " + tr(key)))
		} else {
			b.WriteString(dim.Render("  " + tr(key)))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n" + lipgloss.NewStyle().Foreground(configGray).Render(tr("write.remove.pickHint")))

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorOrange).
		Padding(1, 3).
		Render(b.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

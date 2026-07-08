package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// inventoryMsg carries the result of the async counts fetch into the Update
// loop. Exactly one of inv / err is meaningful (err != nil means the fetch
// failed). This drives the headless --probe/--snapshot counts and the counts
// overview bar; the interactive Inventory tree is driven by detailMsg.
type inventoryMsg struct {
	inv Inventory
	err error
}

// detailMsg carries the result of the async `inventory --detail` fetch: all four
// object arrays that populate the Inventory tree. Exactly one of data / err is
// meaningful.
type detailMsg struct {
	data DetailData
	err  error
}

// conflictsMsg carries the result of the async `conflicts` fetch.
type conflictsMsg struct {
	data []ConflictCluster
	err  error
}

// orphansMsg carries the result of the async `orphans` fetch.
type orphansMsg struct {
	data OrphansResult
	err  error
}

// configMsg carries the result of the async `config show-effective` fetch.
type configMsg struct {
	data ConfigResult
	err  error
}

// hooksMsg carries the result of the async `hooks` fetch.
type hooksMsg struct {
	data HooksResult
	err  error
}

// selftestMsg carries the result of the async `selftest` fetch.
type selftestMsg struct {
	data SelftestResult
	err  error
}

// doctorMsg carries the result of the async `doctor` fetch (passive run).
type doctorMsg struct {
	data DoctorReport
	err  error
}

// permissionsMsg carries the result of the async `permissions --audit` fetch.
type permissionsMsg struct {
	data PermissionsResult
	err  error
}

// driftMsg carries the result of the async `drift` fetch (read-only, no --update).
type driftMsg struct {
	data DriftResult
	err  error
}

// auditMsg carries the result of the async `audit` fetch (read-only log view).
type auditMsg struct {
	data AuditResult
	err  error
}

// healthMsg carries the result of the async `health` fetch (read-only — a passive
// doctor run plus scan/hooks/advice aggregation, no --active-probes, no writes).
type healthMsg struct {
	data HealthReport
	err  error
}

// dispositionsMsg carries the result of the async `conflicts` fetch parsed for
// disposition advice (read-only — same endpoint as conflicts, additive overlay).
type dispositionsMsg struct {
	data []Disposition
	err  error
}

// snapshotsMsg carries the result of the async `snapshot list` fetch (read-only —
// enumerates existing snapshots, no writes).
type snapshotsMsg struct {
	data []Snapshot
	err  error
}

// rollbackPrepMsg carries the resolved rollback action ready for the confirm modal
// — built by prepareRollbackCmd AFTER a dry-run preflight of the chosen snapshot.
// err set ⇒ the snapshot is not rollbackable (archive-corrupt or another non-drift
// refusal): shown in the status bar, no modal. Otherwise action holds the run
// orchestration plus the preview confirmView renders.
type rollbackPrepMsg struct {
	action writeAction
	err    error
}

// rollbackResultMsg carries the outcome of a confirmed rollback (the safety
// snapshot + the restore). err set ⇒ the safety snapshot or the restore failed.
type rollbackResultMsg struct {
	err error
}

// pluginToggleMsg carries the resolved plugin enable/disable action ready for the
// confirm modal — built by preparePluginToggleCmd AFTER a dry-run probe of the
// authoritative settings.json state. err set ⇒ a probe/refusal failure (shown in
// the status bar, no modal); otherwise action holds the real --apply command plus
// the preview confirmView renders.
type pluginToggleMsg struct {
	action writeAction
	err    error
}

// mcpToggleMsg carries the resolved codex MCP enable/disable action ready for the
// confirm modal — built by prepareMcpToggleCmd AFTER a dry-run probe of the
// authoritative config.toml state. err set ⇒ a probe/refusal failure (shown in the
// status bar, no modal); otherwise action holds the real --apply command plus the
// preview confirmView renders. Mirrors pluginToggleMsg.
type mcpToggleMsg struct {
	action writeAction
	err    error
}

// skillVisMsg carries the resolved per-skill visibility action ready for the
// confirm modal — built by prepareSkillVisCmd AFTER a dry-run of the chosen
// state. err set ⇒ a refusal / exec failure (shown in the status bar, no modal);
// alreadyInState set ⇒ the skill is already in the chosen state (a status-bar
// toast, no modal); otherwise action holds the real --apply command plus the
// preview confirmView renders.
type skillVisMsg struct {
	action         writeAction
	alreadyInState bool
	name, state    string
	err            error
}

// removeMsg carries the resolved component-delete action ready for the confirm
// modal — built by prepareRemoveCmd AFTER a dry-run that resolves + validates the
// target path. err set ⇒ a refusal (target not found / wrong type / symlink) or
// exec failure (shown in the status bar, no modal); otherwise action holds the real
// --apply delete plus the preview confirmView renders in danger red.
type removeMsg struct {
	action writeAction
	err    error
}

// skillFlipMsg carries the resolved codex skill enable/disable flip action ready for
// the confirm modal — built by prepareSkillFlipCmd AFTER a dry-run probe of the
// authoritative config.toml state. err set ⇒ a probe/refusal failure (the skill has
// no [[skills.config]] entry, an ambiguous name, or an exec error — shown in the
// status bar, no modal); otherwise action holds the real --apply flip plus the
// preview confirmView renders. Mirrors pluginToggleMsg.
type skillFlipMsg struct {
	action writeAction
	err    error
}

// skillVisStates is the fixed set of skill-visibility states the picker offers,
// in display order. They are engine enum values passed verbatim to
// `skill visibility <name> <state>` — NOT translated (see visPickerView).
var skillVisStates = []string{"on", "name-only", "user-invocable-only", "off"}

// visPicker is the small modal that lets the user choose one of the four
// skillVisStates for the selected skill before the dry-run runs. cursor indexes
// skillVisStates; name is the skill being edited.
type visPicker struct {
	name   string
	cursor int
}

// removePicker is the small modal shown when deleting a codex SKILL row: it lets the
// user choose whether to also prune the skill's orphaned config.toml [[skills.config]]
// entries. cursor indexes removePickLabelKeys (0 = delete only, 1 = delete + prune);
// name is the skill being deleted. Only codex skills reach it — Claude skills and
// codex agents/commands delete directly (no [[skills.config]] to prune).
type removePicker struct {
	name   string
	cursor int
}

// previewTickMsg is the debounced signal to load the file-body preview for the
// currently selected Inventory tree node. gen must match model.previewGen at
// delivery time; stale ticks (from a still-scrolling cursor) are discarded.
type previewTickMsg struct{ gen uint64 }

// previewDelay is how long after the cursor settles before the file-body
// preview is loaded. Chosen to feel instant on a settled cursor while letting
// fast j/k scrolling do zero disk I/O.
const previewDelay = 100 * time.Millisecond

// schedulePreview bumps the debounce generation and returns a Tick that, after
// previewDelay, asks to load the file-body preview — but only if no newer move
// has bumped the generation since (see the previewTickMsg handler).
func (m *model) schedulePreview() tea.Cmd {
	m.previewGen++
	gen := m.previewGen
	return tea.Tick(previewDelay, func(time.Time) tea.Msg { return previewTickMsg{gen: gen} })
}

// sectionState holds the fetch + list state for a flat-list section tab
// (Conflicts, Orphans). loading is true while the fetch is in flight; err is set
// on failure; list holds the rendered items; summaryKey + summaryArgs are the
// translation key and fmt args for the one-line header. The header is formatted
// at RENDER time (summaryText), never pre-formatted at fetch time — the fetches
// resolve during the splash, before the user has picked a language, so a baked
// string would freeze the wrong language.
type sectionState struct {
	loading bool
	// loaded marks that a fetch for this section has COMPLETED at least once. It
	// gates lazy loading: the three non-badge tabs (config/hooks/audit) are not
	// fetched at startup; lazyLoadCurrent fetches them on first visit and their msg
	// handler sets loaded, so a revisit never re-fetches. Eager tabs never consult it.
	loaded      bool
	err         error
	list        sectionModel
	summaryKey  string
	summaryArgs []any
}

// summaryText formats the section's one-line summary in the active UI language,
// or "" when none has been set (still loading, errored, or no summary).
func (st *sectionState) summaryText() string {
	if st == nil || st.summaryKey == "" {
		return ""
	}
	return tf(st.summaryKey, st.summaryArgs...)
}

// focusPane identifies which split pane currently receives j/k + arrow keys on
// the Inventory tab. Tab/Shift+Tab toggles between them.
type focusPane int

const (
	focusTree   focusPane = iota // left tree
	focusDetail                  // right detail viewport
)

// viewID enumerates the dashboard tabs in display order. Inventory is the
// default (zero value).
type viewID int

const (
	viewInventory viewID = iota
	viewConflicts
	viewOrphans
	viewConfig
	viewHooks
	viewSelftest
	viewDoctor
	viewPermissions
	viewDrift
	viewAudit
	viewHealth
	viewDispositions
	viewSnapshots
)

// tabLabels are the tab-bar captions, indexed by viewID. tabCount derives from
// the slice length so adding a tab requires editing only this list + the iota.
var tabLabels = []string{
	"Inventory",
	"Conflicts",
	"Orphans",
	"Config",
	"Hooks",
	"Selftest",
	"Doctor",
	"Permissions",
	"Drift",
	"Audit",
	"Health",
	"Dispositions",
	"Snapshots",
}

// tabCount is the number of tabs, derived from tabLabels. It is a var (not a
// const) because len() of a slice is not a compile-time constant.
var tabCount = viewID(len(tabLabels))

// defaultWidth is the assumed terminal width before any tea.WindowSizeMsg has
// arrived (e.g. --snapshot in a non-TTY pipe).
const defaultWidth = 80

// defaultHeight is the assumed terminal height for the --snapshot frame (no
// WindowSizeMsg arrives in a pipe). Tall enough to show several list rows plus
// the full detail pane so the snapshot is representative.
const defaultHeight = 24

// model holds the TUI state: the fetched inventory + detail data, fetch errors
// (if any), loading flags, the resolved CLI path, the active tab, the Inventory
// split-pane widgets (tree/viewport/spinner) and which pane has focus, plus the
// last-known terminal dimensions.
type model struct {
	inv         Inventory
	err         error
	loading     bool   // counts fetch in flight
	showSplash  bool   // true while the startup splash is displayed
	showHelp    bool   // true while the ? keyboard-shortcuts overlay is displayed
	filterMode  bool   // true while the user is typing a / filter
	filterQuery string // the active / filter text, applied to the current view
	mascotBlink bool   // true briefly while the corner mascot blinks (eyes closed)
	cliPath     string
	currentView viewID
	lang        language // active UI language; defaults to langEN, chosen on the splash
	target      string   // active harness target: "claude" (default) | "codex"; flipped by T
	width       int
	height      int

	// Inventory split-pane state.
	detailData    DetailData
	detailErr     error
	detailLoading bool // `inventory --detail` fetch in flight
	tree          treeModel
	detail        viewport.Model
	spinner       spinner.Model
	focus         focusPane

	// Tree pane inner size, computed by layoutPanes and consumed by the tree
	// renderer (the custom tree widget is sized at render time, not via SetSize).
	treeInnerW int
	treeInnerH int

	// sections holds the fetch + list state for flat-list section tabs.
	// Keys are viewConflicts and viewOrphans; initialized in initialModel.
	sections map[viewID]*sectionState

	// Confirm-gated write flow (Phase A). pending holds the action awaiting
	// confirmation (nil = no modal); while set, handleKey routes to the confirm
	// overlay. writeRunning is true between confirm and the writeResultMsg (keeps
	// the spinner ticking). writeStatus is a transient one-line result shown in the
	// status bar (cleared on the next keypress); writeOK colors it green/red.
	pending       *writeAction
	writeRunning  bool
	writeStatus   string
	writeOK       bool
	writesEnabled bool // opt-in: write actions (the "w" key) are live only when true

	// visPick holds the per-skill visibility picker when open (nil = no picker).
	// While set, handleKey routes to the picker overlay (arrow keys move the cursor,
	// Enter launches the dry-run for the chosen state → m.pending; Esc/n/q cancels).
	// It is mutually exclusive with pending — the picker leads INTO the confirm modal.
	visPick *visPicker

	// removePick holds the codex-skill-delete picker when open (nil = no picker).
	// While set, handleKey routes to its overlay (arrow keys move the cursor over the
	// two options, Enter launches the remove dry-run with the chosen prune flag →
	// m.pending; Esc/n/q cancels). Mutually exclusive with visPick and pending — like
	// visPick it leads INTO the confirm modal and does no write itself.
	removePick *removePicker

	// snapshotData is the last-fetched snapshot list, kept so the rollback action can
	// map the selected Snapshots-tab row (by its id) back to the full record for the
	// confirm preview (reason + fileCount). Parallel to the section list, set on
	// snapshotsMsg.
	snapshotData []Snapshot

	// previewGen is the debounce generation counter for the file-body preview on
	// the Inventory tab. Each cursor move increments it; the matching previewTickMsg
	// fires the full refresh only when its gen equals the current value (stale ticks
	// from still-scrolling cursors are silently discarded).
	previewGen uint64
}

// uiConfig snapshots the model's persisted TUI preferences for saveConfigCmd.
func (m model) uiConfig() uiConfig {
	return uiConfig{Language: langCode(m.lang), WritesEnabled: m.writesEnabled, Target: m.target}
}

func initialModel(cliPath string) model {
	return model{
		loading:       true,
		detailLoading: true,
		showSplash:    true,
		cliPath:       cliPath,
		currentView:   viewInventory,
		target:        "claude", // clean default; main() applies the persisted value (mirrors lang/writesEnabled)
		width:         defaultWidth,
		height:        defaultHeight,
		tree:          newTreeModel(DetailData{}),
		detail:        viewport.New(0, 0),
		spinner:       newSpinner(),
		focus:         focusTree,
		// Eager sections start loading — Init fetches them so their tab-bar badge is
		// correct from launch. The four non-badge / lazy tabs (config/hooks/audit/
		// health) start idle and are lazy-fetched on first visit by lazyLoadCurrent
		// (see Init). Health is the heaviest single fetch, so it lazy-loads too.
		sections: map[viewID]*sectionState{
			viewConflicts:    {loading: true, list: newSectionModel(nil)},
			viewOrphans:      {loading: true, list: newSectionModel(nil)},
			viewConfig:       {loading: false, list: newSectionModel(nil)},
			viewHooks:        {loading: false, list: newSectionModel(nil)},
			viewSelftest:     {loading: true, list: newSectionModel(nil)},
			viewDoctor:       {loading: true, list: newSectionModel(nil)},
			viewPermissions:  {loading: true, list: newSectionModel(nil)},
			viewDrift:        {loading: true, list: newSectionModel(nil)},
			viewAudit:        {loading: false, list: newSectionModel(nil)},
			viewHealth:       {loading: false, list: newSectionModel(nil)},
			viewDispositions: {loading: false, list: newSectionModel(nil)},
			viewSnapshots:    {loading: false, list: newSectionModel(nil)},
		},
	}
}

// fetchCmd returns a tea.Cmd that fetches the inventory counts and reports the
// outcome back to Update as an inventoryMsg. target scopes the read to a harness.
func fetchCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		inv, err := fetchInventory(cliPath, target)
		return inventoryMsg{inv: inv, err: err}
	}
}

// fetchDetailCmd returns a tea.Cmd that fetches all four object arrays
// (`inventory --detail`) and reports the outcome back as a detailMsg.
func fetchDetailCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDetail(cliPath, target)
		return detailMsg{data: data, err: err}
	}
}

// fetchConflictsCmd returns a tea.Cmd that runs `conflicts --format json` and
// reports the outcome back as a conflictsMsg.
func fetchConflictsCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchConflicts(cliPath, target)
		return conflictsMsg{data: data, err: err}
	}
}

// fetchOrphansCmd returns a tea.Cmd that runs `orphans --format json` and
// reports the outcome back as an orphansMsg.
func fetchOrphansCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchOrphans(cliPath, target)
		return orphansMsg{data: data, err: err}
	}
}

// fetchConfigCmd returns a tea.Cmd that runs `config show-effective --format json`
// and reports the outcome back as a configMsg.
func fetchConfigCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchConfig(cliPath, target)
		return configMsg{data: data, err: err}
	}
}

// fetchHooksCmd returns a tea.Cmd that runs `hooks --format json` and reports
// the outcome back as a hooksMsg.
func fetchHooksCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchHooks(cliPath, target)
		return hooksMsg{data: data, err: err}
	}
}

// fetchSelftestCmd returns a tea.Cmd that runs `selftest --format json` and
// reports the outcome back as a selftestMsg. Target-AGNOSTIC — selftest checks
// harness-mgr's OWN repo, not a harness, so it takes NO target param.
func fetchSelftestCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchSelftest(cliPath)
		return selftestMsg{data: data, err: err}
	}
}

// fetchDoctorCmd returns a tea.Cmd that runs `doctor --format json` (PASSIVE —
// no --active-probes) and reports the outcome back as a doctorMsg.
func fetchDoctorCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDoctor(cliPath, target)
		return doctorMsg{data: data, err: err}
	}
}

// fetchDoctorActiveCmd runs the OPT-IN active doctor probes and reports the
// outcome as a doctorMsg (same handler as the passive run, so the tab updates in
// place). Only ever dispatched from a confirmed "a" action — never at startup.
// The active probe writes a transient ~/.claude governed-dir file, so the "a"
// entry point stays gated under codex even though other codex writes are now live;
// this is therefore only ever dispatched with the claude target.
func fetchDoctorActiveCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDoctorActive(cliPath, target)
		return doctorMsg{data: data, err: err}
	}
}

// fetchPermissionsCmd returns a tea.Cmd that runs
// `permissions --audit --format json` and reports the outcome back as a
// permissionsMsg. This is fully READ-ONLY — no writes occur.
func fetchPermissionsCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchPermissions(cliPath, target)
		return permissionsMsg{data: data, err: err}
	}
}

// fetchDriftCmd returns a tea.Cmd that runs `drift --format json` (READ-ONLY —
// no --update, so no lockfile is written) and reports the outcome as a driftMsg.
func fetchDriftCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDrift(cliPath, target)
		return driftMsg{data: data, err: err}
	}
}

// fetchAuditCmd returns a tea.Cmd that runs `audit --format json` (READ-ONLY log
// view) and reports the outcome back as an auditMsg.
func fetchAuditCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchAudit(cliPath, target)
		return auditMsg{data: data, err: err}
	}
}

// fetchHealthCmd returns a tea.Cmd that runs `health --format json` (READ-ONLY —
// a passive doctor run plus scan/hooks/advice aggregation, no --active-probes, no
// writes) and reports the outcome back as a healthMsg.
func fetchHealthCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchHealth(cliPath, target)
		return healthMsg{data: data, err: err}
	}
}

// fetchDispositionsCmd returns a tea.Cmd that runs `conflicts --format json`
// (READ-ONLY) and parses the additive dispositions overlay from the result.
func fetchDispositionsCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDispositions(cliPath, target)
		return dispositionsMsg{data: data, err: err}
	}
}

// fetchSnapshotsCmd returns a tea.Cmd that runs `snapshot list --format json`
// (READ-ONLY) and parses the snapshot list from the result.
func fetchSnapshotsCmd(cliPath, target string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchSnapshots(cliPath, target)
		return snapshotsMsg{data: data, err: err}
	}
}

// sectionFetchCmd returns the read-only fetch command that (re)loads section view
// v's data, or nil for a non-section view. Same commands Init dispatches. target
// scopes every read to the active harness — EXCEPT selftest, which is
// target-agnostic (it checks harness-mgr's own repo, not a harness).
func sectionFetchCmd(v viewID, cliPath, target string) tea.Cmd {
	switch v {
	case viewConflicts:
		return fetchConflictsCmd(cliPath, target)
	case viewOrphans:
		return fetchOrphansCmd(cliPath, target)
	case viewConfig:
		return fetchConfigCmd(cliPath, target)
	case viewHooks:
		return fetchHooksCmd(cliPath, target)
	case viewSelftest:
		return fetchSelftestCmd(cliPath) // target-AGNOSTIC — never scoped to a harness
	case viewDoctor:
		return fetchDoctorCmd(cliPath, target) // PASSIVE — no --active-probes
	case viewPermissions:
		return fetchPermissionsCmd(cliPath, target)
	case viewDrift:
		return fetchDriftCmd(cliPath, target)
	case viewAudit:
		return fetchAuditCmd(cliPath, target)
	case viewHealth:
		return fetchHealthCmd(cliPath, target)
	case viewDispositions:
		return fetchDispositionsCmd(cliPath, target)
	case viewSnapshots:
		return fetchSnapshotsCmd(cliPath, target)
	}
	return nil
}

// refreshCurrent re-fetches the active tab's data, setting its loading flag so the
// spinner shows while the fetch is in flight. It is a no-op (returns nil) when that
// tab is already loading, or has no fetch. All fetches are the same read-only
// commands Init dispatches — the Doctor refresh stays passive.
//
// Pointer receiver: the scalar flag mutations (m.loading/m.detailLoading) reach the
// runtime via the model that the value-receiver handleKey returns; the section flag
// mutates the shared *sectionState. This mirrors clearFilter/applyFilter.
func (m *model) refreshCurrent() tea.Cmd {
	if m.currentView == viewInventory {
		if m.loading || m.detailLoading {
			return nil
		}
		m.loading = true
		m.detailLoading = true
		return tea.Batch(fetchCmd(m.cliPath, m.target), fetchDetailCmd(m.cliPath, m.target))
	}
	if isSectionView(m.currentView) {
		st := m.sections[m.currentView]
		if st == nil || st.loading {
			return nil
		}
		// Resolve the fetch BEFORE flipping the loading flag: should a section view
		// ever be missing from sectionFetchCmd (drift vs isSectionView), this stays a
		// clean no-op instead of stranding the tab in a never-ending spinner.
		cmd := sectionFetchCmd(m.currentView, m.cliPath, m.target)
		if cmd == nil {
			return nil
		}
		st.loading = true
		return cmd
	}
	return nil
}

// lazyLoadCurrent fetches the active tab's data on its FIRST visit, for the four
// non-badge / lazy tabs (config / hooks / audit / health) that Init deliberately
// skips. Eager tabs and inventory are no-ops here. The in-flight `loading` flag
// plus `loaded` (set by the msg handler when the fetch completes) together mean a
// revisit never re-fetches; a manual `r` refresh still re-runs it via
// refreshCurrent. Pointer receiver: it flips the shared *sectionState flags, which
// reach the runtime via the model handleKey returns (same pattern as
// refreshCurrent).
//
// Health lazy-loads (rather than eager-fetching in Init) because it is the
// HEAVIEST single command — scan + a passive doctor run + hooks + advice. The
// consequence is that its tab-bar badge appears only after the tab is first
// opened; that is an accepted tradeoff for a faster launch. (A test that needs the
// badge injects the healthMsg directly.)
func (m *model) lazyLoadCurrent() tea.Cmd {
	switch m.currentView {
	case viewConfig, viewHooks, viewAudit, viewHealth, viewDispositions, viewSnapshots:
	default:
		return nil
	}
	st := m.sections[m.currentView]
	if st == nil || st.loading || st.loaded {
		return nil
	}
	cmd := sectionFetchCmd(m.currentView, m.cliPath, m.target)
	if cmd == nil {
		return nil
	}
	st.loading = true
	return cmd
}

// eagerSectionViews are the section tabs Init fetches up front so their tab-bar
// badge is correct from launch. switchTarget re-fetches exactly these (the rest
// lazy-load on first visit), so the list MUST mirror initialModel's loading:true
// sections (drift coverage is guarded by refresh_test).
var eagerSectionViews = []viewID{
	viewConflicts, viewOrphans, viewSelftest, viewDoctor, viewPermissions, viewDrift,
}

// switchTarget flips the active harness target (claude↔codex), invalidates ALL
// cached inventory + section data (so stale claude rows never show under codex and
// vice-versa), resets the current view's filter, and returns the batch that
// re-fetches the inventory + the eager section badges + the current view if it is
// a lazy tab. The lazy tabs re-fetch on their next visit via lazyLoadCurrent (their
// loaded flag is cleared here). Persisting the choice is the caller's job.
//
// Pointer receiver: it mutates the shared *sectionState entries + the scalar
// loading flags, which reach the runtime via the model handleKey returns.
func (m *model) switchTarget() tea.Cmd {
	if m.target == "codex" {
		m.target = "claude"
	} else {
		m.target = "codex"
	}
	// Drop any active filter so a query from the old target's rows does not carry over.
	m.clearFilter()

	// Invalidate the Inventory tab: empty the data + tree, mark both fetches in flight.
	m.loading = true
	m.detailLoading = true
	m.inv = Inventory{}
	m.err = nil
	m.detailData = DetailData{}
	m.detailErr = nil
	m.tree = newTreeModel(DetailData{})

	// Invalidate every section: empty list, drop the summary, clear loaded so a lazy
	// tab re-fetches on its next visit. The eager sections are marked in flight below.
	eager := make(map[viewID]bool, len(eagerSectionViews))
	for _, v := range eagerSectionViews {
		eager[v] = true
	}
	for v, st := range m.sections {
		if st == nil {
			continue
		}
		st.list = newSectionModel(nil)
		st.summaryKey, st.summaryArgs = "", nil
		st.err = nil
		st.loaded = false
		st.loading = eager[v]
	}
	// The rollback action maps a selected row to this raw list — it must not survive
	// a target switch (it belongs to the old target's snapshot store).
	m.snapshotData = nil

	// Re-fetch the inventory + the eager section badges (mirrors Init), plus the
	// current view if it is a lazy tab not in the eager set.
	cmds := []tea.Cmd{fetchCmd(m.cliPath, m.target), fetchDetailCmd(m.cliPath, m.target)}
	for _, v := range eagerSectionViews {
		cmds = append(cmds, sectionFetchCmd(v, m.cliPath, m.target))
	}
	if lazy := m.lazyLoadCurrent(); lazy != nil {
		cmds = append(cmds, lazy)
	}
	return tea.Batch(cmds...)
}

// selectedSnapshot returns the Snapshot under the Snapshots-tab cursor by mapping
// the selected row's id back to the fetched list (filter-safe — selectedItem
// honours the active filter). ok=false when the tab is absent, empty, or the
// selected row has no resolvable id.
func (m model) selectedSnapshot() (Snapshot, bool) {
	st := m.sections[viewSnapshots]
	if st == nil {
		return Snapshot{}, false
	}
	item, ok := st.list.selectedItem()
	if !ok || item.id == "" {
		return Snapshot{}, false
	}
	for _, s := range m.snapshotData {
		if s.Id == item.id {
			return s, true
		}
	}
	return Snapshot{}, false
}

// anyLoading reports whether any fetch is still in flight. The spinner keeps
// ticking as long as this is true.
func (m model) anyLoading() bool {
	if m.loading || m.detailLoading || m.writeRunning {
		return true
	}
	for _, st := range m.sections {
		if st != nil && st.loading {
			return true
		}
	}
	return false
}

// blinkMsg toggles the corner mascot's eyes, driving a periodic blink.
type blinkMsg struct{}

const (
	// blinkOpenInterval is how long the mascot's eyes stay open between blinks.
	blinkOpenInterval = 4 * time.Second
	// blinkClosedInterval is how long the eyes stay shut during one blink.
	blinkClosedInterval = 160 * time.Millisecond
)

// blinkTick schedules the next blinkMsg after d, alternating the mascot's
// open/closed eye frames.
func blinkTick(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(time.Time) tea.Msg { return blinkMsg{} })
}

// Init kicks off all async fetches, starts the spinner ticking, and arms the
// mascot blink. The splash persists until the user presses a key — no
// auto-dismiss timer.
func (m model) Init() tea.Cmd {
	// Eager fetches = the visible Inventory tab (counts + detail) PLUS the six
	// sections whose tab-bar badge must be correct from launch (conflicts / orphans
	// / selftest / doctor / permissions / drift — see tabBadge). The three non-badge
	// tabs (config / hooks / audit) are NOT fetched here; lazyLoadCurrent fetches
	// them on first visit, so startup spawns 8 node processes instead of 11.
	return tea.Batch(
		fetchCmd(m.cliPath, m.target),
		fetchDetailCmd(m.cliPath, m.target),
		fetchConflictsCmd(m.cliPath, m.target),
		fetchOrphansCmd(m.cliPath, m.target),
		fetchSelftestCmd(m.cliPath), // target-AGNOSTIC
		fetchDoctorCmd(m.cliPath, m.target),
		fetchPermissionsCmd(m.cliPath, m.target),
		fetchDriftCmd(m.cliPath, m.target),
		m.spinner.Tick,
		blinkTick(blinkOpenInterval),
	)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case inventoryMsg:
		m.loading = false
		m.inv = msg.inv
		m.err = msg.err
		return m, nil
	case detailMsg:
		m.detailLoading = false
		m.detailData = msg.data
		m.detailErr = msg.err
		m.tree = newTreeModel(msg.data)
		m.refreshDetail()
		// Splash persists — the user must press a key to enter.
		return m, nil
	case previewTickMsg:
		// Debounced preview load: only the latest scheduled tick (gen match) fires;
		// earlier ticks from a still-scrolling cursor are stale and ignored.
		if msg.gen == m.previewGen {
			m.refreshDetail() // settled — do the full metadata+preview refresh once
		}
		return m, nil
	case conflictsMsg:
		m.applySectionResult(viewConflicts, msg.err, func() []sectionItem { return conflictItems(msg.data) }, "summary.conflicts", []any{len(msg.data)}, false)
		return m, nil
	case orphansMsg:
		m.applySectionResult(viewOrphans, msg.err, func() []sectionItem { return orphanItems(msg.data) }, "summary.orphans", []any{msg.data.Summary.Hard, msg.data.Summary.Soft}, false)
		return m, nil
	case configMsg:
		m.applySectionResult(viewConfig, msg.err, func() []sectionItem { return configItems(msg.data) }, "summary.config", []any{len(msg.data.Keys)}, true)
		return m, nil
	case hooksMsg:
		t := hookExplainTallies(msg.data.Explanations)
		m.applySectionResult(viewHooks, msg.err, func() []sectionItem { return hooksItems(msg.data) }, "summary.hooks", []any{t[0], t[1], t[2]}, true)
		return m, nil
	case selftestMsg:
		n := len(msg.data.Checks)
		failing := 0
		for _, ch := range msg.data.Checks {
			if !ch.Ok {
				failing++
			}
		}
		summaryKey := "summary.selftestOk"
		summaryArgs := []any{n}
		if failing > 0 {
			summaryKey = "summary.selftestFail"
			summaryArgs = []any{n, failing}
		}
		m.applySectionResult(viewSelftest, msg.err, func() []sectionItem { return selftestItems(msg.data) }, summaryKey, summaryArgs, false)
		return m, nil
	case doctorMsg:
		// doctorMsg arrives from BOTH the passive fetch (startup / "r" refresh, where
		// writeRunning is false) and the confirmed active-probe run ("a"→y, which set
		// writeRunning true). Capture that before clearing so only the confirmed write
		// action gets a status-bar toast — passive refreshes stay silent.
		wasActiveRun := m.writeRunning
		m.writeRunning = false
		n := len(msg.data.Checks)
		findings := 0
		for _, ch := range msg.data.Checks {
			findings += ch.Findings
		}
		m.applySectionResult(viewDoctor, msg.err, func() []sectionItem { return doctorItems(msg.data) }, "summary.doctor", []any{n, findings}, false)
		if wasActiveRun {
			if msg.err != nil {
				m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
				m.writeOK = false
			} else {
				m.writeStatus = tr("write.activeProbe.done")
				m.writeOK = true
			}
		}
		return m, nil
	case permissionsMsg:
		m.applySectionResult(viewPermissions, msg.err, func() []sectionItem { return permissionsItems(msg.data) }, "summary.permissions", []any{len(msg.data.Allow), len(msg.data.Ask), len(msg.data.Deny), len(msg.data.Overbroad)}, false)
		return m, nil
	case driftMsg:
		var driftSummaryKey string
		var driftSummaryArgs []any
		switch msg.data.Status {
		case "drifted":
			s := msg.data.Summary
			driftSummaryKey, driftSummaryArgs = "summary.drifted", []any{s.Added, s.Modified, s.Removed}
		case "clean":
			driftSummaryKey, driftSummaryArgs = "summary.driftClean", nil
		default: // "no-baseline" or any unrecognized status
			driftSummaryKey, driftSummaryArgs = "summary.driftNoBaseline", nil
		}
		m.applySectionResult(viewDrift, msg.err, func() []sectionItem { return driftItems(msg.data) }, driftSummaryKey, driftSummaryArgs, false)
		return m, nil
	case auditMsg:
		s := msg.data.Summary
		auditSummaryKey := "summary.audit"
		auditSummaryArgs := []any{s.Returned}
		if s.SkippedMalformed > 0 {
			auditSummaryKey = "summary.auditSkipped"
			auditSummaryArgs = []any{s.Returned, s.SkippedMalformed}
		}
		m.applySectionResult(viewAudit, msg.err, func() []sectionItem { return auditItems(msg.data) }, auditSummaryKey, auditSummaryArgs, true)
		return m, nil
	case healthMsg:
		// Summary mirrors the CLI health-render tiers: not-loaded · degraded · advice.
		// setsLoaded=true because Health lazy-loads (like config/hooks/audit), so a
		// completed fetch must mark it loaded to stop lazyLoadCurrent re-fetching.
		hs := msg.data.Health.Summary
		m.applySectionResult(viewHealth, msg.err, func() []sectionItem { return healthItems(msg.data) }, "summary.health", []any{hs.NotLoaded, hs.Degraded, msg.data.Advice.Summary.Total}, true)
		return m, nil
	case dispositionsMsg:
		// setsLoaded=true: Dispositions lazy-loads (same tab-badge logic as Health).
		tallies := dispositionTallies(msg.data)
		m.applySectionResult(viewDispositions, msg.err, func() []sectionItem { return dispositionItems(msg.data) }, "summary.dispositions", []any{tallies[0], tallies[1], tallies[2]}, true)
		return m, nil
	case snapshotsMsg:
		// setsLoaded=true: Snapshots lazy-loads (same tab-badge logic as Dispositions).
		// Keep the raw list so the rollback action can map a selected row id → record.
		m.snapshotData = msg.data
		m.applySectionResult(viewSnapshots, msg.err, func() []sectionItem { return snapshotItems(msg.data) }, "summary.snapshots", []any{len(msg.data)}, true)
		return m, nil
	case pluginToggleMsg:
		// The dry-run probe finished. writeRunning was set when "w" launched it.
		m.writeRunning = false
		if msg.err != nil {
			// Refusal / exec failure: surface it in the status bar, open no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		a := msg.action
		m.pending = &a // open the confirm modal with the resolved preview
		return m, nil
	case mcpToggleMsg:
		// The codex MCP dry-run probe finished (writeRunning set when "w" launched it).
		// Mirrors the pluginToggleMsg handler.
		m.writeRunning = false
		if msg.err != nil {
			// Refusal / exec failure: surface it in the status bar, open no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		a := msg.action
		m.pending = &a // open the confirm modal with the resolved MCP toggle preview
		return m, nil
	case skillVisMsg:
		// The dry-run of the chosen state finished. writeRunning was set when the
		// picker's Enter launched it.
		m.writeRunning = false
		if msg.err != nil {
			// Refusal / exec failure: surface it in the status bar, open no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		if msg.alreadyInState {
			// Already in the chosen state: a status-bar toast, no modal.
			m.writeStatus = tf("write.skillVis.already", msg.name, msg.state)
			m.writeOK = true
			return m, nil
		}
		a := msg.action
		m.pending = &a // open the confirm modal with the resolved preview
		return m, nil
	case removeMsg:
		// The remove dry-run finished (writeRunning set when "x" launched it).
		m.writeRunning = false
		if msg.err != nil {
			// Refusal (not found / wrong type / symlink) or exec failure: status bar, no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		a := msg.action
		m.pending = &a // open the RED confirm modal with the resolved target preview
		return m, nil
	case skillFlipMsg:
		// The codex skill-flip dry-run probe finished (writeRunning set when "w"
		// launched it). Mirrors the pluginToggleMsg handler.
		m.writeRunning = false
		if msg.err != nil {
			// Refusal (no config entry / ambiguous) or exec failure: status bar, no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		a := msg.action
		m.pending = &a // open the confirm modal with the resolved flip preview
		return m, nil
	case rollbackPrepMsg:
		// The rollback dry-run preflight finished (writeRunning set when "w" launched it).
		m.writeRunning = false
		if msg.err != nil {
			// Not rollbackable (archive-corrupt / non-drift refusal): status bar, no modal.
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		ra := msg.action
		m.pending = &ra // open the confirm modal (red when drifted)
		return m, nil
	case rollbackResultMsg:
		// The safety-snapshot + restore finished.
		m.writeRunning = false
		if msg.err != nil {
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		m.writeStatus = tr("write.rollback.done")
		m.writeOK = true
		// Re-read the counts (the live tree changed) and the snapshot list (the safety
		// snapshot added one). Both are pure reads, scoped to m.target so a codex
		// rollback re-reads the codex harness (slice 2a: codex rollback is live).
		return m, tea.Batch(fetchCmd(m.cliPath, m.target), fetchSnapshotsCmd(m.cliPath, m.target))
	case writeResultMsg:
		m.writeRunning = false
		if msg.err != nil {
			m.writeStatus = tr("write.failed") + ": " + msg.err.Error()
			m.writeOK = false
			return m, nil
		}
		m.writeStatus = tr(msg.action.doneKey)
		m.writeOK = true
		// Re-fetch the affected tab so the UI reflects the write (drift now reads
		// "clean" against the just-written baseline). The re-fetch is a pure READ,
		// scoped to the active target so a codex write re-reads the codex harness.
		if msg.action.refetch != nil {
			return m, msg.action.refetch(m.cliPath, m.target)
		}
		return m, nil
	case spinner.TickMsg:
		// Keep ticking only while any fetch is still in flight.
		if m.anyLoading() {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
		return m, nil
	case blinkMsg:
		// Toggle the eyes and schedule the next change: a short closed interval
		// (the blink itself) then a long open interval until the next blink.
		m.mascotBlink = !m.mascotBlink
		next := blinkOpenInterval
		if m.mascotBlink {
			next = blinkClosedInterval
		}
		return m, blinkTick(next)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.layoutPanes()
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

// applySectionResult applies a finished section fetch to the tab's state: it
// nil-guards the sectionState, clears loading, records err, and on success
// installs the rendered list + summary; it refreshes the detail pane when this
// tab is the current view. setsLoaded marks lazily-loaded tabs (config/hooks/
// audit) as loaded. buildItems is only invoked on success, matching the prior
// behavior where item lists were built inside the `if err == nil` block.
// summaryKey/summaryArgs are likewise applied only on success, so callers may
// compute them unconditionally — a value computed on the error path (where
// msg.data is the zero value) is simply discarded here.
func (m *model) applySectionResult(v viewID, err error, buildItems func() []sectionItem, summaryKey string, summaryArgs []any, setsLoaded bool) {
	st := m.sections[v]
	if st == nil {
		st = &sectionState{}
		m.sections[v] = st
	}
	st.loading = false
	if setsLoaded {
		st.loaded = true
	}
	st.err = err
	if err == nil {
		st.list = newSectionModel(buildItems())
		st.summaryKey, st.summaryArgs = summaryKey, summaryArgs
	}
	if m.currentView == v {
		m.refreshDetail()
	}
}

// handleKey routes keypresses with this precedence:
//
//	(1) ctrl+c always quits (even during the splash / help overlay);
//	(2) while the startup splash is up it is a language picker (← →/h/l/Tab
//	    toggle, Enter/Space enter, q/Esc quit) — all keys are swallowed;
//	(3) while the ? help overlay is up, ? / Esc / q close it — all other keys are
//	    swallowed;
//	(4) quit keys (q / ctrl+c / esc);
//	(5) section switching — number keys 1-9/0 jump directly, "[" / "]" cycle;
//	(6) Tab / Shift+Tab toggle focus between the tree and detail panes;
//	(7) ? opens the help overlay;
//	(8) Enter / Space — on a tree folder toggle expand/collapse; on a tree item
//	    refresh the detail to that node (only when the tree pane is focused);
//	(9) everything else (j/k, arrows, g/G, pgup/pgdn) routes to the focused pane
//	    (tree moves the cursor, viewport scrolls).
//
// Tab does not switch sections (that was the U1 binding) — it toggles pane focus.
func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// ctrl+c always quits, even during the splash.
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	// While the splash is up it is a language picker; keys are swallowed here so
	// they never also act on the dashboard (currentView is left unchanged).
	if m.showSplash {
		// ← → (or h/l/Tab) toggle the highlighted language, Enter/Space confirms
		// and enters the dashboard, q/Esc quits (ctrl+c is handled by the guard
		// above). Other keys are ignored (no longer "any key to enter").
		switch msg.String() {
		case "left", "right", "h", "l", "tab":
			m.lang = otherLang(m.lang)
		case "enter", " ":
			m.showSplash = false
			return m, saveConfigCmd(m.uiConfig()) // remember language + write-mode for next launch
		case "q", "esc":
			return m, tea.Quit
		}
		return m, nil
	}
	// The ? help overlay swallows keys while open; ? / Esc / q dismiss it.
	if m.showHelp {
		switch msg.String() {
		case "?", "esc", "q":
			m.showHelp = false
		}
		return m, nil
	}
	// The skill-visibility picker swallows keys while open: up/k and down/j move the
	// cursor over the four states, Enter launches the dry-run for the chosen state
	// (which opens the confirm modal via skillVisMsg), n/Esc/q cancels. It is checked
	// BEFORE pending and the writeRunning guard because the picker itself does no
	// write — it only leads INTO the confirm flow once Enter resolves a dry-run.
	if m.visPick != nil {
		switch msg.String() {
		case "up", "k":
			if m.visPick.cursor > 0 {
				m.visPick.cursor--
			}
		case "down", "j":
			if m.visPick.cursor < len(skillVisStates)-1 {
				m.visPick.cursor++
			}
		case "enter":
			state := skillVisStates[m.visPick.cursor]
			name := m.visPick.name
			m.visPick = nil
			m.writeRunning = true
			m.writeStatus = ""
			return m, prepareSkillVisCmd(m.cliPath, name, state)
		case "n", "esc", "q":
			m.visPick = nil
		}
		return m, nil
	}
	// The codex-skill-delete picker swallows keys while open: up/k and down/j move the
	// cursor over the two options (delete only / delete + prune config), Enter launches
	// the remove dry-run with the chosen prune flag (which opens the RED confirm modal
	// via removeMsg), n/Esc/q cancels. Checked BEFORE pending and the writeRunning guard
	// (like visPick) because the picker itself does no write — it only leads INTO the
	// confirm flow once Enter resolves the dry-run.
	if m.removePick != nil {
		switch msg.String() {
		case "up", "k":
			if m.removePick.cursor > 0 {
				m.removePick.cursor--
			}
		case "down", "j":
			if m.removePick.cursor < len(removePickLabelKeys)-1 {
				m.removePick.cursor++
			}
		case "enter":
			prune := m.removePick.cursor == 1 // index 1 = delete + prune config
			name := m.removePick.name
			m.removePick = nil
			m.writeRunning = true
			m.writeStatus = ""
			// Codex skill delete: the dry-run resolves the target + (when prune) the
			// orphaned config entries under --target codex.
			return m, prepareRemoveCmd(m.cliPath, m.target, "skill", name, prune)
		case "n", "esc", "q":
			m.removePick = nil
		}
		return m, nil
	}
	// A pending write action shows a confirm modal that swallows keys: y/Enter runs
	// it, n/Esc/q cancels. Nothing else acts while it is up (mirrors splash/help).
	// The engine's assertWritable gate — not this modal — is the real safety
	// boundary; the modal is the explicit-consent UX guard.
	if m.pending != nil {
		switch msg.String() {
		case "y", "enter":
			a := *m.pending
			m.pending = nil
			m.writeStatus = ""
			m.writeRunning = true
			if a.run != nil {
				// Custom on-confirm cmd (e.g. active probes → doctorMsg). writeRunning
				// shows the "working…" indicator; the result msg clears it. m.target
				// scopes the run to the active harness (codex rollback runs its safety
				// snapshot + restore under --target codex).
				return m, a.run(m.cliPath, m.target)
			}
			return m, runWriteCmd(m.cliPath, m.target, a)
		case "n", "esc", "q":
			m.pending = nil
		}
		return m, nil
	}
	// While a write is in flight, swallow keys so a second write can't be started
	// (re-entrancy guard): writeRunning is true with pending already nil, so the
	// modal block above no longer catches it. The write completes via a
	// writeResultMsg, never a keypress, so nothing useful happens here meanwhile.
	// (ctrl+c is handled above this, so the user can still quit.)
	if m.writeRunning {
		return m, nil
	}
	// While typing a / filter, keys edit the query (live-filtering the current
	// view) instead of navigating; handleFilterKey owns Enter/Esc/Backspace/runes.
	if m.filterMode {
		return m.handleFilterKey(msg)
	}
	// Any key dismisses a transient write-result line.
	m.writeStatus = ""
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc":
		// Esc clears an active filter first; with no filter it quits.
		if m.filterQuery != "" {
			m.filterQuery = ""
			m.applyFilter()
			return m, nil
		}
		return m, tea.Quit
	case "]", "right":
		m.clearFilter()
		m.currentView = (m.currentView + 1) % tabCount
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	case "[", "left":
		m.clearFilter()
		m.currentView = (m.currentView - 1 + tabCount) % tabCount
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	case "h", "H":
		// Direct jump to the Health tab — the 11th tab has no single digit (1-0
		// address tabs 1-10), so a mnemonic key reaches it without cycling.
		// Case-insensitive: the tab bar shows "H" but users naturally press lowercase.
		m.clearFilter()
		m.currentView = viewHealth
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	case "d", "D":
		// Direct jump to the Dispositions tab — the 12th tab, beyond the digit range.
		// Case-insensitive (lowercase "d" was a page-down alias; page-down keeps f/PgDn).
		m.clearFilter()
		m.currentView = viewDispositions
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	case "s", "S":
		// Direct jump to the Snapshots tab — the 13th tab, beyond the digit range.
		// Case-insensitive: the tab bar shows "S" but users naturally press lowercase.
		m.clearFilter()
		m.currentView = viewSnapshots
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	case "tab":
		m.toggleFocus()
		return m, nil
	case "shift+tab":
		m.toggleFocus()
		return m, nil
	case "?":
		m.showHelp = true
		return m, nil
	case "r":
		return m, m.refreshCurrent()
	case "w":
		if !m.writesEnabled {
			// Writes are opt-in and currently off — tell the user how to enable.
			m.writeStatus = tr("write.disabledHint")
			m.writeOK = false
			return m, nil
		}
		// Inventory tab: the write is the per-plugin enable/disable toggle on the
		// SELECTED plugin row. It launches an off-thread dry-run probe (to learn the
		// authoritative settings.json state) and opens the confirm modal only when
		// the resulting pluginToggleMsg arrives. A non-plugin row gets a hint.
		if m.currentView == viewInventory {
			if node, ok := m.tree.selectedNode(); ok && node.kind == kindPlugin && node.plug != nil {
				m.writeRunning = true
				m.writeStatus = ""
				return m, preparePluginToggleCmd(m.cliPath, m.target, node.plug.Key)
			} else if ok && node.kind == kindSkill && node.comp != nil {
				// A skill row's "w" branches by target. Claude: open the 4-state
				// visibility picker (settings.json skillOverrides). Codex: launch the
				// binary enable/disable FLIP (config.toml [[skills.config]] enabled) — an
				// off-thread dry-run probe that decides direction and opens the confirm
				// modal when skillFlipMsg arrives (mirrors the plugin toggle). The probe
				// resolves by name first, then by the row's --path (so a path-keyed skill
				// with no name block still flips); a skill in NEITHER form refuses at probe
				// time → a status-bar toast.
				if m.target == "codex" {
					m.writeRunning = true
					m.writeStatus = ""
					return m, prepareSkillFlipCmd(m.cliPath, m.target, node.comp.Name, node.comp.Path)
				}
				// The dry-run runs only after the user picks a state and presses Enter.
				m.visPick = &visPicker{name: node.comp.Name}
				return m, nil
			} else if ok && node.kind == kindMcp && node.mcp != nil {
				// An MCP row's "w" toggles enable/disable. Codex: config.toml mcp_servers
				// (an off-thread dry-run probe decides direction, mirroring the plugin
				// toggle, then opens the confirm modal when mcpToggleMsg arrives). Claude
				// MCP uses a different claude-CLI delegate mechanism not surfaced here.
				if m.target == "codex" {
					m.writeRunning = true
					m.writeStatus = ""
					return m, prepareMcpToggleCmd(m.cliPath, m.target, node.mcp.Name)
				}
				m.writeStatus = tr("write.mcp.claudeHint")
				m.writeOK = false
				return m, nil
			}
			m.writeStatus = tr("write.plugin.selectHint")
			m.writeOK = false
			return m, nil
		}
		// Snapshots tab: the write is a rollback of the SELECTED snapshot row. It
		// launches an off-thread dry-run preflight (drift + verify) and opens the
		// confirm modal only when rollbackPrepMsg arrives. An empty / unresolvable
		// selection gets a hint.
		if m.currentView == viewSnapshots {
			if snap, ok := m.selectedSnapshot(); ok {
				m.writeRunning = true
				m.writeStatus = ""
				return m, prepareRollbackCmd(m.cliPath, m.target, snap)
			}
			m.writeStatus = tr("write.rollback.selectHint")
			m.writeOK = false
			return m, nil
		}
		if wa, ok := writeActionFor(m.currentView); ok {
			m.pending = &wa
		}
		return m, nil
	case "x":
		// Remove (DELETE) the selected component — a destructive but reversible write,
		// Inventory tab only. Gated behind write mode like "w". Launches an off-thread
		// dry-run that resolves + validates the target path and opens the RED confirm
		// modal only when removeMsg arrives. Only skill/agent/command rows are removable
		// (plugins toggle via "w"; mcp/marketplace are not remove kinds). A non-removable
		// or empty selection gets a hint. Works under BOTH targets (slice 2a: codex
		// remove is live — prepareRemoveCmd dry-runs under m.target).
		if !m.writesEnabled {
			m.writeStatus = tr("write.disabledHint")
			m.writeOK = false
			return m, nil
		}
		if m.currentView == viewInventory {
			if node, ok := m.tree.selectedNode(); ok && node.comp != nil &&
				(node.kind == kindSkill || node.kind == kindAgent || node.kind == kindCommand) {
				// A codex SKILL delete can also prune its orphaned config.toml entries, so
				// it first opens the two-option picker (delete only / delete + prune); the
				// dry-run launches from the picker's Enter with the chosen flag. Every other
				// case (Claude rows, codex agents/commands — none have [[skills.config]])
				// deletes directly with prune=false.
				if m.target == "codex" && node.kind == kindSkill {
					m.removePick = &removePicker{name: node.comp.Name}
					return m, nil
				}
				m.writeRunning = true
				m.writeStatus = ""
				// node.comp.Kind is the engine string node.kind was derived from
				// (tree.go componentKind), so the spec kind always matches the guarded
				// row kind — they can never disagree about what is being deleted.
				return m, prepareRemoveCmd(m.cliPath, m.target, node.comp.Kind, node.comp.Name, false)
			}
			m.writeStatus = tr("write.remove.selectHint")
			m.writeOK = false
			return m, nil
		}
		return m, nil
	case "W":
		// Toggle opt-in write mode and persist the choice immediately.
		m.writesEnabled = !m.writesEnabled
		if m.writesEnabled {
			m.writeStatus = tr("write.modeOn")
		} else {
			m.writeStatus = tr("write.modeOff")
		}
		m.writeOK = true
		return m, saveConfigCmd(m.uiConfig())
	case "t", "T":
		// Flip the active harness target (claude↔codex), persist the choice, and
		// re-fetch fresh per-target data (switchTarget invalidates all caches first so
		// stale rows never show under the other target). Case-insensitive like the H/D/S
		// tab jumps. Codex now supports writes (plugin / mcp toggle / skill flip / remove
		// / rollback / drift-update); only the active probe (a) stays gated.
		cmd := m.switchTarget()
		// Confirm the flip with a transient status-bar toast naming the NEW target
		// (switchTarget already set m.target). The toast clears on the next key like
		// other write-result lines (handleKey blanks m.writeStatus at the top).
		if m.target == "codex" {
			m.writeStatus = tr("status.switchedToCodex")
		} else {
			m.writeStatus = tr("status.switchedToClaude")
		}
		m.writeOK = true
		return m, tea.Batch(saveConfigCmd(m.uiConfig()), cmd)
	case "a":
		// Active doctor probes (Doctor tab only): side-effecting (spawns node/claude
		// + a transient governed-dir write), so gated behind write mode like "w",
		// then confirmed in the modal.
		if m.currentView != viewDoctor {
			return m, nil
		}
		if m.target == "codex" {
			// The active probe writes a transient ~/.claude governed-dir file, so it
			// stays gated under codex even though other codex writes are now live — it
			// no-ops with a toast (byte-identical Claude path when target=="claude").
			m.writeStatus = tr("write.codexReadOnly")
			m.writeOK = false
			return m, nil
		}
		if !m.writesEnabled {
			m.writeStatus = tr("write.activeProbe.disabled")
			m.writeOK = false
			return m, nil
		}
		wa := activeProbeAction()
		m.pending = &wa
		return m, nil
	case "/":
		m.filterMode = true
		return m, nil
	case "enter", " ":
		return m.activate()
	}
	if v, ok := digitToView(msg.String()); ok {
		m.clearFilter()
		m.currentView = v
		m.refreshDetail()
		return m, m.lazyLoadCurrent()
	}
	return m.routeToPane(msg)
}

// toggleFocus flips focus between the tree and detail panes. Only meaningful on
// the Inventory tab today, but cheap and harmless elsewhere.
func (m *model) toggleFocus() {
	if m.focus == focusTree {
		m.focus = focusDetail
	} else {
		m.focus = focusTree
	}
}

// activate handles Enter/Space. On the Inventory tab with the tree focused, a
// folder row toggles expand/collapse; an item row refreshes the detail. On a
// section tab (Conflicts/Orphans) there is no expand, so it is a no-op. Off the
// Inventory/section tabs, or when the detail pane is focused, the key is swallowed.
func (m model) activate() (tea.Model, tea.Cmd) {
	if isSectionView(m.currentView) {
		// No expand/collapse on flat lists; refresh the detail only when the LIST
		// pane is focused — Enter on the detail pane must not reset its scroll
		// (matching the Inventory tab's focus gate below).
		if m.focus == focusTree {
			m.refreshDetail()
		}
		return m, nil
	}
	if m.currentView != viewInventory || m.focus != focusTree {
		return m, nil
	}
	m.tree.toggle() // no-op on an item row; toggles + rebuilds on a folder row
	m.refreshDetail()
	return m, nil
}

// handleFilterKey processes a keypress while the / filter input is active: Esc
// clears the query and exits, Enter keeps the (applied) filter and exits the
// input, Backspace deletes the last rune, Space and typed runes append — each
// edit re-applies the live filter to the current view. Other keys are swallowed.
//
// The value receiver + returned model is how mutations propagate in Bubble Tea's
// Elm loop: applyFilter (pointer receiver) mutates THIS returned copy's tree and
// the shared *sectionState, so both the tree and section filters survive.
func (m model) handleFilterKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEsc:
		m.filterQuery = ""
		m.filterMode = false
		m.applyFilter()
	case tea.KeyEnter:
		m.filterMode = false
	case tea.KeyBackspace:
		if r := []rune(m.filterQuery); len(r) > 0 {
			m.filterQuery = string(r[:len(r)-1])
			m.applyFilter()
		}
	case tea.KeySpace:
		m.filterQuery += " "
		m.applyFilter()
	case tea.KeyRunes:
		m.filterQuery += string(msg.Runes)
		m.applyFilter()
	}
	return m, nil
}

// applyFilter pushes the current filterQuery into the active view's widget — the
// Inventory tree or a section list — and refreshes the detail pane.
func (m *model) applyFilter() {
	if isSectionView(m.currentView) {
		if st := m.sections[m.currentView]; st != nil {
			st.list.setFilter(m.filterQuery)
		}
	} else if m.currentView == viewInventory {
		m.tree.setFilter(m.filterQuery)
	}
	m.refreshDetail()
}

// clearFilter drops any active filter (query + input mode) and resets the current
// view's widget filter. Called on a tab switch so a filter never carries a stale
// query onto a different view.
func (m *model) clearFilter() {
	m.filterMode = false
	if m.filterQuery == "" {
		return
	}
	m.filterQuery = ""
	if isSectionView(m.currentView) {
		if st := m.sections[m.currentView]; st != nil {
			st.list.setFilter("")
		}
	} else if m.currentView == viewInventory {
		m.tree.setFilter("")
	}
}

// routeToPane forwards navigation keys to whichever pane has focus. On the
// Inventory tab the tree pane owns cursor movement; on section tabs the section
// list owns cursor movement; in both cases a cursor change refreshes the detail.
// The detail pane owns scrolling when focused. On other tabs the key is swallowed.
func (m model) routeToPane(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if isSectionView(m.currentView) {
		if m.focus == focusTree {
			m.moveSectionCursor(msg)
			return m, nil
		}
		var cmd tea.Cmd
		m.detail, cmd = m.detail.Update(msg)
		return m, cmd
	}
	if m.currentView != viewInventory {
		return m, nil
	}
	if m.focus == focusTree {
		prev := m.tree.cursor
		m.moveTreeCursor(msg)
		if m.tree.cursor != prev {
			m.refreshDetailMeta() // instant: metadata only, no file read
			// schedulePreview (pointer receiver) bumps m.previewGen on this local
			// copy; returning m propagates that bump into the model Bubble Tea keeps,
			// so the captured gen stays current only until the next cursor move.
			cmd := m.schedulePreview() // file body loads ~100ms after settling
			return m, cmd
		}
		return m, nil
	}
	var cmd tea.Cmd
	m.detail, cmd = m.detail.Update(msg)
	return m, cmd
}

// moveSectionCursor applies a navigation key to the active section list cursor
// and refreshes the detail pane when the cursor moves. Mirrors moveTreeCursor.
func (m *model) moveSectionCursor(msg tea.KeyMsg) {
	st := m.sections[m.currentView]
	if st == nil {
		return
	}
	page := m.treeInnerH
	if page < 1 {
		page = 1
	}
	prev := st.list.cursor
	switch msg.String() {
	case "j", "down":
		st.list.moveDown(1)
	case "k", "up":
		st.list.moveUp(1)
	case "g", "home":
		st.list.gotoTop()
	case "G", "end":
		st.list.gotoBottom()
	case "pgdown", "f":
		st.list.moveDown(page)
	case "pgup", "b", "u":
		st.list.moveUp(page)
	}
	if st.list.cursor != prev {
		m.refreshDetail()
	}
}

// moveTreeCursor applies a navigation key to the tree cursor: j/down + k/up move
// one row; g/G jump to top/bottom; pgup/pgdn (and the b/f/u/d aliases) page by
// the tree pane's inner height. Unrecognized keys are ignored.
func (m *model) moveTreeCursor(msg tea.KeyMsg) {
	page := m.treeInnerH
	if page < 1 {
		page = 1
	}
	switch msg.String() {
	case "j", "down":
		m.tree.moveDown(1)
	case "k", "up":
		m.tree.moveUp(1)
	case "g", "home":
		m.tree.gotoTop()
	case "G", "end":
		m.tree.gotoBottom()
	case "pgdown", "f":
		m.tree.moveDown(page)
	case "pgup", "b", "u":
		m.tree.moveUp(page)
	}
}

// digitToView maps a number-key string to the matching viewID. "1".."9" address
// the first nine tabs; "0" addresses the tenth (the "1-9 then 0" convention), so
// every tab stays keyboard-reachable as the list grows. The upper bound tracks
// tabCount, so a key with no tab (e.g. "0" when there are fewer than ten tabs)
// returns ok=false and the caller leaves the current view unchanged.
func digitToView(s string) (viewID, bool) {
	if len(s) != 1 {
		return 0, false
	}
	c := s[0]
	var d viewID
	switch {
	case c == '0':
		d = 9 // "0" addresses the 10th tab
	case c >= '1' && c <= '9':
		d = viewID(c - '1')
	default:
		return 0, false
	}
	// d is always ≥ 0 here (the cases above assign 0..9), so only the upper bound
	// needs checking — a digit with no matching tab (e.g. "0" when there are
	// fewer than ten tabs) returns ok=false and the view is left unchanged.
	if d >= tabCount {
		return 0, false
	}
	return d, true
}

func (m model) View() string {
	// Sync the package-level UI language from the model before rendering: this is
	// the single writer of uiLang, so every render helper's t()/tf() lookup sees
	// the active language without threading it through dozens of signatures.
	uiLang = m.lang
	if m.showSplash {
		return splashView(m.width, m.height)
	}
	if m.showHelp {
		return helpView(m.width, m.height)
	}
	if m.visPick != nil {
		return visPickerView(m)
	}
	if m.removePick != nil {
		return removePickerView(m)
	}
	if m.pending != nil {
		return confirmView(m)
	}
	return dashboardView(m)
}

func main() {
	probe := flag.Bool("probe", false, "headless: fetch data, print counts as plain text, exit (no TUI)")
	snapshot := flag.Bool("snapshot", false, "headless: fetch data, render the styled View() frame to stdout, exit (no TUI)")
	splash := flag.Bool("splash", false, "headless: render the startup splash screen to stdout, exit (no TUI)")
	icons := flag.Bool("icons", false, "headless: print the candidate icon sets (emoji vs symbols) to stdout, exit")
	colorFlag := flag.Bool("color", false, "headless: force a TrueColor profile so --snapshot emits ANSI color in a non-TTY pipe (color verification)")
	cliFlag := flag.String("cli", "", "path to the harness-mgr Node CLI entry (src/cli.mjs)")
	flag.Parse()

	cliPath := resolveCLIPath(*cliFlag)

	// Headless paths (--probe/--snapshot/--splash/--icons) never run View(), so
	// uiLang stays at its langEN default: diagnostic output is English by design.
	if *probe {
		os.Exit(runProbe(cliPath))
	}

	configureColor()
	if *colorFlag {
		// Force color even in a non-TTY pipe so the headless --snapshot emits ANSI
		// color for verification (configureColor already forces this under WT_SESSION).
		lipgloss.SetColorProfile(termenv.TrueColor)
	}

	if *splash {
		fmt.Println(splashView(defaultWidth, defaultHeight))
		os.Exit(0)
	}

	if *icons {
		fmt.Print(iconsTestView())
		os.Exit(0)
	}

	if *snapshot {
		os.Exit(runSnapshot(cliPath))
	}

	// Pre-flight: the interactive TUI shells out to `node <cli> ...` for every
	// data fetch (fetchInventory et al.). If node is not on PATH, every tab would
	// otherwise surface the same opaque per-fetch error. This is common on a macOS
	// GUI launch, where Finder/Dock hand the process a minimal PATH that omits
	// Homebrew/nvm node dirs. Fail fast here with a clear, actionable message.
	// (Headless --probe/--snapshot exit above and keep their plain node-error
	// output unchanged, so tests/CI behavior is untouched.)
	if _, err := exec.LookPath("node"); err != nil {
		fmt.Fprintln(os.Stderr, "harness-mgr: Node.js was not found on your PATH.")
		fmt.Fprintln(os.Stderr, "The TUI drives the harness-mgr Node CLI, so Node (>=24) must be installed and on PATH.")
		fmt.Fprintln(os.Stderr, "  • Install Node.js from https://nodejs.org (on macOS: `brew install node`).")
		fmt.Fprintln(os.Stderr, "  • If you launched from the macOS Dock/Finder, start it from a terminal instead so your shell PATH is inherited.")
		os.Exit(1)
	}

	// Mouse capture is intentionally NOT enabled: the splash is dismissed by any
	// key (handleKey), and leaving mouse reporting off preserves the terminal's
	// native text selection / copy while the TUI runs.
	m := initialModel(cliPath)
	cfg := loadConfig() // restore TUI preferences chosen on a previous launch
	m.lang = cfg.lang()
	m.writesEnabled = cfg.WritesEnabled
	m.target = cfg.target()
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error running TUI: %v\n", err)
		os.Exit(1)
	}
}

// runSnapshot fetches the inventory counts AND the full detail data (all four
// object arrays), builds a loaded model, renders View() to stdout, and exits.
// Distinct from --probe (plain text counts) — this renders the actual styled
// lipgloss frame for non-TTY inspection. The frame shows the default view
// (Inventory) as the split-pane tree browser with Skills expanded, at
// defaultWidth (no WindowSizeMsg arrives in a pipe), so layoutPanes() is invoked
// manually to size the widgets.
//
// The tree is populated from whatever config dir resolves by default (the live
// `~/.claude`). With no real config dir the folders would be empty, but the
// two-pane LAYOUT (bordered tree + bordered detail) plus counts bar is always
// rendered.
func runSnapshot(cliPath string) int {
	// Headless render uses the claude default (no T switcher in a non-TTY pipe);
	// targetArgs("") returns nil, so the read line is byte-identical to before.
	inv, err := fetchInventory(cliPath, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "snapshot error: %v\n", err)
		return 1
	}
	data, detailErr := fetchDetail(cliPath, "")

	m := model{ // loading=false, err=nil → inventory content path
		inv:     inv,
		cliPath: cliPath,
		sections: map[viewID]*sectionState{
			viewConflicts:    {list: newSectionModel(nil)},
			viewOrphans:      {list: newSectionModel(nil)},
			viewConfig:       {list: newSectionModel(nil)},
			viewHooks:        {list: newSectionModel(nil)},
			viewSelftest:     {list: newSectionModel(nil)},
			viewDoctor:       {list: newSectionModel(nil)},
			viewPermissions:  {list: newSectionModel(nil)},
			viewDrift:        {list: newSectionModel(nil)},
			viewAudit:        {list: newSectionModel(nil)},
			viewHealth:       {list: newSectionModel(nil)},
			viewDispositions: {list: newSectionModel(nil)},
			viewSnapshots:    {list: newSectionModel(nil)},
		},
		currentView: viewInventory,
		width:       defaultWidth,
		height:      defaultHeight,
		detailData:  data,
		detailErr:   detailErr,
		tree:        newTreeModel(data),
		detail:      viewport.New(0, 0),
		spinner:     newSpinner(),
		focus:       focusTree,
	}
	m.layoutPanes()
	// Land the cursor on the first skill item (row 1, under the expanded Skills
	// folder) so the snapshot frame demonstrates a populated detail pane, not the
	// folder-header empty state. No-op when the tree has no skill items.
	m.tree.moveDown(1)
	m.refreshDetail()

	fmt.Println(m.View())
	return 0
}

// runProbe fetches the inventory and prints it as plain text for non-TTY
// verification. Returns the process exit code (0 ok, 1 on fetch error).
func runProbe(cliPath string) int {
	// Headless probe uses the claude default (targetArgs("") returns nil → the read
	// line is byte-identical to before).
	inv, err := fetchInventory(cliPath, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "probe error: %v\n", err)
		return 1
	}
	c := inv.Result.Counts
	fmt.Printf("skills %d\n", c.Skills)
	fmt.Printf("agents %d\n", c.Agents)
	fmt.Printf("commands %d\n", c.Commands)
	fmt.Printf("plugins %d\n", c.Plugins)
	fmt.Printf("marketplaces %d\n", c.Marketplaces)
	fmt.Printf("mcpServers %d\n", c.McpServers)
	fmt.Printf("diagnostics %d\n", len(inv.Diagnostics))
	return 0
}

// configureColor forces a TrueColor profile when running under Windows Terminal.
// Windows Terminal does not export COLORTERM, so lipgloss/termenv would otherwise
// detect no color and render a monochrome UI. This is the documented v1 fix.
func configureColor() {
	if os.Getenv("WT_SESSION") != "" {
		// SetColorProfile is a lipgloss v1 compat shim. The full NewRenderer
		// migration (forward-compat for lipgloss v2) was deliberately deferred as
		// not-worth-the-risk: the headless color-verification it would unlock is
		// already provided cheaply by the `--color` flag (see main()).
		lipgloss.SetColorProfile(termenv.TrueColor)
	}
}

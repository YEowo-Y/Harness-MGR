package main

import (
	"flag"
	"fmt"
	"os"
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

// sectionState holds the fetch + list state for a flat-list section tab
// (Conflicts, Orphans). loading is true while the fetch is in flight; err is set
// on failure; list holds the rendered items; summaryKey + summaryArgs are the
// translation key and fmt args for the one-line header. The header is formatted
// at RENDER time (summaryText), never pre-formatted at fetch time — the fetches
// resolve during the splash, before the user has picked a language, so a baked
// string would freeze the wrong language.
type sectionState struct {
	loading     bool
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
}

// uiConfig snapshots the model's persisted TUI preferences for saveConfigCmd.
func (m model) uiConfig() uiConfig {
	return uiConfig{Language: langCode(m.lang), WritesEnabled: m.writesEnabled}
}

func initialModel(cliPath string) model {
	return model{
		loading:       true,
		detailLoading: true,
		showSplash:    true,
		cliPath:       cliPath,
		currentView:   viewInventory,
		width:         defaultWidth,
		height:        defaultHeight,
		tree:          newTreeModel(DetailData{}),
		detail:        viewport.New(0, 0),
		spinner:       newSpinner(),
		focus:         focusTree,
		sections: map[viewID]*sectionState{
			viewConflicts:   {loading: true, list: newSectionModel(nil)},
			viewOrphans:     {loading: true, list: newSectionModel(nil)},
			viewConfig:      {loading: true, list: newSectionModel(nil)},
			viewHooks:       {loading: true, list: newSectionModel(nil)},
			viewSelftest:    {loading: true, list: newSectionModel(nil)},
			viewDoctor:      {loading: true, list: newSectionModel(nil)},
			viewPermissions: {loading: true, list: newSectionModel(nil)},
			viewDrift:       {loading: true, list: newSectionModel(nil)},
			viewAudit:       {loading: true, list: newSectionModel(nil)},
		},
	}
}

// fetchCmd returns a tea.Cmd that fetches the inventory counts and reports the
// outcome back to Update as an inventoryMsg.
func fetchCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		inv, err := fetchInventory(cliPath)
		return inventoryMsg{inv: inv, err: err}
	}
}

// fetchDetailCmd returns a tea.Cmd that fetches all four object arrays
// (`inventory --detail`) and reports the outcome back as a detailMsg.
func fetchDetailCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDetail(cliPath)
		return detailMsg{data: data, err: err}
	}
}

// fetchConflictsCmd returns a tea.Cmd that runs `conflicts --format json` and
// reports the outcome back as a conflictsMsg.
func fetchConflictsCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchConflicts(cliPath)
		return conflictsMsg{data: data, err: err}
	}
}

// fetchOrphansCmd returns a tea.Cmd that runs `orphans --format json` and
// reports the outcome back as an orphansMsg.
func fetchOrphansCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchOrphans(cliPath)
		return orphansMsg{data: data, err: err}
	}
}

// fetchConfigCmd returns a tea.Cmd that runs `config show-effective --format json`
// and reports the outcome back as a configMsg.
func fetchConfigCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchConfig(cliPath)
		return configMsg{data: data, err: err}
	}
}

// fetchHooksCmd returns a tea.Cmd that runs `hooks --format json` and reports
// the outcome back as a hooksMsg.
func fetchHooksCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchHooks(cliPath)
		return hooksMsg{data: data, err: err}
	}
}

// fetchSelftestCmd returns a tea.Cmd that runs `selftest --format json` and
// reports the outcome back as a selftestMsg.
func fetchSelftestCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchSelftest(cliPath)
		return selftestMsg{data: data, err: err}
	}
}

// fetchDoctorCmd returns a tea.Cmd that runs `doctor --format json` (PASSIVE —
// no --active-probes) and reports the outcome back as a doctorMsg.
func fetchDoctorCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDoctor(cliPath)
		return doctorMsg{data: data, err: err}
	}
}

// fetchPermissionsCmd returns a tea.Cmd that runs
// `permissions --audit --format json` and reports the outcome back as a
// permissionsMsg. This is fully READ-ONLY — no writes occur.
func fetchPermissionsCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchPermissions(cliPath)
		return permissionsMsg{data: data, err: err}
	}
}

// fetchDriftCmd returns a tea.Cmd that runs `drift --format json` (READ-ONLY —
// no --update, so no lockfile is written) and reports the outcome as a driftMsg.
func fetchDriftCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchDrift(cliPath)
		return driftMsg{data: data, err: err}
	}
}

// fetchAuditCmd returns a tea.Cmd that runs `audit --format json` (READ-ONLY log
// view) and reports the outcome back as an auditMsg.
func fetchAuditCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		data, err := fetchAudit(cliPath)
		return auditMsg{data: data, err: err}
	}
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
	return tea.Batch(
		fetchCmd(m.cliPath),
		fetchDetailCmd(m.cliPath),
		fetchConflictsCmd(m.cliPath),
		fetchOrphansCmd(m.cliPath),
		fetchConfigCmd(m.cliPath),
		fetchHooksCmd(m.cliPath),
		fetchSelftestCmd(m.cliPath),
		fetchDoctorCmd(m.cliPath),
		fetchPermissionsCmd(m.cliPath),
		fetchDriftCmd(m.cliPath),
		fetchAuditCmd(m.cliPath),
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
	case conflictsMsg:
		st := m.sections[viewConflicts]
		if st == nil {
			st = &sectionState{}
			m.sections[viewConflicts] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(conflictItems(msg.data))
			st.summaryKey, st.summaryArgs = "summary.conflicts", []any{len(msg.data)}
		}
		if m.currentView == viewConflicts {
			m.refreshDetail()
		}
		return m, nil
	case orphansMsg:
		st := m.sections[viewOrphans]
		if st == nil {
			st = &sectionState{}
			m.sections[viewOrphans] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(orphanItems(msg.data))
			s := msg.data.Summary
			st.summaryKey, st.summaryArgs = "summary.orphans", []any{s.Hard, s.Soft}
		}
		if m.currentView == viewOrphans {
			m.refreshDetail()
		}
		return m, nil
	case configMsg:
		st := m.sections[viewConfig]
		if st == nil {
			st = &sectionState{}
			m.sections[viewConfig] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(configItems(msg.data))
			st.summaryKey, st.summaryArgs = "summary.config", []any{len(msg.data.Keys)}
		}
		if m.currentView == viewConfig {
			m.refreshDetail()
		}
		return m, nil
	case hooksMsg:
		st := m.sections[viewHooks]
		if st == nil {
			st = &sectionState{}
			m.sections[viewHooks] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(hooksItems(msg.data))
			st.summaryKey, st.summaryArgs = "summary.hooks", []any{len(msg.data.Hooks)}
		}
		if m.currentView == viewHooks {
			m.refreshDetail()
		}
		return m, nil
	case selftestMsg:
		st := m.sections[viewSelftest]
		if st == nil {
			st = &sectionState{}
			m.sections[viewSelftest] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(selftestItems(msg.data))
			n := len(msg.data.Checks)
			failing := 0
			for _, ch := range msg.data.Checks {
				if !ch.Ok {
					failing++
				}
			}
			if failing == 0 {
				st.summaryKey, st.summaryArgs = "summary.selftestOk", []any{n}
			} else {
				st.summaryKey, st.summaryArgs = "summary.selftestFail", []any{n, failing}
			}
		}
		if m.currentView == viewSelftest {
			m.refreshDetail()
		}
		return m, nil
	case doctorMsg:
		st := m.sections[viewDoctor]
		if st == nil {
			st = &sectionState{}
			m.sections[viewDoctor] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(doctorItems(msg.data))
			n := len(msg.data.Checks)
			findings := 0
			for _, ch := range msg.data.Checks {
				findings += ch.Findings
			}
			st.summaryKey, st.summaryArgs = "summary.doctor", []any{n, findings}
		}
		if m.currentView == viewDoctor {
			m.refreshDetail()
		}
		return m, nil
	case permissionsMsg:
		st := m.sections[viewPermissions]
		if st == nil {
			st = &sectionState{}
			m.sections[viewPermissions] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(permissionsItems(msg.data))
			st.summaryKey, st.summaryArgs = "summary.permissions", []any{
				len(msg.data.Allow), len(msg.data.Ask),
				len(msg.data.Deny), len(msg.data.Overbroad),
			}
		}
		if m.currentView == viewPermissions {
			m.refreshDetail()
		}
		return m, nil
	case driftMsg:
		st := m.sections[viewDrift]
		if st == nil {
			st = &sectionState{}
			m.sections[viewDrift] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(driftItems(msg.data))
			switch msg.data.Status {
			case "drifted":
				s := msg.data.Summary
				st.summaryKey, st.summaryArgs = "summary.drifted", []any{s.Added, s.Modified, s.Removed}
			case "clean":
				st.summaryKey, st.summaryArgs = "summary.driftClean", nil
			default: // "no-baseline" or any unrecognized status
				st.summaryKey, st.summaryArgs = "summary.driftNoBaseline", nil
			}
		}
		if m.currentView == viewDrift {
			m.refreshDetail()
		}
		return m, nil
	case auditMsg:
		st := m.sections[viewAudit]
		if st == nil {
			st = &sectionState{}
			m.sections[viewAudit] = st
		}
		st.loading = false
		st.err = msg.err
		if msg.err == nil {
			st.list = newSectionModel(auditItems(msg.data))
			s := msg.data.Summary
			if s.SkippedMalformed > 0 {
				st.summaryKey, st.summaryArgs = "summary.auditSkipped", []any{s.Returned, s.SkippedMalformed}
			} else {
				st.summaryKey, st.summaryArgs = "summary.audit", []any{s.Returned}
			}
		}
		if m.currentView == viewAudit {
			m.refreshDetail()
		}
		return m, nil
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
		// "clean" against the just-written baseline). The re-fetch is a pure READ.
		if msg.action.refetch != nil {
			return m, msg.action.refetch(m.cliPath)
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
	// A pending write action shows a confirm modal that swallows keys: y/Enter runs
	// it, n/Esc/q cancels. Nothing else acts while it is up (mirrors splash/help).
	// The engine's assertWritable gate — not this modal — is the real safety
	// boundary; the modal is the explicit-consent UX guard.
	if m.pending != nil {
		switch msg.String() {
		case "y", "enter":
			a := *m.pending
			m.pending = nil
			m.writeRunning = true
			m.writeStatus = ""
			return m, runWriteCmd(m.cliPath, a)
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
	case "]":
		m.clearFilter()
		m.currentView = (m.currentView + 1) % tabCount
		m.refreshDetail()
		return m, nil
	case "[":
		m.clearFilter()
		m.currentView = (m.currentView - 1 + tabCount) % tabCount
		m.refreshDetail()
		return m, nil
	case "tab":
		m.toggleFocus()
		return m, nil
	case "shift+tab":
		m.toggleFocus()
		return m, nil
	case "?":
		m.showHelp = true
		return m, nil
	case "w":
		if !m.writesEnabled {
			// Writes are opt-in and currently off — tell the user how to enable.
			m.writeStatus = tr("write.disabledHint")
			m.writeOK = false
			return m, nil
		}
		if wa, ok := writeActionFor(m.currentView); ok {
			m.pending = &wa
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
		return m, nil
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
			m.refreshDetail()
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
	case "pgdown", "f", "d":
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
	case "pgdown", "f", "d":
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
	cliFlag := flag.String("cli", "", "path to the claude-mgr Node CLI entry (src/cli.mjs)")
	flag.Parse()

	cliPath := resolveCLIPath(*cliFlag)

	// Headless paths (--probe/--snapshot/--splash/--icons) never run View(), so
	// uiLang stays at its langEN default: diagnostic output is English by design.
	if *probe {
		os.Exit(runProbe(cliPath))
	}

	configureColor()

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

	// Mouse capture is intentionally NOT enabled: the splash is dismissed by any
	// key (handleKey), and leaving mouse reporting off preserves the terminal's
	// native text selection / copy while the TUI runs.
	m := initialModel(cliPath)
	cfg := loadConfig() // restore TUI preferences chosen on a previous launch
	m.lang = cfg.lang()
	m.writesEnabled = cfg.WritesEnabled
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
	inv, err := fetchInventory(cliPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "snapshot error: %v\n", err)
		return 1
	}
	data, detailErr := fetchDetail(cliPath)

	m := model{ // loading=false, err=nil → inventory content path
		inv:     inv,
		cliPath: cliPath,
		sections: map[viewID]*sectionState{
			viewConflicts:   {list: newSectionModel(nil)},
			viewOrphans:     {list: newSectionModel(nil)},
			viewConfig:      {list: newSectionModel(nil)},
			viewHooks:       {list: newSectionModel(nil)},
			viewSelftest:    {list: newSectionModel(nil)},
			viewDoctor:      {list: newSectionModel(nil)},
			viewPermissions: {list: newSectionModel(nil)},
			viewDrift:       {list: newSectionModel(nil)},
			viewAudit:       {list: newSectionModel(nil)},
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
	inv, err := fetchInventory(cliPath)
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
		// TODO: SetColorProfile is a v1 compat shim; migrate to lipgloss.NewRenderer when adopting renderer injection.
		lipgloss.SetColorProfile(termenv.TrueColor)
	}
}

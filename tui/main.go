package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// inventoryMsg carries the result of the async counts fetch into the Update
// loop. Exactly one of inv / err is meaningful (err != nil means the fetch
// failed). This drives the headless --probe/--snapshot counts and the health
// pill; the interactive Inventory browser is driven by componentsMsg.
type inventoryMsg struct {
	inv Inventory
	err error
}

// componentsMsg carries the result of the async `inventory --detail` fetch:
// the full component list that populates the Inventory master pane. Exactly one
// of comps / err is meaningful.
type componentsMsg struct {
	comps []Component
	err   error
}

// focusPane identifies which split pane currently receives j/k + arrow keys on
// the Inventory tab. Tab/Shift+Tab toggles between them.
type focusPane int

const (
	focusList   focusPane = iota // left master list
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

// model holds the TUI state: the fetched inventory + components, fetch errors
// (if any), loading flags, the resolved CLI path, the active tab, the Inventory
// split-pane widgets (list/viewport/spinner) and which pane has focus, plus the
// last-known terminal dimensions.
type model struct {
	inv         Inventory
	err         error
	loading     bool // counts fetch in flight
	cliPath     string
	currentView viewID
	width       int
	height      int

	// Inventory split-pane state.
	components  []Component
	compErr     error
	compLoading bool // `inventory --detail` fetch in flight
	list        list.Model
	detail      viewport.Model
	spinner     spinner.Model
	focus       focusPane
}

func initialModel(cliPath string) model {
	return model{
		loading:     true,
		compLoading: true,
		cliPath:     cliPath,
		currentView: viewInventory,
		width:       defaultWidth,
		list:        newComponentList(),
		detail:      viewport.New(0, 0),
		spinner:     newSpinner(),
		focus:       focusList,
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

// fetchComponentsCmd returns a tea.Cmd that fetches the full component list
// (`inventory --detail`) and reports the outcome back as a componentsMsg.
func fetchComponentsCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		comps, err := fetchComponents(cliPath)
		return componentsMsg{comps: comps, err: err}
	}
}

// Init kicks off both async fetches (counts + components) and starts the
// spinner ticking so the Inventory area animates while the detail fetch runs.
func (m model) Init() tea.Cmd {
	return tea.Batch(fetchCmd(m.cliPath), fetchComponentsCmd(m.cliPath), m.spinner.Tick)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case inventoryMsg:
		m.loading = false
		m.inv = msg.inv
		m.err = msg.err
		return m, nil
	case componentsMsg:
		m.compLoading = false
		m.components = msg.comps
		m.compErr = msg.err
		m.list.SetItems(componentItems(msg.comps))
		m.refreshDetail()
		return m, nil
	case spinner.TickMsg:
		// Keep ticking only while a fetch is still in flight.
		if m.compLoading || m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
		return m, nil
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
//	(1) quit keys (q / ctrl+c / esc);
//	(2) section switching — number keys 1-6 jump directly, "[" / "]" cycle;
//	(3) Tab / Shift+Tab toggle focus between the list and detail panes;
//	(4) everything else (j/k, arrows, g/G, pgup/pgdn) routes to the focused
//	    pane (list moves the selection, viewport scrolls).
//
// Tab no longer switches sections (that was the U1 binding) — it now toggles
// pane focus, resolving the U2a conflict.
func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit
	case "]":
		m.currentView = (m.currentView + 1) % tabCount
		return m, nil
	case "[":
		m.currentView = (m.currentView - 1 + tabCount) % tabCount
		return m, nil
	case "tab":
		m.toggleFocus()
		return m, nil
	case "shift+tab":
		m.toggleFocus()
		return m, nil
	}
	if v, ok := digitToView(msg.String()); ok {
		m.currentView = v
		return m, nil
	}
	return m.routeToPane(msg)
}

// toggleFocus flips focus between the list and detail panes. Only meaningful on
// the Inventory tab today, but cheap and harmless elsewhere.
func (m *model) toggleFocus() {
	if m.focus == focusList {
		m.focus = focusDetail
	} else {
		m.focus = focusList
	}
}

// routeToPane forwards navigation keys to whichever pane has focus. On the
// Inventory tab the list pane owns selection movement (and a moved selection
// refreshes the detail content live); the detail pane owns scrolling. On other
// tabs there is nothing to navigate yet, so the key is swallowed.
func (m model) routeToPane(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.currentView != viewInventory {
		return m, nil
	}
	var cmd tea.Cmd
	if m.focus == focusList {
		prev := m.list.Index()
		m.list, cmd = m.list.Update(msg)
		if m.list.Index() != prev {
			m.refreshDetail()
		}
	} else {
		m.detail, cmd = m.detail.Update(msg)
	}
	return m, cmd
}

// digitToView maps "1".."6" to the matching viewID. Returns ok=false for any
// other key so the caller leaves the current view unchanged.
func digitToView(s string) (viewID, bool) {
	if len(s) != 1 {
		return 0, false
	}
	d := viewID(s[0] - '1')
	if d < 0 || d >= tabCount {
		return 0, false
	}
	return d, true
}

func (m model) View() string {
	return dashboardView(m)
}

func main() {
	probe := flag.Bool("probe", false, "headless: fetch data, print counts as plain text, exit (no TUI)")
	snapshot := flag.Bool("snapshot", false, "headless: fetch data, render the styled View() frame to stdout, exit (no TUI)")
	cliFlag := flag.String("cli", "", "path to the claude-mgr Node CLI entry (src/cli.mjs)")
	flag.Parse()

	cliPath := resolveCLIPath(*cliFlag)

	if *probe {
		os.Exit(runProbe(cliPath))
	}

	configureColor()

	if *snapshot {
		os.Exit(runSnapshot(cliPath))
	}

	p := tea.NewProgram(initialModel(cliPath), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error running TUI: %v\n", err)
		os.Exit(1)
	}
}

// runSnapshot fetches the inventory counts AND the component list, builds a
// loaded model, renders View() to stdout, and exits. Distinct from --probe
// (plain text counts) — this renders the actual styled lipgloss frame for
// non-TTY inspection. The frame shows the default view (Inventory) as the
// split-pane master-detail browser, at defaultWidth (no WindowSizeMsg arrives
// in a pipe), so layoutPanes() is invoked manually to size the widgets.
//
// The component list is populated from whatever config dir resolves by default
// (the live `~/.claude`). With no real config dir the list would be empty, but
// the two-pane LAYOUT (bordered list + bordered detail) is always rendered.
func runSnapshot(cliPath string) int {
	inv, err := fetchInventory(cliPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "snapshot error: %v\n", err)
		return 1
	}
	comps, compErr := fetchComponents(cliPath)

	m := model{ // loading=false, err=nil → inventory content path
		inv:         inv,
		cliPath:     cliPath,
		currentView: viewInventory,
		width:       defaultWidth,
		height:      defaultHeight,
		components:  comps,
		compErr:     compErr,
		list:        newComponentList(),
		detail:      viewport.New(0, 0),
		spinner:     newSpinner(),
		focus:       focusList,
	}
	m.list.SetItems(componentItems(comps))
	m.layoutPanes()
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

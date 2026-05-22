package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// inventoryMsg carries the result of the async fetch into the Update loop.
// Exactly one of inv / err is meaningful (err != nil means the fetch failed).
type inventoryMsg struct {
	inv Inventory
	err error
}

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

// model holds the TUI state: the fetched inventory, a fetch error (if any),
// a loading flag, the resolved CLI path used by the fetch command, the active
// tab, and the last-known terminal dimensions.
type model struct {
	inv         Inventory
	err         error
	loading     bool
	cliPath     string
	currentView viewID
	width       int
	height      int
}

func initialModel(cliPath string) model {
	return model{
		loading:     true,
		cliPath:     cliPath,
		currentView: viewInventory,
		width:       defaultWidth,
	}
}

// fetchCmd returns a tea.Cmd that fetches the inventory and reports the outcome
// back to Update as an inventoryMsg.
func fetchCmd(cliPath string) tea.Cmd {
	return func() tea.Msg {
		inv, err := fetchInventory(cliPath)
		return inventoryMsg{inv: inv, err: err}
	}
}

func (m model) Init() tea.Cmd {
	return fetchCmd(m.cliPath)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case inventoryMsg:
		m.loading = false
		m.inv = msg.inv
		m.err = msg.err
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

// handleKey routes keypresses: quit keys, tab/shift+tab cycling (with wrap),
// and number keys 1-6 jumping directly to a tab.
func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit
	case "tab", "right", "l":
		m.currentView = (m.currentView + 1) % tabCount
		return m, nil
	case "shift+tab", "left", "h":
		m.currentView = (m.currentView - 1 + tabCount) % tabCount
		return m, nil
	}
	if v, ok := digitToView(msg.String()); ok {
		m.currentView = v
	}
	return m, nil
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

// runSnapshot fetches the inventory, builds a loaded model, renders View() to
// stdout, and exits. Distinct from --probe (plain text counts) — this renders
// the actual styled lipgloss frame for non-TTY inspection. The frame shows the
// default view (Inventory) with the tab bar and status bar, at defaultWidth
// (no WindowSizeMsg arrives in a pipe).
func runSnapshot(cliPath string) int {
	inv, err := fetchInventory(cliPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "snapshot error: %v\n", err)
		return 1
	}
	m := model{ // loading=false, err=nil → inventory content path
		inv:         inv,
		cliPath:     cliPath,
		currentView: viewInventory,
		width:       defaultWidth,
	}
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

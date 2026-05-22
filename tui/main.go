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

// model holds the TUI state: the fetched inventory, a fetch error (if any),
// a loading flag, and the resolved CLI path used by the fetch command.
type model struct {
	inv     Inventory
	err     error
	loading bool
	cliPath string
}

func initialModel(cliPath string) model {
	return model{loading: true, cliPath: cliPath}
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
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m model) View() string {
	if m.loading {
		return loadingView()
	}
	if m.err != nil {
		return errorView(m.err)
	}
	return inventoryView(m.inv)
}

func main() {
	probe := flag.Bool("probe", false, "headless: fetch data, print counts as plain text, exit (no TUI)")
	cliFlag := flag.String("cli", "", "path to the claude-mgr Node CLI entry (src/cli.mjs)")
	flag.Parse()

	cliPath := resolveCLIPath(*cliFlag)

	if *probe {
		os.Exit(runProbe(cliPath))
	}

	configureColor()

	p := tea.NewProgram(initialModel(cliPath))
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error running TUI: %v\n", err)
		os.Exit(1)
	}
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

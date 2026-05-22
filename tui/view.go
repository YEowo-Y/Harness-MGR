package main

import (
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"
)

// Palette — a small set of styles shared across views.
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#7D56F4"))

	labelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888"))

	valueStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FFFFFF"))

	healthyStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#2ECC71")) // green

	warnStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#F1C40F")) // yellow

	errStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#E74C3C")) // red

	footerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888"))

	panelStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#7D56F4")).
			Padding(1, 2)

	errPanelStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#E74C3C")).
			Padding(1, 2)
)

// countLabelWidth is the column width reserved for count labels so values align.
const countLabelWidth = 14

// loadingView is shown while the initial fetch is in flight.
func loadingView() string {
	return panelStyle.Render(titleStyle.Render("claude-mgr") + "\n\nloading…")
}

// errorView renders a red bordered panel carrying the fetch error message.
func errorView(err error) string {
	body := titleStyle.Render("claude-mgr") + "\n\n" +
		errStyle.Render(glyph("✗", "[x]")+" failed to load inventory") + "\n\n" +
		err.Error() + "\n\n" +
		footerStyle.Render("q quit")
	return errPanelStyle.Render(body)
}

// inventoryView renders the main bordered panel: title, aligned counts, a
// one-line health summary, and a footer hint.
func inventoryView(inv Inventory) string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("claude-mgr — inventory"))
	b.WriteString("\n\n")
	b.WriteString(countsBlock(inv.Result.Counts))
	b.WriteString("\n")
	b.WriteString(healthSummary(inv.Diagnostics))
	b.WriteString("\n\n")
	b.WriteString(footerStyle.Render("q quit"))

	return panelStyle.Render(b.String())
}

// countsBlock renders each count as an aligned "label   value" row.
func countsBlock(c Counts) string {
	rows := []struct {
		label string
		value int
	}{
		{"skills", c.Skills},
		{"agents", c.Agents},
		{"commands", c.Commands},
		{"plugins", c.Plugins},
		{"marketplaces", c.Marketplaces},
		{"mcp servers", c.McpServers},
	}

	var b strings.Builder
	for _, r := range rows {
		label := labelStyle.Render(padRight(r.label, countLabelWidth))
		b.WriteString(label)
		b.WriteString(valueStyle.Render(fmt.Sprintf("%d", r.value)))
		b.WriteString("\n")
	}
	return b.String()
}

// healthSummary turns diagnostic counts into a single colored status line.
func healthSummary(diags []Diagnostic) string {
	errors, warnings := countDiagnostics(diags)
	switch {
	case errors > 0:
		return errStyle.Render(fmt.Sprintf("%s %d error(s), %d warning(s)", glyph("✗", "[x]"), errors, warnings))
	case warnings > 0:
		return warnStyle.Render(fmt.Sprintf("%s %d warning(s)", glyph("⚠", "[!]"), warnings))
	default:
		return healthyStyle.Render(glyph("✓", "[ok]") + " healthy")
	}
}

// padRight pads s with spaces to at least width runes (rune-aware, no allocation).
func padRight(s string, width int) string {
	n := width - utf8.RuneCountInString(s)
	if n <= 0 {
		return s
	}
	return s + strings.Repeat(" ", n)
}

// glyph returns a Unicode symbol when running under Windows Terminal (WT_SESSION
// is set), and an ASCII fallback for legacy conhost which cannot render ✓ ⚠ ✗.
func glyph(unicode, ascii string) string {
	if os.Getenv("WT_SESSION") != "" {
		return unicode
	}
	return ascii
}

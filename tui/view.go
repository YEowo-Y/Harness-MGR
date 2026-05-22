package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"
)

// ── Palette ──────────────────────────────────────────────────────────────────
// Accent: soft cyan-teal. Secondary: a slightly cooler slate for group headers.
// Dim neutral for labels/subtitles/footer. Semantic colours only for health.

var (
	accent    = lipgloss.Color("#2DD4BF") // teal — title, numbers, border, bars
	secondary = lipgloss.Color("#94A3B8") // slate — group headers (one step up from dim)
	dim       = lipgloss.Color("#4B5563") // muted neutral — labels, footer, config path
	leader    = lipgloss.Color("#374151") // near-invisible — dot-leader fill

	colorGreen = lipgloss.Color("#34D399")
	colorAmber = lipgloss.Color("#FBBF24")
	colorRed   = lipgloss.Color("#F87171")

	// pill background colours — near-black text on saturated bg for contrast.
	pillBgGreen = lipgloss.Color("#065F46")
	pillBgAmber = lipgloss.Color("#78350F")
	pillBgRed   = lipgloss.Color("#7F1D1D")
	pillFg      = lipgloss.Color("#F9FAFB") // near-white text on pill
)

// ── Styles ───────────────────────────────────────────────────────────────────

var (
	accentBarStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	titleStyle     = lipgloss.NewStyle().Bold(true).Foreground(accent)
	subtitleStyle  = lipgloss.NewStyle().Foreground(secondary)
	configStyle    = lipgloss.NewStyle().Foreground(dim)

	groupHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	labelStyle       = lipgloss.NewStyle().Foreground(dim)
	leaderStyle      = lipgloss.NewStyle().Foreground(leader)
	numStyle         = lipgloss.NewStyle().Bold(true).Foreground(accent)

	keyStyle    = lipgloss.NewStyle().Foreground(secondary) // keys slightly brighter than footer
	footerStyle = lipgloss.NewStyle().Foreground(dim)

	cardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(1, 3).
			Width(52)

	errCardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorRed).
			Padding(1, 3).
			Width(52)
)

// ── Layout constants ──────────────────────────────────────────────────────────
// innerWidth = card Width(52) − 2×Padding(3) = 46 printable columns.
// numWidth reserves 4 cols for right-aligned counts (supports up to 9999).
// Dot-leader fills whatever remains between label and number.

const (
	innerWidth = 46
	numWidth   = 4
)

// ── Entry points ──────────────────────────────────────────────────────────────

func loadingView() string {
	body := accentBar() + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory") +
		"\n\n" + configStyle.Render("loading…")
	return cardStyle.Render(body)
}

func errorView(err error) string {
	body := accentBar() + titleStyle.Render("claude-mgr") + "\n\n" +
		lipgloss.NewStyle().Bold(true).Foreground(colorRed).
			Render(glyph("✗", "[x]")+" failed to load inventory") + "\n\n" +
		configStyle.Render(err.Error()) + "\n\n" +
		renderFooter()
	return errCardStyle.Render(body)
}

// inventoryView: header → Components group → Plugins & MCP group → health pill → footer.
func inventoryView(inv Inventory) string {
	var b strings.Builder

	b.WriteString(header(inv))
	b.WriteString("\n\n")
	b.WriteString(componentsGroup(inv.Result.Counts))
	b.WriteString("\n")
	b.WriteString(pluginsGroup(inv.Result.Counts))
	b.WriteString("\n")
	b.WriteString(healthPill(inv.Diagnostics))
	b.WriteString("\n\n")
	b.WriteString(renderFooter())

	return cardStyle.Render(b.String())
}

// ── Header ────────────────────────────────────────────────────────────────────

func header(inv Inventory) string {
	line1 := accentBar() + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory")
	line2 := "  " + configStyle.Render(configDirHint())
	return line1 + "\n" + line2
}

// accentBar returns "▌ " (U+258C) in accent, or "| " on legacy conhost.
func accentBar() string {
	return accentBarStyle.Render(glyph("▌", "|")) + " "
}

// configDirHint returns a ~-collapsed, truncated path for the config dir.
func configDirHint() string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".claude")
	}
	home, _ := os.UserHomeDir()
	if home != "" && strings.HasPrefix(dir, home) {
		dir = "~" + dir[len(home):]
	}
	const maxLen = innerWidth - 4
	if utf8.RuneCountInString(dir) > maxLen {
		runes := []rune(dir)
		dir = "…" + string(runes[len(runes)-(maxLen-1):])
	}
	return dir
}

// ── Count groups ──────────────────────────────────────────────────────────────

func componentsGroup(c Counts) string {
	var b strings.Builder
	b.WriteString(groupHeaderStyle.Render(glyph("▌", "|")+" Components") + "\n")
	b.WriteString(countRow("skills", c.Skills))
	b.WriteString(countRow("agents", c.Agents))
	b.WriteString(countRow("commands", c.Commands))
	return b.String()
}

func pluginsGroup(c Counts) string {
	var b strings.Builder
	b.WriteString(groupHeaderStyle.Render(glyph("▌", "|")+" Plugins & MCP") + "\n")
	b.WriteString(countRow("plugins", c.Plugins))
	b.WriteString(countRow("marketplaces", c.Marketplaces))
	b.WriteString(countRow("mcp servers", c.McpServers))
	return b.String()
}

// countRow renders:  "  label ····················  NNN\n"
// label is dim-left; dot-leader fills the gap; number is bold-accent right-aligned.
// The total visible width is innerWidth columns.
func countRow(label string, value int) string {
	num := fmt.Sprintf("%d", value)

	// 2 (indent) + labelLen + leaderLen + numWidth = innerWidth
	// leaderLen must be ≥ 1 (at least one dot for readability).
	indent := 2
	labelLen := utf8.RuneCountInString(label)
	leaderLen := innerWidth - indent - labelLen - numWidth
	if leaderLen < 1 {
		leaderLen = 1
	}

	dot := glyph("·", ".")
	leaders := strings.Repeat(dot, leaderLen)
	numPadded := padLeft(num, numWidth)

	return strings.Repeat(" ", indent) +
		labelStyle.Render(label) +
		leaderStyle.Render(leaders) +
		numStyle.Render(numPadded) +
		"\n"
}

// ── Health pill ───────────────────────────────────────────────────────────────

// healthPill renders a background-colored pill (Padding(0,1)) for the health status.
func healthPill(diags []Diagnostic) string {
	errors, warnings := countDiagnostics(diags)

	var text string
	var bg, fg lipgloss.Color

	switch {
	case errors > 0:
		text = fmt.Sprintf(" %s  %d ERROR(S)  %d WARNING(S) ", glyph("✗", "[x]"), errors, warnings)
		bg, fg = pillBgRed, pillFg
	case warnings > 0:
		text = fmt.Sprintf(" %s  %d WARNING(S) ", glyph("⚠", "[!]"), warnings)
		bg, fg = pillBgAmber, pillFg
	default:
		text = " " + glyph("✓", "[ok]") + "  HEALTHY "
		bg, fg = pillBgGreen, pillFg
	}

	pill := lipgloss.NewStyle().
		Background(bg).
		Foreground(fg).
		Bold(true).
		Padding(0, 1).
		Render(text)
	return pill
}

// ── Footer ────────────────────────────────────────────────────────────────────

func renderFooter() string {
	q := keyStyle.Render("q")
	arrows := keyStyle.Render("↑↓")
	dot := footerStyle.Render("·")
	return q + footerStyle.Render(" quit  "+dot+"  ") +
		arrows + footerStyle.Render(" navigate (soon)")
}

// ── String helpers ────────────────────────────────────────────────────────────

// padLeft pads s to at least width runes with leading spaces.
func padLeft(s string, width int) string {
	n := width - utf8.RuneCountInString(s)
	if n <= 0 {
		return s
	}
	return strings.Repeat(" ", n) + s
}

// glyph returns the Unicode symbol under Windows Terminal (WT_SESSION set),
// and an ASCII fallback for legacy conhost.
func glyph(unicode, ascii string) string {
	if os.Getenv("WT_SESSION") != "" {
		return unicode
	}
	return ascii
}

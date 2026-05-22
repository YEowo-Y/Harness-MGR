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
// ONE accent (soft cyan-teal), ONE dim neutral, semantic health colours only.
// lipgloss downsamples truecolor hex to the terminal's actual capability.

var (
	// accent: soft cyan-teal — used for title, numbers, border.
	accent = lipgloss.Color("#2DD4BF")
	// dim: muted neutral — labels, subtitles, footer.
	dim = lipgloss.Color("#6B7280")
	// semantic health — green / amber / red.
	colorGreen  = lipgloss.Color("#34D399")
	colorAmber  = lipgloss.Color("#FBBF24")
	colorRed    = lipgloss.Color("#F87171")
	colorWhite  = lipgloss.Color("#F9FAFB")
	colorBorder = lipgloss.Color("#2DD4BF") // same as accent, named for intent
)

// ── Base styles ──────────────────────────────────────────────────────────────

var (
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	subtitleStyle = lipgloss.NewStyle().Foreground(dim)

	groupHeaderStyle = lipgloss.NewStyle().
				Foreground(dim).
				Bold(false)

	labelStyle = lipgloss.NewStyle().Foreground(dim)

	numStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent)

	healthyStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorGreen)

	warnStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorAmber)

	errStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorRed)

	footerStyle = lipgloss.NewStyle().Foreground(dim)

	// outer card: rounded border in accent, generous padding.
	cardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(1, 3).
			Width(46)

	errCardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorRed).
			Padding(1, 3).
			Width(46)

	// health banner: a small padded pill inside the card.
	healthBannerStyle = lipgloss.NewStyle().
				Padding(0, 2).
				Bold(true)

	// faint rule drawn by a repeated dim character.
	ruleStyle = lipgloss.NewStyle().Foreground(dim)
)

// ── Layout constants ─────────────────────────────────────────────────────────

const (
	// innerWidth is card.Width minus 2×padding(3) = 46-6 = 40 printable cols.
	innerWidth    = 40
	labelColWidth = 18 // label column; value is right-aligned in remaining space.
)

// ── Entry points ─────────────────────────────────────────────────────────────

func loadingView() string {
	body := titleStyle.Render("claude-mgr") + "\n\n" +
		subtitleStyle.Render("loading inventory…")
	return cardStyle.Render(body)
}

func errorView(err error) string {
	body := titleStyle.Render("claude-mgr") + "\n\n" +
		errStyle.Render(glyph("✗", "[x]")+" failed to load inventory") + "\n\n" +
		subtitleStyle.Render(err.Error()) + "\n\n" +
		footerStyle.Render("q quit")
	return errCardStyle.Render(body)
}

// inventoryView is the main view: header / two count groups / health / footer.
func inventoryView(inv Inventory) string {
	var b strings.Builder

	b.WriteString(header(inv))
	b.WriteString("\n")
	b.WriteString(rule())
	b.WriteString("\n")
	b.WriteString(componentsGroup(inv.Result.Counts))
	b.WriteString("\n")
	b.WriteString(pluginsGroup(inv.Result.Counts))
	b.WriteString("\n")
	b.WriteString(rule())
	b.WriteString("\n")
	b.WriteString(healthBanner(inv.Diagnostics))
	b.WriteString("\n\n")
	b.WriteString(footer())

	return cardStyle.Render(b.String())
}

// ── Header ────────────────────────────────────────────────────────────────────

func header(inv Inventory) string {
	title := titleStyle.Render("claude-mgr") +
		"  " +
		subtitleStyle.Render("inventory")
	sub := subtitleStyle.Render(configDirHint(inv))
	return title + "\n" + sub
}

// configDirHint derives a short display path from the inventory data.
// The JSON envelope does not carry configDir directly, so we show the
// CLAUDE_CONFIG_DIR env (if set) or the conventional ~/.claude fallback.
func configDirHint(inv Inventory) string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".claude")
	}
	// Collapse home dir to ~
	home, _ := os.UserHomeDir()
	if home != "" && strings.HasPrefix(dir, home) {
		dir = "~" + dir[len(home):]
	}
	// Truncate if very long
	if utf8.RuneCountInString(dir) > innerWidth-2 {
		runes := []rune(dir)
		dir = "…" + string(runes[len(runes)-(innerWidth-3):])
	}
	return dir
}

// ── Faint rule ────────────────────────────────────────────────────────────────

func rule() string {
	return ruleStyle.Render(strings.Repeat("─", innerWidth))
}

// ── Count groups ──────────────────────────────────────────────────────────────

func componentsGroup(c Counts) string {
	var b strings.Builder
	b.WriteString(groupHeaderStyle.Render("  Components") + "\n")
	b.WriteString(countRow("skills", c.Skills))
	b.WriteString(countRow("agents", c.Agents))
	b.WriteString(countRow("commands", c.Commands))
	return b.String()
}

func pluginsGroup(c Counts) string {
	var b strings.Builder
	b.WriteString(groupHeaderStyle.Render("  Plugins & MCP") + "\n")
	b.WriteString(countRow("plugins", c.Plugins))
	b.WriteString(countRow("marketplaces", c.Marketplaces))
	b.WriteString(countRow("mcp servers", c.McpServers))
	return b.String()
}

// countRow renders one "• label            N" row.
// The bullet is WT-aware; label is dim+left-padded; number is accent+bold+right-aligned.
func countRow(label string, value int) string {
	bullet := glyph("•", "-")
	num := fmt.Sprintf("%d", value)

	// Space budget: 2 (bullet+space) + labelColWidth + gap + numWidth
	// We right-align the number in the remaining space after the label col.
	numWidth := 4 // reserves up to 9999; sufficient for any real harness
	labelPadded := padRight(label, labelColWidth)
	numPadded := padLeft(num, numWidth)

	row := "  " +
		subtitleStyle.Render(bullet+" ") +
		labelStyle.Render(labelPadded) +
		numStyle.Render(numPadded)
	return row + "\n"
}

// ── Health banner ─────────────────────────────────────────────────────────────

func healthBanner(diags []Diagnostic) string {
	errors, warnings := countDiagnostics(diags)

	var text string
	var style lipgloss.Style

	switch {
	case errors > 0:
		text = fmt.Sprintf("%s  %d error(s)  %d warning(s)", glyph("✗", "[x]"), errors, warnings)
		style = healthBannerStyle.Foreground(colorRed).BorderForeground(colorRed)
	case warnings > 0:
		text = fmt.Sprintf("%s  %d warning(s)", glyph("⚠", "[!]"), warnings)
		style = healthBannerStyle.Foreground(colorAmber).BorderForeground(colorAmber)
	default:
		text = glyph("✓", "[ok]") + "  healthy"
		style = healthBannerStyle.Foreground(colorGreen).BorderForeground(colorGreen)
	}

	_ = colorWhite // reserved for future use (light-bg adaptation)
	return style.Render(text)
}

// ── Footer ────────────────────────────────────────────────────────────────────

func footer() string {
	return footerStyle.Render("q quit  ·  ↑↓ navigate (soon)")
}

// ── String helpers ────────────────────────────────────────────────────────────

// padRight pads s to at least width runes with trailing spaces (no allocation path).
func padRight(s string, width int) string {
	n := width - utf8.RuneCountInString(s)
	if n <= 0 {
		return s
	}
	return s + strings.Repeat(" ", n)
}

// padLeft pads s to at least width runes with leading spaces.
func padLeft(s string, width int) string {
	n := width - utf8.RuneCountInString(s)
	if n <= 0 {
		return s
	}
	return strings.Repeat(" ", n) + s
}

// glyph returns the Unicode symbol under Windows Terminal (WT_SESSION set),
// and an ASCII fallback for legacy conhost which cannot render ✓ ⚠ ✗ •.
func glyph(unicode, ascii string) string {
	if os.Getenv("WT_SESSION") != "" {
		return unicode
	}
	return ascii
}

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// ── Palette ───────────────────────────────────────────────────────────────────
// Two accents: teal (Components) + violet (Plugins & MCP).
// One light-gray for labels (readable, not muddy). Near-invisible for leaders.
// Semantic green/amber/red only for health.

var (
	accent  = lipgloss.Color("#2DD4BF") // teal  — title, Components, border, footer keys
	accent2 = lipgloss.Color("#A78BFA") // violet — Plugins & MCP group

	labelGray  = lipgloss.Color("#9CA3AF") // bright enough to read easily
	configGray = lipgloss.Color("#6B7280") // config dir / subtitle — one step dimmer
	footerGray = lipgloss.Color("#6B7280") // footer surrounding text
	leaderDim  = lipgloss.Color("#374151") // near-invisible dot leaders

	colorGreen = lipgloss.Color("#34D399")
	colorAmber = lipgloss.Color("#FBBF24")
	colorRed   = lipgloss.Color("#F87171")

	// Pill backgrounds — dark saturated; near-white fg for contrast.
	pillBgGreen = lipgloss.Color("#065F46")
	pillBgAmber = lipgloss.Color("#78350F")
	pillBgRed   = lipgloss.Color("#7F1D1D")
	pillFg      = lipgloss.Color("#F9FAFB")
)

// ── Styles ────────────────────────────────────────────────────────────────────

var (
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(accent)
	subtitleStyle = lipgloss.NewStyle().Foreground(configGray)
	configStyle   = lipgloss.NewStyle().Foreground(configGray)

	// Group headers — bold, each in its own accent.
	compHeaderStyle    = lipgloss.NewStyle().Bold(true).Foreground(accent)
	pluginsHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(accent2)

	labelStyle  = lipgloss.NewStyle().Foreground(labelGray)
	leaderStyle = lipgloss.NewStyle().Foreground(leaderDim)

	// Number styles — bold, each group's accent.
	numStyleComp    = lipgloss.NewStyle().Bold(true).Foreground(accent)
	numStylePlugins = lipgloss.NewStyle().Bold(true).Foreground(accent2)

	keyStyle    = lipgloss.NewStyle().Foreground(accent)     // q, ↑↓ in teal
	footerStyle = lipgloss.NewStyle().Foreground(footerGray) // surrounding footer text

	cardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(2, 4).
			Width(64)

	errCardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorRed).
			Padding(2, 4).
			Width(64)
)

// ── Layout constants ──────────────────────────────────────────────────────────
// innerWidth = card Width(64) − 2×Padding(4) = 56 printable columns.
// numWidth reserves 4 cols (supports counts up to 9999).

const (
	innerWidth = 56
	numWidth   = 4
)

// ── Glyph helper ─────────────────────────────────────────────────────────────

// unicodeEnabled reports whether the terminal supports Unicode glyphs.
// We use lipgloss's detected color profile as the signal: any profile above
// Ascii (i.e. ANSI, ANSI256, TrueColor) proves the terminal handles escape
// sequences and modern encoding — Unicode glyphs are safe. This correctly
// handles terminals (like the user's) that support Unicode+color but do NOT
// set WT_SESSION.
func unicodeEnabled() bool {
	return lipgloss.ColorProfile() != termenv.Ascii
}

// glyph returns the Unicode symbol when color/Unicode is enabled, and the
// ASCII fallback only when running in a true no-color environment (TERM=dumb,
// NO_COLOR, or a pipe with no color profile).
func glyph(uni, ascii string) string {
	if unicodeEnabled() {
		return uni
	}
	return ascii
}

// ── Entry points ──────────────────────────────────────────────────────────────

func loadingView() string {
	body := accentBar(accent) + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory") +
		"\n\n" + configStyle.Render("loading…")
	return cardStyle.Render(body)
}

func errorView(err error) string {
	errMsgStyle := lipgloss.NewStyle().Bold(true).Foreground(colorRed)
	body := accentBar(accent) + titleStyle.Render("claude-mgr") + "\n\n" +
		errMsgStyle.Render(glyph("✗", "[x]")+" failed to load inventory") + "\n\n" +
		configStyle.Render(err.Error()) + "\n\n" +
		renderFooter()
	return errCardStyle.Render(body)
}

// inventoryView: header → Components group → Plugins & MCP group → health → footer.
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
	line1 := accentBar(accent) + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory")
	line2 := "  " + configStyle.Render(configDirHint())
	_ = inv // reserved: could surface inv.Command or statusLine later
	return line1 + "\n" + line2
}

// accentBar returns "▌ " in the given color, or "| " on no-color terminals.
func accentBar(color lipgloss.Color) string {
	return lipgloss.NewStyle().Bold(true).Foreground(color).Render(glyph("▌", "|")) + " "
}

// configDirHint returns a ~-collapsed, truncated config dir path.
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
	b.WriteString(compHeaderStyle.Render(glyph("▌", "|")+" Components") + "\n")
	b.WriteString(countRow("skills", c.Skills, numStyleComp))
	b.WriteString(countRow("agents", c.Agents, numStyleComp))
	b.WriteString(countRow("commands", c.Commands, numStyleComp))
	return b.String()
}

func pluginsGroup(c Counts) string {
	var b strings.Builder
	b.WriteString(pluginsHeaderStyle.Render(glyph("▌", "|")+" Plugins & MCP") + "\n")
	b.WriteString(countRow("plugins", c.Plugins, numStylePlugins))
	b.WriteString(countRow("marketplaces", c.Marketplaces, numStylePlugins))
	b.WriteString(countRow("mcp servers", c.McpServers, numStylePlugins))
	return b.String()
}

// countRow renders:  "  label ·················· NNN\n"
// The dot-leader fills innerWidth − indent(2) − labelLen − numWidth columns.
// numStyle is passed in so each group's numbers use its own accent color.
func countRow(label string, value int, numStyle lipgloss.Style) string {
	num := fmt.Sprintf("%d", value)

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

	return lipgloss.NewStyle().
		Background(bg).
		Foreground(fg).
		Bold(true).
		Padding(0, 1).
		Render(text)
}

// ── Footer ────────────────────────────────────────────────────────────────────

func renderFooter() string {
	dot := footerStyle.Render("·")
	return keyStyle.Render("q") + footerStyle.Render(" quit  "+dot+"  ") +
		keyStyle.Render(glyph("↑↓", "j/k")) + footerStyle.Render(" navigate (soon)")
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

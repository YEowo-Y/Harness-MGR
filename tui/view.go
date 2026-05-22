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

	// Chrome — tab bar + status bar surfaces.
	chromeBg  = lipgloss.Color("#111827") // dark bar background
	tabDim    = lipgloss.Color("#6B7280") // inactive tab text
	statusDim = lipgloss.Color("#9CA3AF") // status-bar text
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

	keyStyle    = lipgloss.NewStyle().Foreground(accent)     // key hints in teal
	footerStyle = lipgloss.NewStyle().Foreground(footerGray) // surrounding footer text

	// Placeholder text for not-yet-built tabs.
	placeholderStyle = lipgloss.NewStyle().Foreground(configGray).Italic(true)

	// Tab-bar cells.
	activeTabStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(chromeBg).
			Background(accent).
			Padding(0, 2)
	inactiveTabStyle = lipgloss.NewStyle().
				Foreground(tabDim).
				Background(chromeBg).
				Padding(0, 2)
)

// ── Layout ──────────────────────────────────────────────────────────────────
// The content card width derives from the terminal width via cardWidth(); the
// printable inner width derives from that via innerWidth(). numWidth reserves 4
// cols (supports counts up to 9999).

const (
	numWidth   = 4
	minCard    = 60
	maxCard    = 100
	cardPadX   = 4 // cardStyle horizontal padding (each side)
	cardBorder = 2 // rounded border (1 col each side)
)

// cardWidth clamps the terminal width into [minCard, maxCard], leaving a small
// margin (width-4) so the bordered card never touches the terminal edges.
func cardWidth(termWidth int) int {
	w := termWidth - 4
	if w < minCard {
		w = minCard
	}
	if w > maxCard {
		w = maxCard
	}
	return w
}

// innerWidth returns the printable column count inside the card for a given
// card width: card width − border (2) − horizontal padding (2×4).
func innerWidth(cardW int) int {
	return cardW - cardBorder - 2*cardPadX
}

// cardStyleFor builds the rounded teal content card at the given card width.
func cardStyleFor(cardW int) lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(accent).
		Padding(2, cardPadX).
		Width(cardW - cardBorder)
}

// errCardStyleFor builds the rounded red error card at the given card width.
func errCardStyleFor(cardW int) lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorRed).
		Padding(2, cardPadX).
		Width(cardW - cardBorder)
}

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

// ── Dashboard shell ────────────────────────────────────────────────────────────

// dashboardView is the top-level composer: tab bar, the active tab's content,
// and the status bar, stacked vertically with the status bar pinned to the
// bottom of the terminal.
func dashboardView(m model) string {
	cardW := cardWidth(m.width)

	tabBar := tabBarView(m.currentView, m.width)
	content := contentView(m, cardW)
	statusBar := statusBarView(m.width)

	content = padContent(tabBar, content, statusBar, m.height)

	return lipgloss.JoinVertical(lipgloss.Left, tabBar, content, statusBar)
}

// contentView renders the active tab's body inside the content card. Loading
// and error states (only meaningful on the Inventory tab, which owns the fetch)
// take precedence there.
func contentView(m model, cardW int) string {
	if m.currentView == viewInventory {
		switch {
		case m.loading:
			return loadingView(cardW)
		case m.err != nil:
			return errorView(m.err, cardW)
		default:
			return inventoryView(m.inv, cardW)
		}
	}
	return placeholderView(m.currentView, cardW)
}

// padContent inserts blank lines between the content block and the status bar
// so the status bar sits at the bottom of the terminal. When the terminal
// height is unknown (0) or too small, it returns the content unchanged and the
// status bar simply follows directly (a fine U1 fallback).
func padContent(tabBar, content, statusBar string, height int) string {
	if height <= 0 {
		return content
	}
	used := lipgloss.Height(tabBar) + lipgloss.Height(content) + lipgloss.Height(statusBar)
	gap := height - used
	if gap <= 0 {
		return content
	}
	return content + strings.Repeat("\n", gap)
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

// tabBarView renders the horizontal tab strip across the full terminal width:
// the active tab gets the accent background, inactive tabs are dim. Trailing
// space fills the bar to the terminal width on the chrome background.
func tabBarView(active viewID, termWidth int) string {
	cells := make([]string, 0, len(tabLabels))
	for i, label := range tabLabels {
		text := fmt.Sprintf("%d %s", i+1, label)
		if viewID(i) == active {
			cells = append(cells, activeTabStyle.Render(text))
		} else {
			cells = append(cells, inactiveTabStyle.Render(text))
		}
	}
	bar := lipgloss.JoinHorizontal(lipgloss.Top, cells...)

	if termWidth <= 0 {
		return bar
	}
	used := lipgloss.Width(bar)
	if used < termWidth {
		filler := lipgloss.NewStyle().
			Background(chromeBg).
			Render(strings.Repeat(" ", termWidth-used))
		bar = bar + filler
	}
	return bar
}

// ── Status bar ─────────────────────────────────────────────────────────────────

// statusBarView renders the bottom hint bar spanning the full terminal width.
func statusBarView(termWidth int) string {
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")
	hint := keyStyle.Render("Tab/1-6") + lipgloss.NewStyle().Foreground(statusDim).Render(" switch") +
		sep +
		keyStyle.Render("q") + lipgloss.NewStyle().Foreground(statusDim).Render(" quit") +
		sep +
		lipgloss.NewStyle().Foreground(statusDim).Render("? help (soon)")

	style := lipgloss.NewStyle().
		Background(chromeBg).
		Foreground(statusDim).
		Padding(0, 1)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(hint)
}

// ── Inventory view (Inventory tab) ──────────────────────────────────────────────

func loadingView(cardW int) string {
	body := accentBar(accent) + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory") +
		"\n\n" + configStyle.Render("loading…")
	return cardStyleFor(cardW).Render(body)
}

func errorView(err error, cardW int) string {
	errMsgStyle := lipgloss.NewStyle().Bold(true).Foreground(colorRed)
	body := accentBar(accent) + titleStyle.Render("claude-mgr") + "\n\n" +
		errMsgStyle.Render(glyph("✗", "[x]")+" failed to load inventory") + "\n\n" +
		configStyle.Render(err.Error()) + "\n\n" +
		renderHint()
	return errCardStyleFor(cardW).Render(body)
}

// inventoryView: header → Components group → Plugins & MCP group → health.
func inventoryView(inv Inventory, cardW int) string {
	inner := innerWidth(cardW)

	var b strings.Builder
	b.WriteString(header(inv, inner))
	b.WriteString("\n\n")
	b.WriteString(componentsGroup(inv.Result.Counts, inner))
	b.WriteString("\n")
	b.WriteString(pluginsGroup(inv.Result.Counts, inner))
	b.WriteString("\n")
	b.WriteString(healthPill(inv.Diagnostics))

	return cardStyleFor(cardW).Render(b.String())
}

// ── Placeholder views (Conflicts/Orphans/Config/Hooks/Selftest) ────────────────

// placeholderView renders a dim centered "<tab> — coming soon" message inside a
// content card visually consistent with the inventory card (same border/padding).
func placeholderView(v viewID, cardW int) string {
	inner := innerWidth(cardW)
	label := strings.ToLower(tabLabels[int(v)])

	title := accentBar(accent) + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render(label)
	msg := placeholderStyle.Render(label + " — coming soon")
	centered := lipgloss.PlaceHorizontal(inner, lipgloss.Center, msg)

	body := title + "\n\n\n" + centered + "\n\n"
	return cardStyleFor(cardW).Render(body)
}

// ── Header ────────────────────────────────────────────────────────────────────

func header(inv Inventory, inner int) string {
	line1 := accentBar(accent) + titleStyle.Render("claude-mgr") +
		"  " + subtitleStyle.Render("inventory")
	line2 := "  " + configStyle.Render(configDirHint(inner))
	_ = inv // reserved: could surface inv.Command or statusLine later
	return line1 + "\n" + line2
}

// accentBar returns "▌ " in the given color, or "| " on no-color terminals.
func accentBar(color lipgloss.Color) string {
	return lipgloss.NewStyle().Bold(true).Foreground(color).Render(glyph("▌", "|")) + " "
}

// configDirHint returns a ~-collapsed, truncated config dir path that fits the
// printable inner width.
func configDirHint(inner int) string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".claude")
	}
	home, _ := os.UserHomeDir()
	if home != "" && strings.HasPrefix(dir, home) {
		dir = "~" + dir[len(home):]
	}
	maxLen := inner - 4
	if maxLen < 1 {
		maxLen = 1
	}
	if utf8.RuneCountInString(dir) > maxLen {
		runes := []rune(dir)
		dir = "…" + string(runes[len(runes)-(maxLen-1):])
	}
	return dir
}

// ── Count groups ──────────────────────────────────────────────────────────────

func componentsGroup(c Counts, inner int) string {
	var b strings.Builder
	b.WriteString(compHeaderStyle.Render(glyph("▌", "|")+" Components") + "\n")
	b.WriteString(countRow("skills", c.Skills, numStyleComp, inner))
	b.WriteString(countRow("agents", c.Agents, numStyleComp, inner))
	b.WriteString(countRow("commands", c.Commands, numStyleComp, inner))
	return b.String()
}

func pluginsGroup(c Counts, inner int) string {
	var b strings.Builder
	b.WriteString(pluginsHeaderStyle.Render(glyph("▌", "|")+" Plugins & MCP") + "\n")
	b.WriteString(countRow("plugins", c.Plugins, numStylePlugins, inner))
	b.WriteString(countRow("marketplaces", c.Marketplaces, numStylePlugins, inner))
	b.WriteString(countRow("mcp servers", c.McpServers, numStylePlugins, inner))
	return b.String()
}

// countRow renders:  "  label ·················· NNN\n"
// The dot-leader fills inner − indent(2) − labelLen − numWidth columns.
// numStyle is passed in so each group's numbers use its own accent color.
func countRow(label string, value int, numStyle lipgloss.Style, inner int) string {
	num := fmt.Sprintf("%d", value)

	indent := 2
	labelLen := utf8.RuneCountInString(label)
	leaderLen := inner - indent - labelLen - numWidth
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

// ── Hint line (in-card) ─────────────────────────────────────────────────────────

// renderHint is the in-card key hint used on the error card (the global status
// bar carries the same role for the normal frames).
func renderHint() string {
	dot := footerStyle.Render("·")
	return keyStyle.Render("q") + footerStyle.Render(" quit  "+dot+"  ") +
		keyStyle.Render("Tab") + footerStyle.Render(" switch tab")
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

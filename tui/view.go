package main

import (
	"fmt"
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
	accent = lipgloss.Color("#2DD4BF") // teal — title, accents, focused border

	labelGray  = lipgloss.Color("#9CA3AF") // bright enough to read easily
	configGray = lipgloss.Color("#6B7280") // config dir / subtitle — one step dimmer
	leaderDim  = lipgloss.Color("#374151") // near-invisible dividers / dim border

	colorRed = lipgloss.Color("#F87171") // error text / error card border

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

	keyStyle = lipgloss.NewStyle().Foreground(accent) // key hints in teal

	// Placeholder text for not-yet-built tabs.
	placeholderStyle = lipgloss.NewStyle().Foreground(configGray).Italic(true)

	// Inventory list-row styles (custom delegate). Selected rows use the teal
	// accent; unselected titles are light-gray, descriptions dimmer.
	listTitleStyle    = lipgloss.NewStyle().Foreground(labelGray)
	listDescStyle     = lipgloss.NewStyle().Foreground(configGray)
	listSelTitleStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	listSelDescStyle  = lipgloss.NewStyle().Foreground(labelGray)

	// Detail-pane styles. Title in teal; field labels in gray; values default.
	detailTitleStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	detailLabelStyle = lipgloss.NewStyle().Foreground(labelGray)
	detailValueStyle = lipgloss.NewStyle().Foreground(statusDim)
	detailEmptyStyle = lipgloss.NewStyle().Foreground(configGray).Italic(true)

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
// The placeholder content card width derives from the terminal width via
// cardWidth(); the printable inner width derives from that via innerWidth().

const (
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
// Used by the placeholder ("coming soon") tabs.
func cardStyleFor(cardW int) lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(accent).
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

// contentView renders the active tab's body. The Inventory tab is the
// master-detail split-pane browser (driven by the `--detail` component fetch);
// the other five tabs remain the "coming soon" placeholder card.
func contentView(m model, cardW int) string {
	if m.currentView == viewInventory {
		return inventorySplitView(m)
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
// Hints reflect the U2a key model: 1-6 / [ ] switch sections, Tab toggles pane
// focus, j/k move within the focused pane, q quits.
func statusBarView(termWidth int) string {
	dim := lipgloss.NewStyle().Foreground(statusDim)
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")
	hint := keyStyle.Render("1-6/[ ]") + dim.Render(" section") +
		sep +
		keyStyle.Render("Tab") + dim.Render(" focus") +
		sep +
		keyStyle.Render("j/k") + dim.Render(" move") +
		sep +
		keyStyle.Render("q") + dim.Render(" quit")

	style := lipgloss.NewStyle().
		Background(chromeBg).
		Foreground(statusDim).
		Padding(0, 1)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(hint)
}

// ── Inventory split-pane view (Inventory tab) ───────────────────────────────────
//
// The Inventory tab is a master-detail browser: the bubbles/list on the left
// and the bubbles/viewport on the right, each in a bordered box. The focused
// pane gets a teal border; the unfocused pane a dim border. The two boxes are
// joined horizontally and sit between the tab bar and the status bar.

// paneBorderStyle returns a rounded-border box styled for a pane: teal when
// focused, dim otherwise. Width/Height set the OUTER box size (content area is
// inner = size − border − padding); horizontal padding matches panePadX.
func paneBorderStyle(focused bool, boxW, boxH int) lipgloss.Style {
	border := leaderDim
	if focused {
		border = accent
	}
	s := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(border).
		Padding(0, panePadX)
	if boxW > paneBorder {
		s = s.Width(boxW - paneBorder)
	}
	if boxH > paneBorder {
		s = s.Height(boxH - paneBorder)
	}
	return s
}

// inventorySplitView composes the two panes side by side. While the component
// fetch is in flight a spinner shows in the list pane; a fetch error renders in
// both panes. The list pane width is ~42% of the model width; the detail pane
// takes the remainder. Heights derive from the model height (room left for the
// tab bar + status bar).
func inventorySplitView(m model) string {
	listW, detailW, boxH := m.splitDims()

	left := paneBorderStyle(m.focus == focusList, listW, boxH).
		Render(listPaneBody(m))
	right := paneBorderStyle(m.focus == focusDetail, detailW, boxH).
		Render(detailPaneBody(m))

	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

// listPaneBody renders the master pane's inner content: a spinner while loading,
// the fetch error, an empty-state hint, or the bubbles/list itself.
func listPaneBody(m model) string {
	switch {
	case m.compLoading:
		return m.spinner.View() + " " + configStyle.Render("loading components…")
	case m.compErr != nil:
		return lipgloss.NewStyle().Foreground(colorRed).
			Render(glyph("✗", "[x]")+" load failed") + "\n\n" +
			configStyle.Render(truncate(m.compErr.Error(), m.detail.Width))
	case len(m.components) == 0:
		return detailEmptyStyle.Render("no components found")
	default:
		return m.list.View()
	}
}

// detailPaneBody renders the detail pane's inner content: the bubbles/viewport
// showing the selected component's fields, or matching loading/error/empty
// states so the right pane never looks broken.
func detailPaneBody(m model) string {
	switch {
	case m.compLoading:
		return detailEmptyStyle.Render("…")
	case m.compErr != nil:
		return detailEmptyStyle.Render("—")
	case len(m.components) == 0:
		return detailEmptyStyle.Render("select a component")
	default:
		return m.detail.View()
	}
}

// detailContent builds the styled text for the detail viewport from a selected
// component: a teal title, then Kind / Source / Path field rows. width truncates
// the path so it never wraps awkwardly. With no selection it returns a hint.
func detailContent(c Component, ok bool, width int) string {
	if !ok {
		return detailEmptyStyle.Render("select a component on the left")
	}
	if width < 1 {
		width = defaultWidth
	}

	var b strings.Builder
	b.WriteString(detailTitleStyle.Render(truncate(c.Name, width)))
	b.WriteString("\n\n")
	b.WriteString(detailField("Kind", c.Kind, width))
	b.WriteString(detailField("Source", sourceSummary(c.Source), width))
	if p := strings.TrimSpace(c.Source.Plugin); p != "" {
		b.WriteString(detailField("Plugin", p, width))
	}
	b.WriteString(detailField("Path", c.Path, width))
	return b.String()
}

// detailField renders one "label  value" row, the value truncated to fit width.
func detailField(label, value string, width int) string {
	lbl := detailLabelStyle.Render(label)
	v := strings.TrimSpace(value)
	if v == "" {
		v = "—"
	}
	avail := width - lipgloss.Width(lbl) - 1
	if avail < 1 {
		avail = 1
	}
	return lbl + " " + detailValueStyle.Render(truncate(v, avail)) + "\n"
}

// sourceSummary describes a component's provenance: "tier" or "tier (plugin)".
func sourceSummary(s ComponentSource) string {
	tier := strings.TrimSpace(s.Tier)
	if tier == "" {
		tier = "—"
	}
	if p := strings.TrimSpace(s.Plugin); p != "" {
		return tier + " (" + p + ")"
	}
	return tier
}

// truncate shortens s to at most width runes, appending an ellipsis glyph when
// it had to cut. width <= 0 yields "".
func truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= width {
		return s
	}
	ell := glyph("…", "...")
	ellLen := utf8.RuneCountInString(ell)
	if width <= ellLen {
		runes := []rune(s)
		return string(runes[:width])
	}
	runes := []rune(s)
	return string(runes[:width-ellLen]) + ell
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

// ── Card chrome helper ──────────────────────────────────────────────────────────

// accentBar returns "▌ " in the given color, or "| " on no-color terminals.
// Used by the placeholder card header.
func accentBar(color lipgloss.Color) string {
	return lipgloss.NewStyle().Bold(true).Foreground(color).Render(glyph("▌", "|")) + " "
}

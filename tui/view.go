package main

import (
	"fmt"
	"strconv"
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
	subtitleStyle = lipgloss.NewStyle().Foreground(configGray)
	configStyle   = lipgloss.NewStyle().Foreground(configGray)

	keyStyle = lipgloss.NewStyle().Foreground(accent) // key hints in teal

	// Placeholder text for not-yet-built tabs.
	placeholderStyle = lipgloss.NewStyle().Foreground(configGray).Italic(true)

	// Detail-pane styles. Labels are dim so they recede; values are brighter so
	// they stand out — a color hierarchy within each row. (The per-type detail
	// title color is applied inline by detailTitle().)
	detailLabelStyle = lipgloss.NewStyle().Foreground(configGray)
	detailValueStyle = lipgloss.NewStyle().Foreground(labelGray)
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
	minCard        = 60
	maxCard        = 100
	cardPadX       = 4  // cardStyle horizontal padding (each side)
	cardBorder     = 2  // rounded border (1 col each side)
	detailLabelCol = 16 // fixed column width for detail-field labels (aligns values)
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

// ── Corner mascot (dashboard header) ────────────────────────────────────────

// mascotExtraRows is how many extra rows the multi-line mascot adds to the
// 1-line counts/summary bar region when shown: the sprite's line count minus the
// single bar row. Derived from splashMascot so the mascot's row count can change
// without desyncing the splitDims header-height reservation.
func mascotExtraRows() int {
	if n := len(splashMascot) - 1; n > 0 {
		return n
	}
	return 0
}

// mascotEligible reports the cheap precondition for the corner mascot: Unicode
// glyph support (else the sprite would be mojibake) and a known, positive
// terminal width. Whether the mascot actually shows is decided content-aware by
// model.mascotVisible, which additionally requires the header bar to still fit
// on one line once narrowed to make room for the sprite.
func mascotEligible(termWidth int) bool {
	return unicodeEnabled() && termWidth > 0
}

// mascotBarWidth is the width the header bar is rendered at when the mascot sits
// beside it: the terminal width minus the mascot block, floored at 1.
func mascotBarWidth(termWidth int) int {
	w := termWidth - mascotBlockWidth()
	if w < 1 {
		w = 1
	}
	return w
}

// barFitsOneLine reports whether a rendered counts/summary bar occupies exactly
// one row. A bar narrowed by mascotBarWidth wraps to two or more rows once its
// content no longer fits; the caller then drops the mascot and re-renders the
// bar at full width. This is the content-aware replacement for the old fixed
// width floor, and is pure (no Unicode/TTY dependency) so it is unit-testable.
func barFitsOneLine(bar string) bool {
	return lipgloss.Height(bar) == 1
}

// renderMascot returns the mascot cat as a solid-block sprite: each grid cell is
// a color KEY drawn as █ in its color (white eyes, dark pupils, brown nose, pink
// mouth, vibrant mosaic body — see mascotCellColor); '.' cells are transparent.
// blink selects the eyes-closed frame (splashMascotBlink), else the eyes-open
// splashMascot. NOT gated — callers gate via model.mascotVisible.
func renderMascot(blink bool) string {
	frame := splashMascot
	if blink {
		frame = splashMascotBlink
	}
	lines := make([]string, len(frame))
	for row, line := range frame {
		var b strings.Builder
		col := 0
		for _, key := range line {
			if key == '.' || key == ' ' {
				b.WriteRune(' ')
			} else {
				b.WriteString(lipgloss.NewStyle().Foreground(mascotCellColor(key, row, col)).Render("█"))
			}
			col++
		}
		lines[row] = b.String()
	}
	return strings.Join(lines, "\n")
}

// mascotBlockWidth is the display width of the rendered mascot block.
func mascotBlockWidth() int {
	w := 0
	for _, line := range splashMascot {
		if n := lipgloss.Width(line); n > w {
			w = n
		}
	}
	return w
}

// ── Dashboard shell ────────────────────────────────────────────────────────────

// dashboardView is the top-level composer: tab bar, the active tab's content,
// and the status bar, stacked vertically with the status bar pinned to the
// bottom of the terminal. On the Inventory tab a counts overview bar sits between
// the tab bar and the tree (composed inside contentView so the height math in
// padContent stays correct).
func dashboardView(m model) string {
	cardW := cardWidth(m.width)

	tabBar := tabBarView(m.currentView, m.width)
	content := contentView(m, cardW)
	statusBar := statusBarView(m.width)

	content = padContent(tabBar, content, statusBar, m.height)

	return lipgloss.JoinVertical(lipgloss.Left, tabBar, content, statusBar)
}

// contentView renders the active tab's body. The Inventory tab is the
// master-detail tree browser (driven by the `--detail` fetch) with a per-type
// color counts bar stacked above the split. Section tabs (Conflicts, Orphans)
// render a summary bar above a flat-list split pane. The other tabs remain
// "coming soon" placeholder cards.
func contentView(m model, cardW int) string {
	switch {
	case m.currentView == viewInventory:
		return lipgloss.JoinVertical(lipgloss.Left, m.headerView(), inventorySplitView(m))
	case isSectionView(m.currentView):
		return lipgloss.JoinVertical(lipgloss.Left, m.headerView(), sectionSplitView(m))
	default:
		return placeholderView(m.currentView, cardW)
	}
}

// headerBarBuilder returns a closure that renders the current tab's counts/
// summary bar at a given width, plus whether the current tab has such a bar.
// The Inventory and section tabs do; placeholder tabs do not. Routing both the
// header renderer (headerView) and the split-height reservation (splitDims)
// through one builder lets them rebuild the bar at any width and agree on the
// same mascot decision.
func (m model) headerBarBuilder() (func(width int) string, bool) {
	switch {
	case m.currentView == viewInventory:
		return func(w int) string { return countsBarView(m.inv.Result.Counts, w) }, true
	case isSectionView(m.currentView):
		return func(w int) string { return sectionSummaryBar(m.currentView, m.sections[m.currentView], w) }, true
	default:
		return nil, false
	}
}

// mascotVisible reports whether the corner mascot is shown for the current tab.
// The mascot must be eligible (Unicode on, known width) AND — content-aware —
// the active tab's header bar must still fit on one line once narrowed to leave
// room for the sprite. This is the single decision both headerView (which
// renders the header) and splitDims (which reserves mascotExtraRows) consult, so
// the rendered header height and the reserved split rows can never disagree (a
// mismatch would overflow the frame).
func (m model) mascotVisible() bool {
	build, ok := m.headerBarBuilder()
	if !ok || !mascotEligible(m.width) {
		return false
	}
	return barFitsOneLine(build(mascotBarWidth(m.width)))
}

// headerView renders the active tab's counts/summary bar. When mascotVisible()
// it narrows the bar by mascotBarWidth and joins the mascot sprite (at its
// current blink frame) to its right; the Inventory tab fills the freed band with
// a multi-line statsPanel sized to exactly the mascot's height (so the header
// height — and thus splitDims' reservation — is unchanged). Otherwise it returns
// the full-width bar unchanged. Placeholder tabs have no bar and yield "".
func (m model) headerView() string {
	build, ok := m.headerBarBuilder()
	if !ok {
		return ""
	}
	if !m.mascotVisible() {
		return build(m.width)
	}
	mascot := renderMascot(m.mascotBlink)
	barW := mascotBarWidth(m.width)
	left := build(barW)
	if m.currentView == viewInventory {
		left = statsPanel(m.inv.Result.Counts, barW, lipgloss.Height(mascot))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, left, mascot)
}

// ── Counts overview bar (Inventory tab) ─────────────────────────────────────

// countsSeg is one "<n> <label>" segment of the counts overview bar, tagged with
// its singular kind (for the type icon) and its type color.
type countsSeg struct {
	n     int
	label string // display label (plural)
	kind  string // singular type key for typeIcon
	fg    lipgloss.Color
}

// countsSegments returns the six type segments of the counts bar in display
// order, keeping the segment set and ordering in one place for countsBarView.
func countsSegments(c Counts) []countsSeg {
	return []countsSeg{
		{c.Skills, "skills", "skill", colorSkill},
		{c.Agents, "agents", "agent", colorAgent},
		{c.Commands, "commands", "command", colorCommand},
		{c.Plugins, "plugins", "plugin", colorPlugin},
		{c.Marketplaces, "marketplaces", "marketplace", colorMarketplace},
		{c.McpServers, "mcp", "mcp", colorMcp},
	}
}

// countsSep is the dim middle-dot separator between counts segments (3 columns).
const countsSep = " · "

// countsBarPadX is countsBarView's horizontal padding per side; it consumes
// 2*countsBarPadX columns of the bar width, leaving the remainder for content.
const countsBarPadX = 1

// countsSegString renders one counts segment as "<icon> <n> <label>" in its type
// color (bold count); the icon is dropped on no-Unicode terminals via glyph.
func countsSegString(s countsSeg) string {
	style := lipgloss.NewStyle().Foreground(s.fg)
	prefix := ""
	if icon := glyph(typeIcon(s.kind), ""); icon != "" {
		prefix = style.Render(icon) + " "
	}
	return prefix + style.Bold(true).Render(strconv.Itoa(s.n)) + style.Render(" "+s.label)
}

// statsPanel renders the multi-line Inventory overview that fills the header band
// beside the mascot: the gradient wordmark over the six type counts laid out two
// per row, padded/clamped to exactly height rows so the header height equals the
// mascot's (keeping splitDims' reservation valid). Each row is set to width AND
// clipped to a single line (MaxHeight 1) so a too-narrow width can't wrap a row
// and inflate the panel past height. A JoinHorizontal mascot sits flush right.
func statsPanel(c Counts, width, height int) string {
	segs := countsSegments(c)
	sep := lipgloss.NewStyle().Foreground(leaderDim).Render(countsSep)
	row := func(a, b countsSeg) string { return countsSegString(a) + sep + countsSegString(b) }
	lines := []string{
		brandWordmark(),
		row(segs[0], segs[1]),
		row(segs[2], segs[3]),
		row(segs[4], segs[5]),
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[:height]
	}
	rowStyle := lipgloss.NewStyle().Width(width).MaxHeight(1)
	for i := range lines {
		lines[i] = rowStyle.Render(lines[i])
	}
	return strings.Join(lines, "\n")
}

// countsBarView renders the single-line overview above the tree:
// "240 skills · 19 agents · 79 commands · 13 plugins · 4 marketplaces · 6 mcp",
// each "<n> <label>" segment colored in ITS TYPE COLOR (bold count), separated by
// a dim middle dot. Sourced from result.counts.
func countsBarView(c Counts, termWidth int) string {
	segs := countsSegments(c)
	sep := lipgloss.NewStyle().Foreground(leaderDim).Render(countsSep)
	parts := make([]string, 0, len(segs))
	for _, s := range segs {
		style := lipgloss.NewStyle().Foreground(s.fg)
		iconStr := glyph(typeIcon(s.kind), "")
		prefix := ""
		if iconStr != "" {
			prefix = style.Render(iconStr) + " "
		}
		parts = append(parts, prefix+style.Bold(true).Render(strconv.Itoa(s.n))+style.Render(" "+s.label))
	}
	counts := strings.Join(parts, sep)

	// Prepend the gradient wordmark only when it fits on one line with the
	// counts; on a narrow terminal keep the full counts rather than wrap the
	// chrome bar. Padding costs 2*countsBarPadX columns, so the content must fit
	// in termWidth-2*countsBarPadX. Unknown width (≤0) → include it (no
	// fixed-width wrap risk).
	line := counts
	withBrand := brandWordmark() + lipgloss.NewStyle().Foreground(leaderDim).Render("   ") + counts
	if termWidth <= 0 || lipgloss.Width(withBrand)+2*countsBarPadX <= termWidth {
		line = withBrand
	}

	style := lipgloss.NewStyle().Padding(0, countsBarPadX)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(line)
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
// Hints reflect the tree key model: Enter expands/collapses a folder (or selects
// an item), j/k move the cursor, Tab toggles pane focus, 1-6 / [ ] switch
// sections, q quits.
func statusBarView(termWidth int) string {
	dim := lipgloss.NewStyle().Foreground(statusDim)
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")
	hint := keyStyle.Render("Enter") + dim.Render(" expand") +
		sep +
		keyStyle.Render("j/k") + dim.Render(" move") +
		sep +
		keyStyle.Render("Tab") + dim.Render(" focus") +
		sep +
		keyStyle.Render("1-6") + dim.Render(" section") +
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
// The Inventory tab is a master-detail browser: the color-coded tree on the
// left and the detail viewport on the right, each in a bordered box. The focused
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

// inventorySplitView composes the two panes side by side. While the detail fetch
// is in flight a spinner shows in the tree pane; a fetch error renders in both
// panes. The tree pane width is ~42% of the model width; the detail pane takes
// the remainder. Heights derive from the model height (room left for the tab bar
// + counts bar + status bar).
func inventorySplitView(m model) string {
	treeW, detailW, boxH := m.splitDims()

	left := paneBorderStyle(m.focus == focusTree, treeW, boxH).
		Render(treePaneBody(m))
	right := paneBorderStyle(m.focus == focusDetail, detailW, boxH).
		Render(detailPaneBody(m))

	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

// treePaneBody renders the master pane's inner content: a spinner while loading,
// the fetch error, an empty-state hint, or the color-coded tree itself sized to
// the pane's inner dimensions.
func treePaneBody(m model) string {
	switch {
	case m.detailLoading:
		return m.spinner.View() + " " + configStyle.Render("loading inventory…")
	case m.detailErr != nil:
		return lipgloss.NewStyle().Foreground(colorRed).
			Render(glyph("✗", "[x]")+" load failed") + "\n\n" +
			configStyle.Render(truncate(m.detailErr.Error(), m.detail.Width))
	case len(m.tree.visible) == 0:
		return detailEmptyStyle.Render("no objects found")
	default:
		return m.tree.render(m.treeInnerW, m.treeInnerH)
	}
}

// detailPaneBody renders the detail pane's inner content: the bubbles/viewport
// showing the selected node's fields, or matching loading/error/empty states so
// the right pane never looks broken.
func detailPaneBody(m model) string {
	switch {
	case m.detailLoading:
		return detailEmptyStyle.Render("…")
	case m.detailErr != nil:
		return detailEmptyStyle.Render("—")
	case len(m.tree.visible) == 0:
		return detailEmptyStyle.Render("select an object")
	default:
		return m.detail.View()
	}
}

// detailContent builds the styled text for the detail viewport from the selected
// tree node, dispatching on its type and theming the title in the type color.
// width truncates values so they never wrap awkwardly. With no item selected
// (folder row or empty tree) it returns a hint.
func detailContent(n treeNode, ok bool, width int) string {
	if !ok {
		return detailEmptyStyle.Render("select an object on the left")
	}
	if width < 1 {
		width = defaultWidth
	}
	fg := kindMetas[n.kind].folderFg

	switch {
	case n.comp != nil:
		return componentDetail(*n.comp, fg, width)
	case n.plug != nil:
		return pluginDetail(*n.plug, fg, width)
	case n.mkt != nil:
		return marketplaceDetail(*n.mkt, fg, width)
	case n.mcp != nil:
		return mcpDetail(*n.mcp, fg, width)
	default:
		return detailEmptyStyle.Render("—")
	}
}

// componentDetail renders Name / Kind / Source / Path / Description for a
// skill/agent/command, titled in the type color.
func componentDetail(c Component, fg lipgloss.Color, width int) string {
	var b strings.Builder
	b.WriteString(detailTitle(c.Name, fg, typeIcon(c.Kind), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Provenance", fg, width))
	b.WriteString(detailField("Kind", c.Kind, width))
	b.WriteString(detailField("Source", sourceSummary(c.Source), width))
	if p := strings.TrimSpace(c.Source.Plugin); p != "" {
		b.WriteString(detailField("Plugin", p, width))
	}
	if mk := strings.TrimSpace(c.Source.Marketplace); mk != "" {
		b.WriteString(detailField("Marketplace", mk, width))
	}
	if v := strings.TrimSpace(c.Source.Version); v != "" {
		b.WriteString(detailField("Version", v, width))
	}

	b.WriteString("\n")
	b.WriteString(detailSection("Location", fg, width))
	b.WriteString(detailField("Path", c.Path, width))

	b.WriteString("\n")
	b.WriteString(detailSection("About", fg, width))
	b.WriteString(detailField("Description", c.Description, width))
	return b.String()
}

// pluginDetail renders Name / Key / Marketplace / Version / Enabled / Cache
// present for an installed plugin, titled in the plugin color.
func pluginDetail(p Plugin, fg lipgloss.Color, width int) string {
	var b strings.Builder
	b.WriteString(detailTitle(p.Name, fg, typeIcon("plugin"), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Identity", fg, width))
	b.WriteString(detailField("Key", p.Key, width))
	b.WriteString(detailField("Marketplace", p.Marketplace, width))
	b.WriteString(detailField("Version", p.Version, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Status", fg, width))
	b.WriteString(detailField("Enabled", boolText(p.Enabled), width))
	b.WriteString(detailField("Cache present", boolText(p.CachePresent), width))
	return b.String()
}

// marketplaceDetail renders Name / Source repo / On disk / Install location for
// a marketplace, titled in the marketplace color.
func marketplaceDetail(mk Marketplace, fg lipgloss.Color, width int) string {
	var b strings.Builder
	b.WriteString(detailTitle(mk.Name, fg, typeIcon("marketplace"), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Repository", fg, width))
	b.WriteString(detailField("Source repo", mk.SourceRepo, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Local", fg, width))
	b.WriteString(detailField("On disk", boolText(mk.OnDisk), width))
	b.WriteString(detailField("Install location", mk.InstallLocation, width))
	return b.String()
}

// mcpDetail renders Name / Transport / Scope / Command / Args for an MCP server,
// titled in the MCP color. Args are space-joined.
func mcpDetail(ms McpServer, fg lipgloss.Color, width int) string {
	var b strings.Builder
	b.WriteString(detailTitle(ms.Name, fg, typeIcon("mcp"), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Connection", fg, width))
	b.WriteString(detailField("Transport", ms.Transport, width))
	b.WriteString(detailField("Scope", ms.Scope, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Invocation", fg, width))
	b.WriteString(detailField("Command", ms.Command, width))
	b.WriteString(detailField("Args", strings.Join(ms.Args, " "), width))
	return b.String()
}

// detailTitle renders the detail header: a type-colored accent marker + the
// bold name, then a dim full-width rule beneath it. When icon is non-empty AND
// unicode is enabled, the icon is used as the marker in place of the ▌ bar.
// When icon is "" or unicode is off, the ▌ bar is kept unchanged.
func detailTitle(name string, fg lipgloss.Color, icon string, width int) string {
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(fg)
	var bar string
	if icon != "" && unicodeEnabled() {
		bar = titleStyle.Render(icon) + " "
	} else {
		bar = titleStyle.Render(glyph("▌", "|")) + " "
	}
	avail := width - lipgloss.Width(bar)
	if avail < 1 {
		avail = 1
	}
	ruleW := width
	if ruleW < 0 {
		ruleW = 0
	}
	rule := lipgloss.NewStyle().Foreground(leaderDim).
		Render(strings.Repeat(glyph("─", "-"), ruleW))
	return bar + titleStyle.Render(truncate(name, avail)) + "\n" + rule
}

// boolText renders a bool as "yes"/"no" for the detail rows.
func boolText(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// detailField renders one aligned "label  value" row. The label is padded to
// detailLabelCol columns so values always start at the same column. The value
// is truncated to the remaining available width.
func detailField(label, value string, width int) string {
	lbl := detailLabelStyle.Width(detailLabelCol).Render(label)
	v := strings.TrimSpace(value)
	if v == "" {
		v = "—"
	}
	avail := width - detailLabelCol - 1
	if avail < 1 {
		avail = 1
	}
	return lbl + " " + detailValueStyle.Render(truncate(v, avail)) + "\n"
}

// detailSection renders a sub-section header within a detail pane: a short
// type-colored bold label followed by a dim rule filling the remaining width.
// It groups related fields (e.g. "Provenance", "Location") so the detail reads
// as layered cards rather than a flat list. The label color ties the group to
// the object's type; the rule recedes (leaderDim) so it divides without noise.
// width <= 0 (or narrower than the label) yields just the label with no rule.
func detailSection(label string, fg lipgloss.Color, width int) string {
	name := lipgloss.NewStyle().Foreground(fg).Bold(true).Render(label)
	head := name + " "
	ruleW := width - lipgloss.Width(head)
	if ruleW < 0 {
		ruleW = 0
	}
	rule := lipgloss.NewStyle().Foreground(leaderDim).
		Render(strings.Repeat(glyph("─", "-"), ruleW))
	return head + rule + "\n"
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

	title := accentBar(accent) + brandWordmark() +
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

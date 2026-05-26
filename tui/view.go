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

	tabBar := tabBarView(m)
	content := contentView(m, cardW)
	// The / filter bar replaces the status bar while a filter is being typed or
	// is applied; both are a single chrome line so the height math is unchanged.
	statusBar := statusBarView(m)
	if m.filterMode || m.filterQuery != "" {
		statusBar = filterBarView(m)
	}

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

// mascotShelved hides the corner mascot — and the coupled health lockup — from
// the dashboard while the mascot design is on hold. While set, mascotVisible is
// always false, so headerView renders the plain one-line counts bar and splitDims
// reserves no extra rows. Set to false to bring the mascot (and the health line)
// back; the rendering code is preserved, just dormant.
var mascotShelved = true

// mascotVisible reports whether the corner mascot is shown for the current tab.
// The mascot must be eligible (Unicode on, known width) AND — content-aware —
// the active tab's header bar must still fit on one line once narrowed to leave
// room for the sprite. This is the single decision both headerView (which
// renders the header) and splitDims (which reserves mascotExtraRows) consult, so
// the rendered header height and the reserved split rows can never disagree (a
// mismatch would overflow the frame).
func (m model) mascotVisible() bool {
	if mascotShelved {
		return false
	}
	build, ok := m.headerBarBuilder()
	if !ok || !mascotEligible(m.width) {
		return false
	}
	return barFitsOneLine(build(mascotBarWidth(m.width)))
}

// headerView renders the active tab's header. When mascotVisible() it builds a
// multi-line LEFT COLUMN (the tab's 1-line counts/summary bar stacked above a
// compact health lockup), narrowed by mascotBarWidth, and joins the mascot sprite
// (at its current blink frame) to its right — the lockup fills the band the tall
// mascot would otherwise leave blank. Otherwise it returns the full-width 1-line
// bar unchanged — byte-for-byte the prior no-mascot header. Placeholder tabs have
// no bar and yield "".
func (m model) headerView() string {
	build, ok := m.headerBarBuilder()
	if !ok {
		return ""
	}
	if m.mascotVisible() {
		left := m.headerLeftColumn(build, mascotBarWidth(m.width))
		return lipgloss.JoinHorizontal(lipgloss.Top, left, renderMascot(m.mascotBlink))
	}
	return build(m.width)
}

// headerLeftColumn stacks the tab's 1-line counts/summary bar (row 0) above a
// compact, vertically-centered health lockup (the harness health verdict + the
// dim governance tagline), padded with blank rows to EXACTLY len(splashMascot)
// lines. Pinning the row count to the sprite height keeps the rendered header in
// lock-step with the splitDims reservation (chromeRows + mascotExtraRows), so the
// band is filled without ever overflowing the frame. Rendered at the given
// (already mascot-narrowed) width; every lockup line is clipped to one row via
// MaxHeight(1) so long text can never inflate the header height.
func (m model) headerLeftColumn(build func(width int) string, width int) string {
	total := len(splashMascot)
	if total < 1 {
		total = 1
	}
	line := lipgloss.NewStyle().Padding(0, countsBarPadX).Width(width).MaxHeight(1)
	content := []string{
		line.Render(m.healthVerdict()),
		line.Foreground(configGray).Render(tr("splash.tagline")),
	}

	rows := make([]string, 0, total)
	rows = append(rows, build(width)) // row 0: the tab's counts/summary bar
	topPad := (total - 1 - len(content)) / 2
	for i := 0; i < topPad && len(rows) < total; i++ {
		rows = append(rows, "")
	}
	for _, c := range content {
		if len(rows) >= total {
			break
		}
		rows = append(rows, c)
	}
	for len(rows) < total {
		rows = append(rows, "")
	}
	return strings.Join(rows, "\n")
}

// healthVerdict returns the one-line, color-coded harness health summary shown in
// the header band: a green tally when there are zero conflicts, orphans, and
// inventory diagnostics; an orange tally when any are present; a dim placeholder
// while the conflicts/orphans fetches (kicked off at Init) are still in flight or
// have errored. Counts come straight from the already-fetched model state — no
// extra plumbing: conflicts/orphans from their section item lists, diagnostics
// from the inventory result.
func (m model) healthVerdict() string {
	dim := lipgloss.NewStyle().Foreground(configGray)
	cSt := m.sections[viewConflicts]
	oSt := m.sections[viewOrphans]
	if m.loading || cSt == nil || oSt == nil || cSt.loading || oSt.loading {
		return dim.Render(glyph("◷", "~") + " checking harness…")
	}
	// A failed inventory fetch (m.err) leaves m.inv zero-valued, so the diagnostics
	// count would be a false 0; treat it — and section fetch errors — as unknown.
	if m.err != nil || cSt.err != nil || oSt.err != nil {
		return dim.Render(glyph("◌", "-") + " harness checks unavailable")
	}
	conflicts := len(cSt.list.items)
	orphans := len(oSt.list.items)
	diags := len(m.inv.Diagnostics)
	tally := plural(conflicts, "conflict") + " · " + plural(orphans, "orphan") + " · " + plural(diags, "diagnostic")
	mark, color := glyph("⚠", "!"), colorOrange
	if conflicts == 0 && orphans == 0 && diags == 0 {
		mark, color = glyph("✓", "OK"), colorPlugin
	}
	return lipgloss.NewStyle().Foreground(color).Bold(true).Render(mark + " " + tally)
}

// plural formats a count with its noun, appending "s" for any count other than 1
// ("0 orphans", "1 orphan", "2 orphans").
func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
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
		parts = append(parts, prefix+style.Bold(true).Render(strconv.Itoa(s.n))+style.Render(" "+tr("count."+s.label)))
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

// sectionReady returns a fetched, non-errored section for v, or ok=false while
// it is still loading, errored, or absent (so a badge never reflects stale/no
// data).
func sectionReady(m model, v viewID) (*sectionState, bool) {
	st := m.sections[v]
	if st == nil || st.loading || st.err != nil {
		return nil, false
	}
	return st, true
}

// sectionItemCount is the number of rows in section v (0 when not ready).
func sectionItemCount(m model, v viewID) int {
	st, ok := sectionReady(m, v)
	if !ok {
		return 0
	}
	return len(st.list.items)
}

// sectionHasColor reports whether any row in section v carries the target color
// (the per-row colors encode severity — see the color→severity map).
func sectionHasColor(m model, v viewID, target lipgloss.Color) bool {
	st, ok := sectionReady(m, v)
	if !ok {
		return false
	}
	for _, it := range st.list.items {
		if it.color == target {
			return true
		}
	}
	return false
}

// tabBadge returns the severity color for a small health dot on tab v, and
// ok=false when the tab has nothing notable to flag. Derived entirely from
// already-fetched data: red = errors/overbroad/failing checks; orange = warnings/
// findings/conflicts/orphans/drift/inventory-diagnostics. Informational tabs
// (Config/Hooks/Audit) and any still-loading or errored section never badge.
func tabBadge(m model, v viewID) (lipgloss.Color, bool) {
	switch v {
	case viewInventory:
		// Guard on loading/err so the badge never reflects a zero-valued inventory
		// before the counts fetch lands (mirrors healthVerdict's gating).
		if !m.loading && m.err == nil && len(m.inv.Diagnostics) > 0 {
			return colorOrange, true
		}
	case viewConflicts, viewOrphans, viewDrift:
		if sectionItemCount(m, v) > 0 {
			return colorOrange, true
		}
	case viewSelftest, viewPermissions:
		// Only RED rows are findings worth flagging: failing self-tests and
		// overbroad-allow permission rules. Orange "ask" permission rows are benign
		// (they merely prompt), so Permissions deliberately does NOT badge on them;
		// selftest has no orange rows.
		if sectionHasColor(m, v, colorRed) {
			return colorRed, true
		}
	case viewDoctor:
		if sectionHasColor(m, v, colorRed) {
			return colorRed, true
		}
		if sectionHasColor(m, v, colorOrange) {
			return colorOrange, true
		}
	}
	return "", false
}

// tabBarView renders the horizontal tab strip across the full terminal width:
// the active tab gets the accent background, inactive tabs are dim, and any tab
// whose data has notable findings carries a small severity dot (red error /
// amber warn). Trailing space fills the bar to the terminal width on the chrome
// background.
func tabBarView(m model) string {
	active := m.currentView
	termWidth := m.width
	cells := make([]string, 0, len(tabLabels))
	for i := range tabLabels {
		v := viewID(i)
		// The number-key that jumps to this tab: 1..9 for the first nine, 0 for the
		// tenth — matching digitToView's "1-9 then 0" convention.
		text := fmt.Sprintf("%d %s", (i+1)%10, tabLabel(v))

		cellStyle := inactiveTabStyle
		bg := chromeBg
		if v == active {
			cellStyle = activeTabStyle
			bg = accent
		}
		// Append a severity dot when this tab has notable findings. The dot is
		// rendered with its OWN foreground over the cell's background so it stays
		// the right color inside the cell (the cell style would otherwise recolor it).
		content := text
		if sev, ok := tabBadge(m, v); ok {
			dot := lipgloss.NewStyle().Foreground(sev).Background(bg).Render(glyph("●", "*"))
			content = text + " " + dot
		}
		cells = append(cells, cellStyle.Render(content))
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
// Normally it shows the navigation hints; a tab that offers a write action also
// advertises "w <verb>". When a write has just completed, a transient result line
// (green ✓ / red ✗) takes over the bar until the next keypress.
func statusBarView(m model) string {
	style := lipgloss.NewStyle().
		Background(chromeBg).
		Foreground(statusDim).
		Padding(0, 1)
	if m.width > 0 {
		style = style.Width(m.width)
	}

	// Transient write feedback takes over the bar (cleared on the next key).
	if m.writeStatus != "" {
		mark, col := glyph("✓", "OK"), colorPlugin
		if !m.writeOK {
			mark, col = glyph("✗", "x"), colorRed
		}
		line := lipgloss.NewStyle().Foreground(col).Bold(true).Render(mark + " " + m.writeStatus)
		return style.Render(line)
	}
	// While a write runs, show a brief working line.
	if m.writeRunning {
		return style.Render(lipgloss.NewStyle().Foreground(accent).Render(tr("write.running")))
	}

	dim := lipgloss.NewStyle().Foreground(statusDim)
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")
	hint := keyStyle.Render("Enter") + dim.Render(" "+tr("status.expand")) +
		sep +
		keyStyle.Render("j/k") + dim.Render(" "+tr("status.move")) +
		sep +
		keyStyle.Render("Tab") + dim.Render(" "+tr("status.focus")) +
		sep +
		keyStyle.Render("1-0") + dim.Render(" "+tr("status.section")) +
		sep +
		keyStyle.Render("/") + dim.Render(" "+tr("status.filter"))
	// Write-mode indicator (always shown): the W toggle + its current state. Only
	// when write mode is ON does a write-capable tab also advertise its "w <verb>".
	modeStyle := dim
	modeLabel := tr("status.writesOff")
	if m.writesEnabled {
		modeStyle = dim.Foreground(colorPlugin) // copy-on-write from dim, not a fresh alloc
		modeLabel = tr("status.writesOn")
	}
	hint += sep + keyStyle.Render("W") + modeStyle.Render(" "+modeLabel)
	if m.writesEnabled {
		if wa, ok := writeActionFor(m.currentView); ok {
			hint += sep + keyStyle.Render("w") + dim.Render(" "+tr(wa.hintKey))
		}
	}
	hint += sep +
		keyStyle.Render("?") + dim.Render(" "+tr("status.help")) +
		sep +
		keyStyle.Render("q") + dim.Render(" "+tr("status.quit"))

	return style.Render(hint)
}

// filterBarView renders the / filter bar that replaces the status bar while a
// filter is being typed or applied: the query (with a cursor while typing) plus
// the relevant key hints, all via tr(). One line, full width, on the chrome
// surface; clipped to one row so a long query can never inflate the height.
func filterBarView(m model) string {
	dim := lipgloss.NewStyle().Foreground(statusDim)
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")

	cursor := ""
	if m.filterMode {
		cursor = lipgloss.NewStyle().Foreground(accent).Render("▌")
	}
	left := lipgloss.NewStyle().Bold(true).Foreground(accent).Render(tr("filter.label")) +
		" " + lipgloss.NewStyle().Foreground(labelGray).Render(m.filterQuery) + cursor

	var hint string
	if m.filterMode {
		hint = keyStyle.Render("Enter") + dim.Render(" "+tr("filter.apply")) + sep +
			keyStyle.Render("Esc") + dim.Render(" "+tr("filter.clear"))
	} else {
		hint = keyStyle.Render("/") + dim.Render(" "+tr("filter.edit")) + sep +
			keyStyle.Render("Esc") + dim.Render(" "+tr("filter.clear"))
	}

	style := lipgloss.NewStyle().Background(chromeBg).Padding(0, 1).MaxHeight(1)
	if m.width > 0 {
		style = style.Width(m.width)
	}
	return style.Render(left + sep + hint)
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
		return m.spinner.View() + " " + configStyle.Render(tr("loading.inventory"))
	case m.detailErr != nil:
		return lipgloss.NewStyle().Foreground(colorRed).
			Render(glyph("✗", "[x]")+" "+tr("loading.failed")) + "\n\n" +
			configStyle.Render(truncate(m.detailErr.Error(), m.detail.Width))
	case len(m.tree.visible) == 0:
		if m.tree.filter != "" {
			return detailEmptyStyle.Render(tr("empty.noMatch"))
		}
		return detailEmptyStyle.Render(tr("empty.objects"))
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
		return detailEmptyStyle.Render(tr("empty.selectObject"))
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
		return detailEmptyStyle.Render(tr("empty.selectObjectLeft"))
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

// detailField renders one aligned "label  value" block. The label is padded to
// detailLabelCol columns so values always start at the same column. The value
// is word-wrapped to the remaining available width (multi-line); continuation
// lines are aligned under the value column via JoinHorizontal(Top, …).
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
	val := detailValueStyle.Width(avail).Render(v)
	return lipgloss.JoinHorizontal(lipgloss.Top, lbl, " ", val) + "\n"
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
	label := strings.ToLower(tabLabel(v))

	title := accentBar(accent) + brandWordmark() +
		"  " + subtitleStyle.Render(label)
	msg := placeholderStyle.Render(label + " — " + tr("placeholder.comingSoon"))
	centered := lipgloss.PlaceHorizontal(inner, lipgloss.Center, msg)

	body := title + "\n\n\n" + centered + "\n\n"
	return cardStyleFor(cardW).Render(body)
}

// ── Help overlay ─────────────────────────────────────────────────────────────

// helpView renders the full-screen keyboard-shortcuts overlay shown while
// model.showHelp is set (toggled with ?). It mirrors the splash's centered card
// and routes every label through tr() so it follows the active language. Guards
// width<1 / height<1 to never panic.
func helpView(width, height int) string {
	if width < 1 || height < 1 {
		return ""
	}
	keyCol := lipgloss.NewStyle().Foreground(accent).Bold(true).Width(10)
	descCol := lipgloss.NewStyle().Foreground(labelGray)
	rows := []struct{ key, desc string }{
		{"j / k", tr("help.move")},
		{"Enter", tr("help.activate")},
		{"Tab", tr("help.focus")},
		{"1-0", tr("help.jump")},
		{"[ / ]", tr("help.tabs")},
		{"/", tr("help.filter")},
		{"w", tr("help.write")},
		{"W", tr("help.writeMode")},
		{"?", tr("help.help")},
		{"q / Esc", tr("status.quit")},
	}

	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(accent).Render(tr("help.title")))
	b.WriteString("\n\n")
	for _, r := range rows {
		b.WriteString(keyCol.Render(r.key) + descCol.Render(r.desc) + "\n")
	}
	b.WriteString("\n" + lipgloss.NewStyle().Foreground(configGray).Render(tr("help.dismiss")))

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(accent).
		Padding(1, 3).
		Render(b.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// ── Card chrome helper ──────────────────────────────────────────────────────────

// accentBar returns "▌ " in the given color, or "| " on no-color terminals.
// Used by the placeholder card header.
func accentBar(color lipgloss.Color) string {
	return lipgloss.NewStyle().Bold(true).Foreground(color).Render(glyph("▌", "|")) + " "
}

package main

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ── Inventory split-pane: list item + delegate ──────────────────────────────────
//
// The Inventory tab is a master-detail browser: a bubbles/list on the left
// (componentItem rows) and a bubbles/viewport on the right (the selected
// component's detail). This file owns the list item, its render delegate, the
// widget constructors, the layout/sizing math, the live detail refresh, and the
// two-pane composition. The model/state/wiring lives in main.go.

// componentItem adapts a Component to bubbles/list's Item interface. It renders
// as a two-line row: title "[kind] name" and a description (path, or the source
// tier/plugin when the path is empty). FilterValue is provided for U2b's filter
// (kind + name + path), though filtering is disabled in U2a.
type componentItem struct {
	c Component
}

// FilterValue satisfies list.Item. Combines the searchable surface text so the
// U2b filter can match on kind, name, or path.
func (i componentItem) FilterValue() string {
	return i.c.Kind + " " + i.c.Name + " " + i.c.Path
}

// title is the primary row text: "[kind] name".
func (i componentItem) title() string {
	return "[" + i.c.Kind + "] " + i.c.Name
}

// desc is the secondary row text: the absolute path when present, else a
// "tier · plugin" provenance summary, else just the tier.
func (i componentItem) desc() string {
	if p := strings.TrimSpace(i.c.Path); p != "" {
		return p
	}
	if pl := strings.TrimSpace(i.c.Source.Plugin); pl != "" {
		return strings.TrimSpace(i.c.Source.Tier) + " · " + pl
	}
	return strings.TrimSpace(i.c.Source.Tier)
}

// componentItems wraps a []Component into the []list.Item the list consumes.
func componentItems(comps []Component) []list.Item {
	items := make([]list.Item, 0, len(comps))
	for _, c := range comps {
		items = append(items, componentItem{c: c})
	}
	return items
}

// ── Item delegate ───────────────────────────────────────────────────────────────

// componentDelegate is a custom list.ItemDelegate rendering each row as a teal
// (or, when selected, accent-highlighted) title line plus a dim description
// line, truncated to the list width. It deliberately avoids bubbles' heavier
// DefaultDelegate so the row styling matches the existing palette precisely.
type componentDelegate struct {
	width int
}

// Height is 2 (title + description lines).
func (d componentDelegate) Height() int { return 2 }

// Spacing is 1 blank line between rows for readability.
func (d componentDelegate) Spacing() int { return 1 }

// Update is a no-op: this delegate has no per-item interactive state.
func (d componentDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }

// Render draws one row. The cursor row gets a leading "▌ " accent bar and
// accent-colored title; other rows are dim. Both lines are truncated to the
// available width so long paths never wrap and break the layout.
func (d componentDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	ci, ok := item.(componentItem)
	if !ok {
		return
	}

	selected := index == m.Index()
	avail := d.width
	if avail < 1 {
		avail = 1
	}

	var titleLine, descLine string
	if selected {
		bar := lipgloss.NewStyle().Bold(true).Foreground(accent).Render(glyph("▌", ">")) + " "
		title := listSelTitleStyle.Render(truncate(ci.title(), avail-2))
		titleLine = bar + title
		descLine = "  " + listSelDescStyle.Render(truncate(ci.desc(), avail-2))
	} else {
		titleLine = "  " + listTitleStyle.Render(truncate(ci.title(), avail-2))
		descLine = "  " + listDescStyle.Render(truncate(ci.desc(), avail-2))
	}

	fmt.Fprint(w, titleLine+"\n"+descLine)
}

// ── Widget constructors ──────────────────────────────────────────────────────────

// newComponentList builds the master list with our custom delegate and all of
// bubbles' built-in chrome disabled (title, status bar, pagination, help,
// filtering) — U2a renders its own frame and footer. The list's own quit
// keybindings are disabled so the model owns q/esc. j/k, arrows, g/G, and
// pgup/pgdn navigation remain wired by bubbles. h/l are dropped from the page
// keybindings so they do not collide with future use and stay inert here.
func newComponentList() list.Model {
	l := list.New(nil, componentDelegate{}, 0, 0)
	l.SetShowTitle(false)
	l.SetShowStatusBar(false)
	l.SetShowPagination(false)
	l.SetShowHelp(false)
	l.SetShowFilter(false)
	l.SetFilteringEnabled(false)
	l.DisableQuitKeybindings()
	l.KeyMap.PrevPage.SetKeys("pgup", "b", "u")
	l.KeyMap.NextPage.SetKeys("pgdown", "f", "d")
	return l
}

// newSpinner builds the loading spinner used while `inventory --detail` runs.
func newSpinner() spinner.Model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(accent)
	return s
}

// ── Layout / sizing ──────────────────────────────────────────────────────────────

const (
	// paneBorder is the column/row cost of a rounded border (1 each side).
	paneBorder = 2
	// panePadX is the horizontal padding inside each pane (each side).
	panePadX = 1
	// listWidthPct is the master list's share of the inner width (the detail
	// pane takes the remainder).
	listWidthPct = 42
	// minPaneInner is the smallest usable inner width for a pane before we stop
	// shrinking (keeps at least a sliver visible on tiny terminals).
	minPaneInner = 8
	// chromeRows is the tab bar (1) + status bar (1) reserved outside the split.
	chromeRows = 2
	// minSplitRows is the minimum height for the split area when the terminal
	// height is unknown or tiny.
	minSplitRows = 8
)

// splitDims computes the outer box widths (list/detail) and the shared box
// height for the split area, from the model width/height. Widths sum to at most
// the model width; the height leaves room for the tab bar + status bar.
func (m model) splitDims() (listW, detailW, boxH int) {
	w := m.width
	if w <= 0 {
		w = defaultWidth
	}
	listW = w * listWidthPct / 100
	if listW < minPaneInner+paneBorder+2*panePadX {
		listW = minPaneInner + paneBorder + 2*panePadX
	}
	detailW = w - listW
	if detailW < minPaneInner+paneBorder+2*panePadX {
		detailW = minPaneInner + paneBorder + 2*panePadX
	}

	boxH = minSplitRows
	if m.height > chromeRows+minSplitRows {
		boxH = m.height - chromeRows
	}
	return listW, detailW, boxH
}

// paneInner returns the printable inner width/height inside a pane box of the
// given outer dimensions (subtracting border + horizontal padding).
func paneInner(boxW, boxH int) (innerW, innerH int) {
	innerW = boxW - paneBorder - 2*panePadX
	if innerW < 1 {
		innerW = 1
	}
	innerH = boxH - paneBorder
	if innerH < 1 {
		innerH = 1
	}
	return innerW, innerH
}

// layoutPanes resizes the list + viewport widgets to the current model
// dimensions. Called on WindowSizeMsg and once in the snapshot path. The list
// delegate width is updated too so row truncation tracks the pane width.
func (m *model) layoutPanes() {
	listW, detailW, boxH := m.splitDims()

	listInnerW, listInnerH := paneInner(listW, boxH)
	m.list.SetSize(listInnerW, listInnerH)
	m.list.SetDelegate(componentDelegate{width: listInnerW})

	detailInnerW, detailInnerH := paneInner(detailW, boxH)
	m.detail.Width = detailInnerW
	m.detail.Height = detailInnerH

	m.refreshDetail()
}

// refreshDetail rebuilds the detail viewport content from the currently
// selected list item and scrolls it back to the top. Safe to call any time:
// with no selection it renders an empty-state hint.
func (m *model) refreshDetail() {
	innerW := m.detail.Width
	if innerW < 1 {
		innerW = defaultWidth
	}
	c, ok := m.selectedComponent()
	m.detail.SetContent(detailContent(c, ok, innerW))
	m.detail.GotoTop()
}

// selectedComponent returns the component under the list cursor, or a zero
// Component + ok=false when the list is empty.
func (m model) selectedComponent() (Component, bool) {
	it := m.list.SelectedItem()
	if ci, ok := it.(componentItem); ok {
		return ci.c, true
	}
	return Component{}, false
}

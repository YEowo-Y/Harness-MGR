package main

import (
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
)

// ── Inventory split-pane: tree + detail layout/sizing ───────────────────────
//
// The Inventory tab is a master-detail browser: a custom color-coded tree on the
// left (tree.go) and a bubbles/viewport on the right (the selected node's
// detail). This file owns the spinner constructor, the layout/sizing math, and
// the live detail refresh. The tree widget lives in tree.go; the model/state/
// wiring lives in main.go.

// newSpinner builds the loading spinner used while `inventory --detail` runs.
func newSpinner() spinner.Model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(accent)
	return s
}

// ── Layout / sizing ──────────────────────────────────────────────────────────

const (
	// paneBorder is the column/row cost of a rounded border (1 each side).
	paneBorder = 2
	// panePadX is the horizontal padding inside each pane (each side).
	panePadX = 1
	// treeWidthPct is the tree pane's share of the inner width (the detail pane
	// takes the remainder).
	treeWidthPct = 42
	// minPaneInner is the smallest usable inner width for a pane before we stop
	// shrinking (keeps at least a sliver visible on tiny terminals).
	minPaneInner = 8
	// chromeRows is the tab bar (1) + counts bar (1) + status bar (1) reserved
	// outside the split.
	chromeRows = 3
	// minSplitRows is the minimum height for the split area when the terminal
	// height is unknown or tiny.
	minSplitRows = 8
)

// splitDims computes the outer box widths (tree/detail) and the shared box
// height for the split area, from the model width/height. Widths sum to at most
// the model width; the height leaves room for the tab bar + counts bar + status
// bar.
func (m model) splitDims() (treeW, detailW, boxH int) {
	w := m.width
	if w <= 0 {
		w = defaultWidth
	}
	treeW = w * treeWidthPct / 100
	if treeW < minPaneInner+paneBorder+2*panePadX {
		treeW = minPaneInner + paneBorder + 2*panePadX
	}
	detailW = w - treeW
	if detailW < minPaneInner+paneBorder+2*panePadX {
		detailW = minPaneInner + paneBorder + 2*panePadX
	}

	reserved := chromeRows
	if m.mascotVisible() {
		reserved += mascotExtraRows()
	}
	boxH = minSplitRows
	if m.height > reserved+minSplitRows {
		boxH = m.height - reserved
	}
	return treeW, detailW, boxH
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

// layoutPanes resizes the detail viewport to the current model dimensions and
// records the tree pane's inner size for the tree renderer. Called on
// WindowSizeMsg and once in the snapshot path.
func (m *model) layoutPanes() {
	treeW, detailW, boxH := m.splitDims()

	treeInnerW, treeInnerH := paneInner(treeW, boxH)
	m.treeInnerW = treeInnerW
	m.treeInnerH = treeInnerH

	detailInnerW, detailInnerH := paneInner(detailW, boxH)
	m.detail.Width = detailInnerW
	m.detail.Height = detailInnerH

	m.refreshDetail()
}

// refreshDetail rebuilds the detail viewport content from the currently active
// tab's selection and scrolls back to the top. Dispatches on currentView:
//   - viewInventory: tree node → detailContent + optional file preview.
//   - section tabs (Conflicts/Orphans): section list selected item → item.detail.
//
// Safe to call any time; no-ops gracefully on nil/empty state.
func (m *model) refreshDetail() {
	innerW := m.detail.Width
	if innerW < 1 {
		innerW = defaultWidth
	}

	if isSectionView(m.currentView) {
		st := m.sections[m.currentView]
		if st == nil {
			m.detail.SetContent(detailEmptyStyle.Render(tr("empty.selectItemLeft")))
			m.detail.GotoTop()
			return
		}
		item, ok := st.list.selectedItem()
		if ok {
			m.detail.SetContent(item.detail(innerW))
		} else {
			m.detail.SetContent(detailEmptyStyle.Render(tr("empty.selectItemLeft")))
		}
		m.detail.GotoTop()
		return
	}

	// viewInventory (and any other non-section tab): use the tree.
	node, ok := m.tree.selectedNode()
	content := detailContent(node, ok, innerW)
	if ok && node.comp != nil {
		content += previewSection(node.comp.Path, innerW)
	}
	m.detail.SetContent(content)
	m.detail.GotoTop()
}

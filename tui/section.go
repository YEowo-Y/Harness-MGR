package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── Section widget ────────────────────────────────────────────────────────────
//
// sectionModel is a flat list+detail browser for tabs like Conflicts and Orphans.
// Unlike the tree widget (tree.go), which has folders and expandable rows, the
// section widget is a plain scrollable list: every row is a selectable item with
// a title, an optional color, and a pre-formatted detail body built by the caller.
//
// The cursor/scroll pattern mirrors tree.go exactly (moveUp/moveDown/gotoTop/
// gotoBottom, ensureVisible, render) so future tabs can reuse both widgets
// interchangeably.

// sectionItem is one selectable row in a flat section list.
type sectionItem struct {
	title  string         // row label
	color  lipgloss.Color // row color; zero value ("") renders in the default fg
	detail string         // pre-formatted detail-pane body for this row (built by the caller)
}

// sectionModel is the flat list widget state: the items, the cursor position,
// and the viewport offset for scrolling.
type sectionModel struct {
	items  []sectionItem
	cursor int
	offset int
}

// newSectionModel builds a sectionModel from a caller-supplied item slice.
// The cursor starts at 0; the items slice is used as-is (no copy).
func newSectionModel(items []sectionItem) sectionModel {
	return sectionModel{items: items}
}

// ── Cursor navigation ─────────────────────────────────────────────────────────

// moveUp moves the cursor toward the top by n rows, clamped at 0.
func (m *sectionModel) moveUp(n int) {
	m.cursor -= n
	if m.cursor < 0 {
		m.cursor = 0
	}
}

// moveDown moves the cursor toward the bottom by n rows, clamped at the last item.
func (m *sectionModel) moveDown(n int) {
	last := len(m.items) - 1
	if last < 0 {
		m.cursor = 0
		return
	}
	m.cursor += n
	if m.cursor > last {
		m.cursor = last
	}
}

// gotoTop moves the cursor to the first item.
func (m *sectionModel) gotoTop() { m.cursor = 0 }

// gotoBottom moves the cursor to the last item; on an empty list cursor stays 0.
func (m *sectionModel) gotoBottom() {
	last := len(m.items) - 1
	if last < 0 {
		m.cursor = 0
		return
	}
	m.cursor = last
}

// selectedItem returns the item under the cursor, or ok=false when the list is
// empty. The cursor is clamped defensively so a stale cursor never panics.
func (m sectionModel) selectedItem() (sectionItem, bool) {
	if len(m.items) == 0 {
		return sectionItem{}, false
	}
	idx := m.cursor
	if idx < 0 {
		idx = 0
	}
	if idx >= len(m.items) {
		idx = len(m.items) - 1
	}
	return m.items[idx], true
}

// ── Rendering ─────────────────────────────────────────────────────────────────

// render draws the list into a string of at most height rows, width columns wide,
// scrolled so the cursor row stays visible. Returns "" when width<1 or height<1,
// or when the item list is empty.
func (m *sectionModel) render(width, height int) string {
	if width < 1 || height < 1 || len(m.items) == 0 {
		return ""
	}
	m.ensureVisible(height)

	var b strings.Builder
	end := m.offset + height
	if end > len(m.items) {
		end = len(m.items)
	}
	for i := m.offset; i < end; i++ {
		if i > m.offset {
			b.WriteString("\n")
		}
		b.WriteString(m.renderRow(i, width))
	}
	return b.String()
}

// ensureVisible scrolls the offset so the cursor row is within the visible window
// of the given height. Mirrors tree.go's ensureVisible exactly.
func (m *sectionModel) ensureVisible(height int) {
	if height < 1 {
		height = 1
	}
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+height {
		m.offset = m.cursor - height + 1
	}
	if m.offset < 0 {
		m.offset = 0
	}
	maxOffset := len(m.items) - height
	if maxOffset < 0 {
		maxOffset = 0
	}
	if m.offset > maxOffset {
		m.offset = maxOffset
	}
}

// renderRow renders a single list row at index i, truncated to width.
// Cursor row: leading accent bar (bold) in the row's color, then the title
// brightened/bold. Non-cursor row: 2-space indent, title in the row's color.
func (m *sectionModel) renderRow(i, width int) string {
	item := m.items[i]
	selected := i == m.cursor

	if selected {
		barStyle := lipgloss.NewStyle().Bold(true)
		if item.color != "" {
			barStyle = barStyle.Foreground(item.color)
		}
		bar := barStyle.Render(glyph("▌", ">")) + " "
		avail := width - lipgloss.Width(bar)
		if avail < 0 {
			avail = 0
		}
		txtStyle := lipgloss.NewStyle().Bold(true)
		if item.color != "" {
			txtStyle = txtStyle.Foreground(item.color)
		}
		return bar + txtStyle.Render(truncate(item.title, avail))
	}

	// Non-cursor: 2-space indent to align with the non-bar width of the cursor row.
	indent := "  "
	avail := width - lipgloss.Width(indent)
	if avail < 0 {
		avail = 0
	}
	txtStyle := lipgloss.NewStyle()
	if item.color != "" {
		txtStyle = txtStyle.Foreground(item.color)
	}
	return indent + txtStyle.Render(truncate(item.title, avail))
}

package main

import (
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── Tree widget ─────────────────────────────────────────────────────────────
//
// The Inventory tab is a color-coded expandable tree grouped by object type.
// Bubbles ships no tree component, so this is a hand-rolled widget. Six fixed
// type folders (Skills/Agents/Commands/Plugins/Marketplaces/MCP), each holding
// its objects from the `--detail` fetch. The tree maintains a FLATTENED slice of
// visible rows (folder rows + the items of expanded folders) that the cursor
// traverses; the model owns the surrounding panes and keys.
//
// State and rendering live here; engine.go owns the data structs and fetch.

// ── Per-type palette ────────────────────────────────────────────────────────
// Each object type has its own color. Folder headers use the bright color (bold);
// items under an expanded folder use a slightly dimmer shade so the header stands
// out. Detail panes theme on the same bright color.

var (
	colorSkill       = lipgloss.Color("#2DD4BF") // teal
	colorAgent       = lipgloss.Color("#A78BFA") // violet
	colorCommand     = lipgloss.Color("#F59E0B") // amber
	colorPlugin      = lipgloss.Color("#34D399") // green
	colorMarketplace = lipgloss.Color("#60A5FA") // blue
	colorMcp         = lipgloss.Color("#22D3EE") // cyan

	// Dimmer item shades (one step down per type) for the rows under a folder.
	dimSkill       = lipgloss.Color("#14B8A6")
	dimAgent       = lipgloss.Color("#8B5CF6")
	dimCommand     = lipgloss.Color("#D97706")
	dimPlugin      = lipgloss.Color("#10B981")
	dimMarketplace = lipgloss.Color("#3B82F6")
	dimMcp         = lipgloss.Color("#06B6D4")
)

// nodeKind identifies a tree folder / object type. The iota order is the fixed
// display order of the six folders.
type nodeKind int

const (
	kindSkill nodeKind = iota
	kindAgent
	kindCommand
	kindPlugin
	kindMarketplace
	kindMcp
)

// nodeKindCount is the number of type folders, derived from the iota.
const nodeKindCount = int(kindMcp) + 1

// kindMeta describes a folder's label, colors, and Unicode icon.
type kindMeta struct {
	label    string
	folderFg lipgloss.Color // bright — folder header
	itemFg   lipgloss.Color // dimmer — items under an expanded folder
	icon     string         // single-width Unicode symbol; gate via glyph() at render time
}

// kindMetas indexes display metadata by nodeKind (fixed order + per-type color).
var kindMetas = [nodeKindCount]kindMeta{
	kindSkill:       {label: "Skills", folderFg: colorSkill, itemFg: dimSkill, icon: "◆"},
	kindAgent:       {label: "Agents", folderFg: colorAgent, itemFg: dimAgent, icon: "●"},
	kindCommand:     {label: "Commands", folderFg: colorCommand, itemFg: dimCommand, icon: "▸"},
	kindPlugin:      {label: "Plugins", folderFg: colorPlugin, itemFg: dimPlugin, icon: "✦"},
	kindMarketplace: {label: "Marketplaces", folderFg: colorMarketplace, itemFg: dimMarketplace, icon: "■"},
	kindMcp:         {label: "MCP", folderFg: colorMcp, itemFg: dimMcp, icon: "◇"},
}

// treeNode is one selectable object inside a folder. Exactly one of the four
// payload pointers is set, matching the folder's kind. name is the row label.
type treeNode struct {
	kind nodeKind
	name string

	comp *Component   // set when kind is skill/agent/command
	plug *Plugin      // set when kind is plugin
	mkt  *Marketplace // set when kind is marketplace
	mcp  *McpServer   // set when kind is mcp
}

// treeFolder is one type folder: its kind, expand state, and child nodes.
type treeFolder struct {
	kind     nodeKind
	expanded bool
	nodes    []treeNode
}

// visRow is one entry in the flattened visible-rows slice: either a folder
// header (isFolder true, folderIdx valid) or an item under an expanded folder
// (folderIdx + nodeIdx valid). The cursor traverses this slice.
type visRow struct {
	isFolder  bool
	folderIdx int // index into treeModel.folders
	nodeIdx   int // index into folders[folderIdx].nodes (item rows only)
}

// treeModel is the tree widget state: the six folders, the flattened visible
// rows, the cursor position over those rows, and the viewport offset for
// scrolling. cursor indexes visible; offset is the first visible row drawn.
type treeModel struct {
	folders []treeFolder
	visible []visRow
	cursor  int
	offset  int
}

// newTreeModel builds the six folders from a DetailData. Skills start expanded
// (a good first impression); the rest start collapsed. The visible-rows slice is
// rebuilt to match. Components are bucketed by Kind ("skill"/"agent"/"command");
// an unrecognized kind is skipped rather than mis-bucketed.
func newTreeModel(d DetailData) treeModel {
	folders := make([]treeFolder, nodeKindCount)
	for i := range folders {
		folders[i].kind = nodeKind(i)
	}
	folders[kindSkill].expanded = true

	for i := range d.Components {
		c := &d.Components[i]
		k, ok := componentKind(c.Kind)
		if !ok {
			continue
		}
		folders[k].nodes = append(folders[k].nodes, treeNode{kind: k, name: c.Name, comp: c})
	}
	for i := range d.Plugins {
		p := &d.Plugins[i]
		folders[kindPlugin].nodes = append(folders[kindPlugin].nodes, treeNode{kind: kindPlugin, name: p.Name, plug: p})
	}
	for i := range d.Marketplaces {
		mk := &d.Marketplaces[i]
		folders[kindMarketplace].nodes = append(folders[kindMarketplace].nodes, treeNode{kind: kindMarketplace, name: mk.Name, mkt: mk})
	}
	for i := range d.McpServers {
		ms := &d.McpServers[i]
		folders[kindMcp].nodes = append(folders[kindMcp].nodes, treeNode{kind: kindMcp, name: ms.Name, mcp: ms})
	}

	t := treeModel{folders: folders}
	t.rebuildVisible()
	return t
}

// componentKind maps a component's JSON "kind" string to a folder nodeKind.
// Returns ok=false for an unrecognized kind so the caller can skip it.
func componentKind(kind string) (nodeKind, bool) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "skill":
		return kindSkill, true
	case "agent":
		return kindAgent, true
	case "command":
		return kindCommand, true
	default:
		return 0, false
	}
}

// rebuildVisible recomputes the flattened visible-rows slice: each folder header
// followed by its items only when expanded. The cursor is clamped to the new row
// count so it never points past the end after a collapse.
func (t *treeModel) rebuildVisible() {
	rows := make([]visRow, 0, len(t.folders))
	for fi := range t.folders {
		rows = append(rows, visRow{isFolder: true, folderIdx: fi})
		if t.folders[fi].expanded {
			for ni := range t.folders[fi].nodes {
				rows = append(rows, visRow{folderIdx: fi, nodeIdx: ni})
			}
		}
	}
	t.visible = rows
	if t.cursor >= len(rows) {
		t.cursor = len(rows) - 1
	}
	if t.cursor < 0 {
		t.cursor = 0
	}
}

// ── Cursor navigation ────────────────────────────────────────────────────────

// moveUp moves the cursor toward the top by n rows, clamped at 0.
func (t *treeModel) moveUp(n int) {
	t.cursor -= n
	if t.cursor < 0 {
		t.cursor = 0
	}
}

// moveDown moves the cursor toward the bottom by n rows, clamped at the last row.
func (t *treeModel) moveDown(n int) {
	last := len(t.visible) - 1
	if last < 0 {
		t.cursor = 0
		return
	}
	t.cursor += n
	if t.cursor > last {
		t.cursor = last
	}
}

// gotoTop / gotoBottom jump the cursor to the first / last visible row.
func (t *treeModel) gotoTop()    { t.cursor = 0 }
func (t *treeModel) gotoBottom() { t.cursor = len(t.visible) - 1; t.clampCursor() }

// clampCursor keeps the cursor within [0, last]; on an empty tree it is 0.
func (t *treeModel) clampCursor() {
	if t.cursor < 0 {
		t.cursor = 0
	}
	if t.cursor >= len(t.visible) {
		t.cursor = len(t.visible) - 1
	}
	if t.cursor < 0 {
		t.cursor = 0
	}
}

// toggle acts on the cursor row: a folder toggles expand/collapse (rebuilding the
// visible rows); an item is left untouched (the caller treats it as a selection).
// Returns true when a folder was toggled.
func (t *treeModel) toggle() bool {
	row, ok := t.currentRow()
	if !ok || !row.isFolder {
		return false
	}
	t.folders[row.folderIdx].expanded = !t.folders[row.folderIdx].expanded
	t.rebuildVisible()
	return true
}

// currentRow returns the visible row under the cursor, or ok=false when the tree
// has no visible rows.
func (t treeModel) currentRow() (visRow, bool) {
	if t.cursor < 0 || t.cursor >= len(t.visible) {
		return visRow{}, false
	}
	return t.visible[t.cursor], true
}

// selectedNode returns the tree node under the cursor when the cursor is on an
// ITEM row (not a folder header). ok=false on a folder row or empty tree. This
// drives the detail pane selection.
func (t treeModel) selectedNode() (treeNode, bool) {
	row, ok := t.currentRow()
	if !ok || row.isFolder {
		return treeNode{}, false
	}
	f := t.folders[row.folderIdx]
	if row.nodeIdx < 0 || row.nodeIdx >= len(f.nodes) {
		return treeNode{}, false
	}
	return f.nodes[row.nodeIdx], true
}

// ── Rendering ─────────────────────────────────────────────────────────────────

// chevron returns the expand/collapse glyph, gated on the color profile like the
// glyph() helper: Unicode ▾/▸ when color is enabled, ASCII v/> otherwise.
func chevron(expanded bool) string {
	if expanded {
		return glyph("▾", "v")
	}
	return glyph("▸", ">")
}

// render draws the tree into a string of at most `height` rows, `width` columns
// wide, scrolled so the cursor row stays visible. A folder header reads
// "▾ Skills (240)" bold in the type color; items are indented 4 spaces in the
// dimmer type color. The cursor row gets a leading accent bar in its type color
// plus brighter text. width<1 / height<1 yield "".
func (t *treeModel) render(width, height int) string {
	if width < 1 || height < 1 {
		return ""
	}
	t.ensureVisible(height)

	var b strings.Builder
	end := t.offset + height
	if end > len(t.visible) {
		end = len(t.visible)
	}
	for i := t.offset; i < end; i++ {
		if i > t.offset {
			b.WriteString("\n")
		}
		b.WriteString(t.renderRow(i, width))
	}
	return b.String()
}

// ensureVisible scrolls the offset so the cursor row is within the visible window
// of the given height (simple keep-cursor-in-view: scroll up if above, down if
// below). offset is clamped to a valid range.
func (t *treeModel) ensureVisible(height int) {
	if height < 1 {
		height = 1
	}
	if t.cursor < t.offset {
		t.offset = t.cursor
	}
	if t.cursor >= t.offset+height {
		t.offset = t.cursor - height + 1
	}
	if t.offset < 0 {
		t.offset = 0
	}
	maxOffset := len(t.visible) - height
	if maxOffset < 0 {
		maxOffset = 0
	}
	if t.offset > maxOffset {
		t.offset = maxOffset
	}
}

// renderRow renders a single visible row at index i, truncated to width. It
// dispatches on folder vs item and on whether the cursor is on this row.
func (t *treeModel) renderRow(i, width int) string {
	row := t.visible[i]
	selected := i == t.cursor
	meta := kindMetas[t.folders[row.folderIdx].kind]

	if row.isFolder {
		return t.renderFolderRow(row, meta, selected, width)
	}
	return t.renderItemRow(row, meta, selected, width)
}

// renderFolderRow draws "◆ ▾ Skills (240)" bold in the folder color (icon
// only on Unicode-capable terminals). When the cursor is on it, a leading
// accent bar in the type color precedes the text and the text is brightened
// (bold already, kept in the bright folder color).
func (t *treeModel) renderFolderRow(row visRow, meta kindMeta, selected bool, width int) string {
	f := t.folders[row.folderIdx]
	iconStr := glyph(meta.icon, "")
	iconPrefix := ""
	if iconStr != "" {
		iconPrefix = iconStr + " "
	}
	label := iconPrefix + chevron(f.expanded) + " " + meta.label + " (" + strconv.Itoa(len(f.nodes)) + ")"

	style := lipgloss.NewStyle().Bold(true).Foreground(meta.folderFg)
	if selected {
		bar := lipgloss.NewStyle().Bold(true).Foreground(meta.folderFg).Render(glyph("▌", ">")) + " "
		avail := width - lipgloss.Width(bar)
		return bar + style.Render(truncate(label, avail))
	}
	// Two leading spaces align non-cursor rows with the cursor bar width.
	return "  " + style.Render(truncate(label, width-2))
}

// renderItemRow draws an item indented 4 spaces in the dimmer type color. The
// cursor row swaps the indent's first 2 cols for an accent bar in the type color
// and brightens the text to the bright folder color (bold).
func (t *treeModel) renderItemRow(row visRow, meta kindMeta, selected bool, width int) string {
	f := t.folders[row.folderIdx]
	name := f.nodes[row.nodeIdx].name

	if selected {
		bar := lipgloss.NewStyle().Bold(true).Foreground(meta.folderFg).Render(glyph("▌", ">")) + "   "
		txt := lipgloss.NewStyle().Bold(true).Foreground(meta.folderFg)
		avail := width - lipgloss.Width(bar)
		return bar + txt.Render(truncate(name, avail))
	}
	indent := "    " // 4 spaces
	txt := lipgloss.NewStyle().Foreground(meta.itemFg)
	avail := width - len(indent)
	return indent + txt.Render(truncate(name, avail))
}

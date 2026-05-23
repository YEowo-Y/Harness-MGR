package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// sampleDetail returns a small DetailData spanning all four object types so the
// tree exercises every folder. Components cover skill/agent/command.
func sampleDetail() DetailData {
	return DetailData{
		Components: []Component{
			{Name: "analyst", Kind: "agent", Source: ComponentSource{Tier: "user"}, Path: `C:\a\analyst.md`, Description: "pre-planning consultant"},
			{Name: "architect", Kind: "agent", Source: ComponentSource{Tier: "user"}, Path: `C:\a\architect.md`},
			{Name: "do", Kind: "command", Source: ComponentSource{Tier: "plugin", Plugin: "claude-mem"}, Path: `C:\c\do.md`},
			{Name: "seo", Kind: "skill", Source: ComponentSource{Tier: "user"}, Path: `C:\s\seo.md`, Description: "search engine optimization"},
		},
		Plugins: []Plugin{
			{Name: "agent-sdk-dev", Key: "agent-sdk-dev@official", Marketplace: "official", Version: "f475", Enabled: false, CachePresent: false},
		},
		Marketplaces: []Marketplace{
			{Name: "official", SourceRepo: "anthropics/claude-plugins-official", OnDisk: true, InstallLocation: `C:\m\official`},
		},
		McpServers: []McpServer{
			{Name: "context7", Transport: "stdio", Scope: "project", Command: "npx", Args: []string{"-y", "@upstash/context7-mcp"}},
		},
	}
}

// loadedModel builds a model with detail data loaded and panes sized, as the
// live Update loop would after a detailMsg + WindowSizeMsg.
func loadedModel(w, h int) model {
	m := initialModel("unused")
	mm, _ := m.Update(detailMsg{data: sampleDetail()})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	return mm.(model)
}

// pressRune sends a single-rune key to the model and returns the next model.
func pressRune(t *testing.T, m model, r rune) model {
	t.Helper()
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	return mm.(model)
}

func TestSortComponentsByKindThenName(t *testing.T) {
	in := []Component{
		{Name: "seo", Kind: "skill"},
		{Name: "architect", Kind: "agent"},
		{Name: "do", Kind: "command"},
		{Name: "analyst", Kind: "agent"},
	}
	sortComponents(in)
	got := make([]string, len(in))
	for i, c := range in {
		got[i] = c.Kind + "/" + c.Name
	}
	want := []string{"agent/analyst", "agent/architect", "command/do", "skill/seo"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
}

// TestTreeBucketsByType verifies each component kind and the three non-component
// arrays land in the right folder with the right counts.
func TestTreeBucketsByType(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	want := map[nodeKind]int{
		kindSkill:       1,
		kindAgent:       2,
		kindCommand:     1,
		kindPlugin:      1,
		kindMarketplace: 1,
		kindMcp:         1,
	}
	for k, n := range want {
		if got := len(tr.folders[k].nodes); got != n {
			t.Fatalf("folder %d has %d nodes, want %d", k, got, n)
		}
	}
}

// TestSkillsExpandedRestCollapsed verifies the first-impression default: only the
// Skills folder is expanded after construction.
func TestSkillsExpandedRestCollapsed(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	if !tr.folders[kindSkill].expanded {
		t.Fatalf("Skills folder should start expanded")
	}
	for k := kindAgent; k <= kindMcp; k++ {
		if tr.folders[k].expanded {
			t.Fatalf("folder %d should start collapsed", k)
		}
	}
}

// TestVisibleRowsReflectExpandState verifies the flattened visible-rows slice
// holds folder rows plus the items of expanded folders only. With Skills (1
// item) expanded and the other five collapsed: 6 folders + 1 skill item = 7.
func TestVisibleRowsReflectExpandState(t *testing.T) {
	tr := newTreeModel(sampleDetail())
	if got := len(tr.visible); got != nodeKindCount+1 {
		t.Fatalf("initial visible rows = %d, want %d", got, nodeKindCount+1)
	}
	// First row is the Skills folder header; the second is its lone item.
	if !tr.visible[0].isFolder || tr.visible[0].folderIdx != int(kindSkill) {
		t.Fatalf("row 0 should be the Skills folder header")
	}
	if tr.visible[1].isFolder {
		t.Fatalf("row 1 should be the Skills item, not a folder header")
	}
}

// TestFolderExpandCollapseTogglesVisibleRows verifies Enter on a folder toggles
// it and the visible-rows slice grows/shrinks accordingly.
func TestFolderExpandCollapseTogglesVisibleRows(t *testing.T) {
	m := loadedModel(120, 30)
	base := len(m.tree.visible) // 7: 6 folders + 1 skill item

	// Move the cursor onto the Agents folder header (row index 2: Skills header,
	// Skills item, Agents header) and expand it (2 agents → +2 rows).
	m = pressRune(t, m, 'j') // cursor 0 -> 1 (skill item)
	m = pressRune(t, m, 'j') // cursor 1 -> 2 (Agents header)
	row, ok := m.tree.currentRow()
	if !ok || !row.isFolder || row.folderIdx != int(kindAgent) {
		t.Fatalf("cursor not on Agents folder header (row=%+v ok=%v)", row, ok)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(model)
	if !m.tree.folders[kindAgent].expanded {
		t.Fatalf("Enter did not expand the Agents folder")
	}
	if got := len(m.tree.visible); got != base+2 {
		t.Fatalf("after expanding Agents visible rows = %d, want %d", got, base+2)
	}

	// Collapse it again with Space; rows return to the base count.
	m = pressRune(t, m, ' ')
	if m.tree.folders[kindAgent].expanded {
		t.Fatalf("Space did not collapse the Agents folder")
	}
	if got := len(m.tree.visible); got != base {
		t.Fatalf("after collapsing Agents visible rows = %d, want %d", got, base)
	}
}

// TestCursorTraversesFoldersAndItems verifies j/k move the cursor over both
// folder headers and the items of expanded folders.
func TestCursorTraversesFoldersAndItems(t *testing.T) {
	m := loadedModel(120, 30)
	if m.tree.cursor != 0 {
		t.Fatalf("initial cursor = %d, want 0", m.tree.cursor)
	}
	// Row 0 is the Skills folder header.
	if r, _ := m.tree.currentRow(); !r.isFolder {
		t.Fatalf("row 0 should be a folder header")
	}
	// j moves onto the Skills item (an item row, not a folder).
	m = pressRune(t, m, 'j')
	if m.tree.cursor != 1 {
		t.Fatalf("after j cursor = %d, want 1", m.tree.cursor)
	}
	if r, _ := m.tree.currentRow(); r.isFolder {
		t.Fatalf("row 1 should be an item, got a folder header")
	}
	// k moves back to the folder header.
	m = pressRune(t, m, 'k')
	if m.tree.cursor != 0 {
		t.Fatalf("after k cursor = %d, want 0", m.tree.cursor)
	}
}

// TestGotoTopBottom verifies g/G jump to the first/last visible row.
func TestGotoTopBottom(t *testing.T) {
	m := loadedModel(120, 30)
	m = pressRune(t, m, 'G')
	if want := len(m.tree.visible) - 1; m.tree.cursor != want {
		t.Fatalf("after G cursor = %d, want %d", m.tree.cursor, want)
	}
	m = pressRune(t, m, 'g')
	if m.tree.cursor != 0 {
		t.Fatalf("after g cursor = %d, want 0", m.tree.cursor)
	}
}

// TestSelectingItemSetsDetail verifies that landing the cursor on an ITEM sets
// the detail pane to that node, while a FOLDER row shows no item detail.
func TestSelectingItemSetsDetail(t *testing.T) {
	m := loadedModel(120, 30)
	// Cursor starts on the Skills folder header → no node selected.
	if _, ok := m.tree.selectedNode(); ok {
		t.Fatalf("folder row should not yield a selected node")
	}
	// j moves onto the lone skill item ("seo"); detail must refresh to it.
	m = pressRune(t, m, 'j')
	n, ok := m.tree.selectedNode()
	if !ok || n.comp == nil || n.comp.Name != "seo" {
		t.Fatalf("selected node = %+v ok=%v, want skill seo", n, ok)
	}
	if !strings.Contains(m.detail.View(), "seo") {
		t.Fatalf("detail viewport does not show selected skill: %q", m.detail.View())
	}
}

// TestExpandThenSelectPluginDetail verifies expanding a non-skill folder and
// selecting its item renders that type's detail fields (plugin here).
func TestExpandThenSelectPluginDetail(t *testing.T) {
	m := loadedModel(120, 30)
	// Jump to the bottom: the last folder is MCP. Walk up to the Plugins folder
	// instead by expanding it directly via cursor placement.
	// Visible (collapsed except Skills): [Skills hdr, seo, Agents, Commands,
	// Plugins, Marketplaces, MCP]. Plugins header is index 4.
	for i := 0; i < 4; i++ {
		m = pressRune(t, m, 'j')
	}
	row, _ := m.tree.currentRow()
	if !row.isFolder || row.folderIdx != int(kindPlugin) {
		t.Fatalf("cursor not on Plugins folder (row=%+v)", row)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // expand Plugins
	m = mm.(model)
	m = pressRune(t, m, 'j') // onto the plugin item
	n, ok := m.tree.selectedNode()
	if !ok || n.plug == nil || n.plug.Name != "agent-sdk-dev" {
		t.Fatalf("selected node = %+v ok=%v, want plugin agent-sdk-dev", n, ok)
	}
	view := m.detail.View()
	if !strings.Contains(view, "agent-sdk-dev") || !strings.Contains(view, "Marketplace") {
		t.Fatalf("plugin detail missing expected fields: %q", view)
	}
}

// TestExpandThenSelectMcpDetail verifies the MCP detail renders its safe fields
// (Transport / Scope / Command / Args) AND — as a secret-safety regression
// guard — that no env/url field ever surfaces. The Node `--detail` contract
// omits envKeys and url on purpose; the McpServer struct cannot even hold them,
// so this test fails loudly if a future change reintroduces a sensitive field.
func TestExpandThenSelectMcpDetail(t *testing.T) {
	m := loadedModel(120, 30)
	// MCP is the last folder; G lands the cursor on its header.
	m = pressRune(t, m, 'G')
	row, _ := m.tree.currentRow()
	if !row.isFolder || row.folderIdx != int(kindMcp) {
		t.Fatalf("cursor not on MCP folder (row=%+v)", row)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // expand MCP
	m = mm.(model)
	m = pressRune(t, m, 'j') // onto the mcp item
	n, ok := m.tree.selectedNode()
	if !ok || n.mcp == nil || n.mcp.Name != "context7" {
		t.Fatalf("selected node = %+v ok=%v, want mcp context7", n, ok)
	}
	view := m.detail.View()
	for _, want := range []string{"context7", "Transport", "stdio", "Command", "npx"} {
		if !strings.Contains(view, want) {
			t.Fatalf("mcp detail missing %q: %q", want, view)
		}
	}
	for _, leak := range []string{"envKeys", "EnvKeys", "url", "URL"} {
		if strings.Contains(view, leak) {
			t.Fatalf("mcp detail leaked a forbidden field %q: %q", leak, view)
		}
	}
}

// TestExpandThenSelectMarketplaceDetail verifies the Marketplace detail renders
// its type-specific fields (Source repo / On disk / Install location).
func TestExpandThenSelectMarketplaceDetail(t *testing.T) {
	m := loadedModel(120, 30)
	// Visible (only Skills expanded): [Skills hdr, seo, Agents, Commands,
	// Plugins, Marketplaces, MCP]. The Marketplaces header is index 5.
	for i := 0; i < 5; i++ {
		m = pressRune(t, m, 'j')
	}
	row, _ := m.tree.currentRow()
	if !row.isFolder || row.folderIdx != int(kindMarketplace) {
		t.Fatalf("cursor not on Marketplaces folder (row=%+v)", row)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // expand Marketplaces
	m = mm.(model)
	m = pressRune(t, m, 'j') // onto the marketplace item
	n, ok := m.tree.selectedNode()
	if !ok || n.mkt == nil || n.mkt.Name != "official" {
		t.Fatalf("selected node = %+v ok=%v, want marketplace official", n, ok)
	}
	view := m.detail.View()
	for _, want := range []string{"official", "Source repo", "On disk"} {
		if !strings.Contains(view, want) {
			t.Fatalf("marketplace detail missing %q: %q", want, view)
		}
	}
}

// TestRefreshDetailAppendsPreviewForComponent verifies the wiring at the model
// level: selecting a COMPONENT item makes refreshDetail read its file and append
// the content preview (here a real temp SKILL.md). This exercises the
// `node.comp != nil` guard in refreshDetail, not just previewSection in isolation.
func TestRefreshDetailAppendsPreviewForComponent(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(skillPath, []byte("---\nname: x\n---\nUNIQUE_PREVIEW_BODY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	data := DetailData{
		Components: []Component{{Name: "x", Kind: "skill", Source: ComponentSource{Tier: "user"}, Path: skillPath}},
	}
	m := initialModel("unused")
	mm, _ := m.Update(detailMsg{data: data})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	m = mm.(model)
	// Skills start expanded; j lands the cursor on the lone skill item.
	m = pressRune(t, m, 'j')
	if n, ok := m.tree.selectedNode(); !ok || n.comp == nil {
		t.Fatalf("expected the skill item selected, got %+v ok=%v", n, ok)
	}
	if !strings.Contains(m.detail.View(), "UNIQUE_PREVIEW_BODY") {
		t.Fatalf("component detail missing file preview body: %q", m.detail.View())
	}
}

func TestTabTogglesFocusNotSection(t *testing.T) {
	m := loadedModel(120, 30)
	if m.focus != focusTree {
		t.Fatalf("initial focus = %v, want focusTree", m.focus)
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = mm.(model)
	if m.focus != focusDetail {
		t.Fatalf("after Tab focus = %v, want focusDetail", m.focus)
	}
	if m.currentView != viewInventory {
		t.Fatalf("Tab changed section to %v, want it unchanged (viewInventory)", m.currentView)
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = mm.(model)
	if m.focus != focusTree {
		t.Fatalf("after Shift+Tab focus = %v, want focusTree", m.focus)
	}
}

func TestBracketKeysCycleSections(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("after ] view = %v, want viewConflicts", m.currentView)
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("[")})
	m = mm.(model)
	if m.currentView != viewInventory {
		t.Fatalf("after [ view = %v, want viewInventory", m.currentView)
	}
}

func TestDigitKeysJumpSections(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("3")})
	m = mm.(model)
	if m.currentView != viewOrphans {
		t.Fatalf("after 3 view = %v, want viewOrphans", m.currentView)
	}
}

// TestTreeNavRefreshesDetailLive verifies moving the cursor onto an item updates
// the detail viewport without an explicit Enter.
func TestTreeNavRefreshesDetailLive(t *testing.T) {
	m := loadedModel(120, 30)
	// focus is the tree; "j" moves the cursor onto the skill item.
	m = pressRune(t, m, 'j')
	n, ok := m.tree.selectedNode()
	if !ok || n.name != "seo" {
		t.Fatalf("after j selected = %q, want seo", n.name)
	}
	if !strings.Contains(m.detail.View(), "seo") {
		t.Fatalf("detail did not refresh to seo: %q", m.detail.View())
	}
}

// TestNavWhileDetailFocusedScrollsNotMoves verifies that with the detail pane
// focused, j scrolls the viewport and does NOT move the tree cursor.
func TestNavWhileDetailFocusedScrollsNotMoves(t *testing.T) {
	m := loadedModel(120, 8) // short height so detail content can scroll
	// move focus to the detail pane
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = mm.(model)
	before := m.tree.cursor
	m = pressRune(t, m, 'j')
	if m.tree.cursor != before {
		t.Fatalf("j with detail focused moved tree cursor %d -> %d (should not)", before, m.tree.cursor)
	}
}

// TestActivateIgnoredWhenDetailFocused verifies Enter does not toggle a folder
// while the detail pane (not the tree) has focus.
func TestActivateIgnoredWhenDetailFocused(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab}) // focus detail
	m = mm.(model)
	wasExpanded := m.tree.folders[kindSkill].expanded
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(model)
	if m.tree.folders[kindSkill].expanded != wasExpanded {
		t.Fatalf("Enter toggled a folder while detail focused (should be ignored)")
	}
}

// TestCountsBarPresent verifies the per-type counts overview bar is rendered in
// the Inventory frame with each label and count.
func TestCountsBarPresent(t *testing.T) {
	m := loadedModel(120, 30)
	m.inv.Result.Counts = Counts{Skills: 240, Agents: 19, Commands: 79, Plugins: 13, Marketplaces: 4, McpServers: 6}
	out := m.View()
	for _, want := range []string{"240 skills", "19 agents", "79 commands", "13 plugins", "4 marketplaces", "6 mcp"} {
		if !strings.Contains(out, want) {
			t.Fatalf("counts bar missing %q in frame:\n%s", want, out)
		}
	}
}

func TestSplitViewRendersTwoBorderedPanes(t *testing.T) {
	m := loadedModel(120, 30)
	out := m.View()
	// The tab bar is row 0; the counts bar row 1; the panes' top border row 2.
	rows := strings.Split(out, "\n")
	if len(rows) < 3 {
		t.Fatalf("frame too short: %q", out)
	}
	if n := strings.Count(rows[2], "╭"); n != 2 {
		t.Fatalf("expected 2 top-left corners (two panes) on row 2, got %d in %q", n, rows[2])
	}
	if !strings.Contains(out, "section") || !strings.Contains(out, "focus") {
		t.Fatalf("status bar hints missing from frame: %q", out)
	}
}

func TestQuitKeys(t *testing.T) {
	m := loadedModel(120, 30)
	for _, k := range []tea.KeyMsg{
		{Type: tea.KeyRunes, Runes: []rune("q")},
		{Type: tea.KeyCtrlC},
		{Type: tea.KeyEsc},
	} {
		_, cmd := m.Update(k)
		if cmd == nil {
			t.Fatalf("key %v did not return a quit command", k)
		}
	}
}

// TestEmptyTreeDoesNotPanic verifies an all-empty DetailData still renders (the
// six folders show with (0) counts) and yields no selected node.
func TestEmptyTreeDoesNotPanic(t *testing.T) {
	m := initialModel("unused")
	mm, _ := m.Update(detailMsg{data: DetailData{}})
	m = mm.(model)
	mm, _ = m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = mm.(model)
	_ = m.View() // must not panic
	if _, ok := m.tree.selectedNode(); ok {
		t.Fatalf("selectedNode ok=true on an empty tree, want false")
	}
	// All six folders are still present as visible rows.
	if got := len(m.tree.visible); got != nodeKindCount {
		t.Fatalf("empty tree visible rows = %d, want %d (six folder headers)", got, nodeKindCount)
	}
}

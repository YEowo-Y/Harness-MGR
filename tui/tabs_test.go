package main

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

func sampleClusters() []ConflictCluster {
	return []ConflictCluster{
		{
			Kind:         "skill",
			Key:          "seo",
			Confidence:   "likely",
			Severity:     "warn",
			LikelyWinner: ConflictMember{Name: "seo", Path: "/user/seo.md", Source: ComponentSource{Tier: "user"}},
			PossibleWinners: []ConflictMember{
				{Name: "seo", Path: "/plugin/seo.md", Source: ComponentSource{Tier: "plugin", Plugin: "alpha"}},
			},
			Reason: "user skill shadows plugin skill",
			Fix:    "remove shadowed copy",
		},
		{
			Kind:         "agent",
			Key:          "executor",
			Confidence:   "likely",
			Severity:     "warn",
			LikelyWinner: ConflictMember{Name: "executor", Path: "/user/executor.md", Source: ComponentSource{Tier: "user"}},
			PossibleWinners: []ConflictMember{
				{Name: "executor", Path: "/plugin/executor.md", Source: ComponentSource{Tier: "plugin", Plugin: "beta"}},
			},
			Reason: "user agent shadows plugin agent",
			Fix:    "rename or remove the shadowed agent",
		},
	}
}

func sampleOrphansResult() OrphansResult {
	return OrphansResult{
		Orphans: []Orphan{
			{Category: "hard", Container: ".claude", EntryType: "file", Name: "stale.txt", Path: "/user/.claude/stale.txt", Reason: "not in KNOWN_TOP_FILES"},
			{Category: "soft", Container: "skills", EntryType: "file", Name: "loose.txt", Path: "/user/.claude/skills/loose.txt", Reason: "loose non-.md file"},
		},
		Summary: OrphanSummary{Hard: 1, Soft: 1, Total: 2},
	}
}

// injectSections delivers conflictsMsg and orphansMsg to a model and returns
// the updated model. Matches the pattern used in inventory_test.go (pressRune,
// loadedModel) — deliver messages via Update.
func injectSections(m model, clusters []ConflictCluster, orphans OrphansResult) model {
	mm, _ := m.Update(conflictsMsg{data: clusters})
	m = mm.(model)
	mm, _ = m.Update(orphansMsg{data: orphans})
	return mm.(model)
}

// TestSectionEnterOnDetailFocusKeepsScroll locks the activate() focus gate:
// pressing Enter while the DETAIL pane is focused on a section tab must not reset
// the viewport scroll — it should be a no-op, matching the Inventory tab.
func TestSectionEnterOnDetailFocusKeepsScroll(t *testing.T) {
	m := loadedModel(120, 8) // short height so the detail body scrolls
	m = injectSections(m, sampleClusters(), sampleOrphansResult())
	m = pressRune(t, m, '2') // viewConflicts; cursor 0 → first cluster detail
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = mm.(model) // focus the detail pane
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = mm.(model) // scroll the detail viewport down
	before := m.detail.YOffset
	if before == 0 {
		t.Fatalf("setup: detail did not scroll (not tall enough to exercise the bug)")
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(model) // Enter on the detail-focused section tab
	if m.detail.YOffset != before {
		t.Fatalf("Enter reset detail scroll %d -> %d (should be a no-op)", before, m.detail.YOffset)
	}
}

// TestSectionErrorStateRendered verifies a fetch error surfaces in the section
// list pane rather than silently showing an empty list.
func TestSectionErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(conflictsMsg{err: fmt.Errorf("boom")})
	m = mm.(model)
	m = pressRune(t, m, '2') // viewConflicts
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("conflicts error state not rendered:\n%s", out)
	}
}

// ── conflictItems ─────────────────────────────────────────────────────────────

func TestConflictItemsCount(t *testing.T) {
	items := conflictItems(sampleClusters())
	if len(items) != 2 {
		t.Fatalf("conflictItems count = %d, want 2", len(items))
	}
}

func TestConflictItemsTitles(t *testing.T) {
	items := conflictItems(sampleClusters())
	if items[0].title != "skill: seo" {
		t.Fatalf("items[0].title = %q, want %q", items[0].title, "skill: seo")
	}
	if items[1].title != "agent: executor" {
		t.Fatalf("items[1].title = %q, want %q", items[1].title, "agent: executor")
	}
}

func TestConflictItemsColors(t *testing.T) {
	items := conflictItems(sampleClusters())
	if items[0].color != colorSkill {
		t.Fatalf("skill item color = %v, want colorSkill", items[0].color)
	}
	if items[1].color != colorAgent {
		t.Fatalf("agent item color = %v, want colorAgent", items[1].color)
	}
}

func TestConflictItemsDetailContainsKind(t *testing.T) {
	items := conflictItems(sampleClusters())
	if !strings.Contains(items[0].detail, "skill") {
		t.Fatalf("conflict detail missing kind %q:\n%s", "skill", items[0].detail)
	}
}

func TestConflictItemsDetailContainsLikelyWinner(t *testing.T) {
	items := conflictItems(sampleClusters())
	if !strings.Contains(items[0].detail, "seo") {
		t.Fatalf("conflict detail missing likely winner name:\n%s", items[0].detail)
	}
}

func TestConflictItemsDetailContainsReason(t *testing.T) {
	items := conflictItems(sampleClusters())
	if !strings.Contains(items[0].detail, "shadows") {
		t.Fatalf("conflict detail missing reason:\n%s", items[0].detail)
	}
}

func TestConflictItemsUnknownKindUsesLabelGray(t *testing.T) {
	clusters := []ConflictCluster{{Kind: "unknown", Key: "foo"}}
	items := conflictItems(clusters)
	if items[0].color != labelGray {
		t.Fatalf("unknown kind color = %v, want labelGray", items[0].color)
	}
}

func TestConflictItemsCommandKindColor(t *testing.T) {
	clusters := []ConflictCluster{{Kind: "command", Key: "bar"}}
	items := conflictItems(clusters)
	if items[0].color != colorCommand {
		t.Fatalf("command item color = %v, want colorCommand", items[0].color)
	}
}

func TestConflictItemsEmpty(t *testing.T) {
	items := conflictItems(nil)
	if len(items) != 0 {
		t.Fatalf("conflictItems(nil) count = %d, want 0", len(items))
	}
}

// ── orphanItems ───────────────────────────────────────────────────────────────

func TestOrphanItemsCount(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if len(items) != 2 {
		t.Fatalf("orphanItems count = %d, want 2", len(items))
	}
}

func TestOrphanItemsTitles(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if items[0].title != "stale.txt" {
		t.Fatalf("items[0].title = %q, want %q", items[0].title, "stale.txt")
	}
	if items[1].title != "loose.txt" {
		t.Fatalf("items[1].title = %q, want %q", items[1].title, "loose.txt")
	}
}

func TestOrphanItemsHardColor(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if items[0].color != colorRed {
		t.Fatalf("hard orphan color = %v, want colorRed", items[0].color)
	}
}

func TestOrphanItemsSoftColor(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if items[1].color != colorCommand {
		t.Fatalf("soft orphan color = %v, want colorCommand (amber)", items[1].color)
	}
}

func TestOrphanItemsDetailContainsCategory(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if !strings.Contains(items[0].detail, "hard") {
		t.Fatalf("hard orphan detail missing category:\n%s", items[0].detail)
	}
}

func TestOrphanItemsDetailContainsPath(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if !strings.Contains(items[0].detail, "/user/.claude/stale.txt") {
		t.Fatalf("orphan detail missing path:\n%s", items[0].detail)
	}
}

func TestOrphanItemsDetailContainsEntryType(t *testing.T) {
	items := orphanItems(sampleOrphansResult())
	if !strings.Contains(items[0].detail, "file") {
		t.Fatalf("orphan detail missing entry type:\n%s", items[0].detail)
	}
}

func TestOrphanItemsUnknownCategoryColor(t *testing.T) {
	r := OrphansResult{Orphans: []Orphan{{Category: "other", Name: "x"}}}
	items := orphanItems(r)
	if items[0].color != labelGray {
		t.Fatalf("unknown category color = %v, want labelGray", items[0].color)
	}
}

// ── Model-level: conflictsMsg + orphansMsg delivery ──────────────────────────

// loadedSectionModel builds a model with Inventory detail loaded + panes sized,
// then injects both section messages.
func loadedSectionModel(w, h int) model {
	m := loadedModel(w, h)
	return injectSections(m, sampleClusters(), sampleOrphansResult())
}

func TestConflictsMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(conflictsMsg{data: sampleClusters()})
	m = mm.(model)

	st := m.sections[viewConflicts]
	if st == nil {
		t.Fatal("sections[viewConflicts] is nil after conflictsMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after conflictsMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	if !strings.Contains(st.summary, "2 conflicts") {
		t.Fatalf("summary = %q, want to contain %q", st.summary, "2 conflicts")
	}
}

func TestOrphansMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(orphansMsg{data: sampleOrphansResult()})
	m = mm.(model)

	st := m.sections[viewOrphans]
	if st == nil {
		t.Fatal("sections[viewOrphans] is nil after orphansMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after orphansMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	if !strings.Contains(st.summary, "1 hard") {
		t.Fatalf("summary = %q, want to contain %q", st.summary, "1 hard")
	}
}

// ── View-level: switching to Conflicts tab shows cluster title + summary ──────

func TestSwitchToConflictsViewContainsClusterTitle(t *testing.T) {
	m := loadedSectionModel(120, 30)
	// Switch to Conflicts tab via digit "2".
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)
	if m.currentView != viewConflicts {
		t.Fatalf("currentView = %v, want viewConflicts", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "skill: seo") {
		t.Fatalf("Conflicts frame missing cluster title %q:\n%s", "skill: seo", out)
	}
}

func TestSwitchToConflictsViewContainsSummary(t *testing.T) {
	m := loadedSectionModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "2 conflicts") {
		t.Fatalf("Conflicts frame missing summary %q:\n%s", "2 conflicts", out)
	}
}

func TestSwitchToOrphansViewContainsOrphanName(t *testing.T) {
	m := loadedSectionModel(120, 30)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("3")})
	m = mm.(model)
	if m.currentView != viewOrphans {
		t.Fatalf("currentView = %v, want viewOrphans", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "stale.txt") {
		t.Fatalf("Orphans frame missing orphan name %q:\n%s", "stale.txt", out)
	}
}

// ── Cursor movement on section tab refreshes detail ───────────────────────────

func TestSectionCursorMoveJRefreshesDetail(t *testing.T) {
	m := loadedSectionModel(120, 30)
	// Switch to Conflicts.
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)

	// Initially cursor is at item 0 ("skill: seo"); detail should contain "seo".
	if !strings.Contains(m.detail.View(), "seo") {
		t.Fatalf("initial detail missing %q: %q", "seo", m.detail.View())
	}

	// j moves to item 1 ("agent: executor"); detail should update to it.
	m = pressRune(t, m, 'j')
	st := m.sections[viewConflicts]
	if st.list.cursor != 1 {
		t.Fatalf("after j cursor = %d, want 1", st.list.cursor)
	}
	if !strings.Contains(m.detail.View(), "executor") {
		t.Fatalf("after j detail missing %q: %q", "executor", m.detail.View())
	}
}

// ── Empty data renders empty-state labels ─────────────────────────────────────

func TestEmptyConflictsShowsNoConflictsLabel(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(conflictsMsg{data: nil})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "no conflicts found") {
		t.Fatalf("empty conflicts frame missing empty-state label:\n%s", out)
	}
}

func TestEmptyOrphansShowsNoOrphansLabel(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(orphansMsg{data: OrphansResult{}})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("3")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "no orphans found") {
		t.Fatalf("empty orphans frame missing empty-state label:\n%s", out)
	}
}

// ── Inventory tab is unaffected ───────────────────────────────────────────────

// TestInventoryUnaffectedAfterSectionMsgs confirms the Inventory tab still
// renders its two bordered panes (tree + detail) after section messages are
// delivered — section wiring must not alter inventory state.
func TestInventoryUnaffectedAfterSectionMsgs(t *testing.T) {
	m := loadedSectionModel(120, 30)
	// currentView is already viewInventory (loadedModel default).
	out := m.View()
	rows := strings.Split(out, "\n")
	if len(rows) < 3 {
		t.Fatalf("frame too short after section msgs: %q", out)
	}
	if n := strings.Count(rows[2], "╭"); n != 2 {
		t.Fatalf("expected 2 bordered panes on inventory tab after section msgs, got %d in %q", n, rows[2])
	}
}

// TestInventoryDetailUnaffectedAfterSectionMsgs confirms the selected skill
// detail still shows when we are on the Inventory tab after section data lands.
func TestInventoryDetailUnaffectedAfterSectionMsgs(t *testing.T) {
	m := loadedSectionModel(120, 30)
	// j moves onto the lone skill item (seo) on the Inventory tree.
	m = pressRune(t, m, 'j')
	if !strings.Contains(m.detail.View(), "seo") {
		t.Fatalf("inventory detail missing seo after section msgs: %q", m.detail.View())
	}
}

// ── isSectionView helper ─────────────────────────────────────────────────────

func TestIsSectionViewConflicts(t *testing.T) {
	if !isSectionView(viewConflicts) {
		t.Fatal("isSectionView(viewConflicts) should be true")
	}
}

func TestIsSectionViewOrphans(t *testing.T) {
	if !isSectionView(viewOrphans) {
		t.Fatal("isSectionView(viewOrphans) should be true")
	}
}

func TestIsSectionViewInventory(t *testing.T) {
	if isSectionView(viewInventory) {
		t.Fatal("isSectionView(viewInventory) should be false")
	}
}

func TestIsSectionViewConfig(t *testing.T) {
	if !isSectionView(viewConfig) {
		t.Fatal("isSectionView(viewConfig) should be true")
	}
}

func TestIsSectionViewHooks(t *testing.T) {
	if !isSectionView(viewHooks) {
		t.Fatal("isSectionView(viewHooks) should be true")
	}
}

func TestIsSectionViewSelftest(t *testing.T) {
	if !isSectionView(viewSelftest) {
		t.Fatal("isSectionView(viewSelftest) should be true")
	}
}

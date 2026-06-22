package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

// sampleSnapshots returns two Snapshot records (newest-first) covering both the
// pinned and unpinned flag paths.
func sampleSnapshots() []Snapshot {
	return []Snapshot{
		{
			Id:        "2026-06-21T16-41-23Z",
			CreatedAt: "2026-06-21T16:41:23.839Z",
			Reason:    "enable plugin:ecc@everything-claude-code",
			FileCount: 683,
			Complete:  true,
			Pinned:    false,
		},
		{
			Id:        "2026-06-20T09-12-00Z",
			CreatedAt: "2026-06-20T09:12:00.000Z",
			Reason:    "disable skill:tracer",
			FileCount: 12,
			Complete:  true,
			Pinned:    true,
		},
	}
}

// injectSnapshots delivers a snapshotsMsg to a model and returns the updated model.
func injectSnapshots(m model, snaps []Snapshot) model {
	mm, _ := m.Update(snapshotsMsg{data: snaps})
	return mm.(model)
}

// switchToSnapshots navigates to the Snapshots tab directly.
// Uses a direct assignment (like switchToDispositions) rather than cycling
// through "]" presses so that inserting a new tab before viewSnapshots cannot
// silently navigate to the wrong tab.
func switchToSnapshots(m model) model {
	m.currentView = viewSnapshots
	return m
}

// ── parseSnapshots tests ────────────────────────────────────────────────────────

var sampleSnapshotsJSON = []byte(`{
	"command": "snapshot:list",
	"version": 1,
	"result": {
		"snapshots": [
			{
				"id": "2026-06-21T16-41-23Z",
				"createdAt": "2026-06-21T16:41:23.839Z",
				"reason": "enable plugin:ecc@everything-claude-code",
				"fileCount": 683,
				"complete": true,
				"pinned": false
			},
			{
				"id": "2026-06-20T09-12-00Z",
				"createdAt": "2026-06-20T09:12:00.000Z",
				"reason": "disable skill:tracer",
				"fileCount": 12,
				"complete": true,
				"pinned": true
			}
		],
		"count": 2,
		"summary": {"total": 2, "pinnedCount": 1}
	},
	"diagnostics": []
}`)

func TestParseSnapshots(t *testing.T) {
	snaps, err := parseSnapshots(sampleSnapshotsJSON)
	if err != nil {
		t.Fatalf("parseSnapshots error: %v", err)
	}
	if len(snaps) != 2 {
		t.Fatalf("snapshots count = %d, want 2", len(snaps))
	}
	first := snaps[0]
	if first.Id != "2026-06-21T16-41-23Z" {
		t.Errorf("first.Id = %q, want 2026-06-21T16-41-23Z", first.Id)
	}
	if first.Reason != "enable plugin:ecc@everything-claude-code" {
		t.Errorf("first.Reason = %q, unexpected", first.Reason)
	}
	if first.FileCount != 683 {
		t.Errorf("first.FileCount = %d, want 683", first.FileCount)
	}
	if first.Pinned {
		t.Error("first.Pinned = true, want false")
	}
	if !snaps[1].Pinned {
		t.Error("second.Pinned = false, want true")
	}
}

func TestParseSnapshotsEmpty(t *testing.T) {
	data := []byte(`{"command":"snapshot:list","version":1,"result":{"snapshots":[],"count":0,"summary":{"total":0,"pinnedCount":0}},"diagnostics":[]}`)
	snaps, err := parseSnapshots(data)
	if err != nil {
		t.Fatalf("parseSnapshots error on empty: %v", err)
	}
	if len(snaps) != 0 {
		t.Fatalf("expected 0 snapshots, got %d", len(snaps))
	}
}

func TestParseSnapshotsInvalidJSON(t *testing.T) {
	_, err := parseSnapshots([]byte(`not json`))
	if err == nil {
		t.Fatal("parseSnapshots should return error on invalid JSON")
	}
}

// ── snapshotItems / snapshotDetail tests ──────────────────────────────────────

func TestSnapshotItems(t *testing.T) {
	items := snapshotItems(sampleSnapshots())
	if len(items) != 2 {
		t.Fatalf("snapshotItems count = %d, want 2", len(items))
	}
	// The title carries the engine reason (always English).
	if !strings.Contains(items[0].title, "enable plugin:ecc@everything-claude-code") {
		t.Errorf("item[0].title missing reason: %q", items[0].title)
	}
}

func TestSnapshotItemsFallsBackToId(t *testing.T) {
	snaps := []Snapshot{{Id: "2026-01-01T00-00-00Z"}} // no reason
	items := snapshotItems(snaps)
	if !strings.Contains(items[0].title, "2026-01-01T00-00-00Z") {
		t.Errorf("item title should fall back to id when reason empty: %q", items[0].title)
	}
}

func TestSnapshotDetailRendersFields(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	s := sampleSnapshots()[1] // pinned one
	out := snapshotDetail(s, 80)
	if !strings.Contains(out, "2026-06-20T09-12-00Z") {
		t.Errorf("detail missing id:\n%s", out)
	}
	if !strings.Contains(out, "disable skill:tracer") {
		t.Errorf("detail missing reason:\n%s", out)
	}
	if !strings.Contains(out, "12") {
		t.Errorf("detail missing fileCount:\n%s", out)
	}
	// Pinned=true → localised "yes".
	if !strings.Contains(out, "yes") {
		t.Errorf("detail missing pinned yes:\n%s", out)
	}
}

// ── Model-level: snapshotsMsg delivery ────────────────────────────────────────

func TestSnapshotsMsgSetsListAndSummary(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectSnapshots(m, sampleSnapshots())

	st := m.sections[viewSnapshots]
	if st == nil {
		t.Fatal("sections[viewSnapshots] is nil after snapshotsMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after snapshotsMsg")
	}
	if !st.loaded {
		t.Fatal("loaded should be true after snapshotsMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	// Summary: "2 snapshots".
	sum := st.summaryText()
	if !strings.Contains(sum, "2") {
		t.Fatalf("summary = %q, want snapshot count 2", sum)
	}
}

func TestSnapshotsMsgSummaryZH(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	m := loadedModel(120, 30)
	m = injectSnapshots(m, sampleSnapshots())
	sum := m.sections[viewSnapshots].summaryText()
	if !strings.Contains(sum, "快照") {
		t.Fatalf("ZH summary = %q, want 快照 label", sum)
	}
}

func TestSnapshotsErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(snapshotsMsg{err: errFmt("snapshots boom")})
	m = mm.(model)
	m = switchToSnapshots(m)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("snapshots error state not rendered:\n%s", out)
	}
}

// ── Navigation: S key and cycle ───────────────────────────────────────────────

func TestSKeyNavigatesToSnapshots(t *testing.T) {
	m := loadedModel(120, 30) // starts on Inventory
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("S")})
	m = mm.(model)
	if m.currentView != viewSnapshots {
		t.Fatalf("S key should jump to viewSnapshots, got %v", m.currentView)
	}
}

func TestSnapshotsReachableByCycle(t *testing.T) {
	// Forward-cycle reachability: pressing ']' from Inventory exactly
	// int(viewSnapshots) times must land on the last tab. Drives REAL keypresses
	// through Update, so it guards that Snapshots is genuinely part of the ] cycle —
	// drop it from the cycle and this goes red.
	m := loadedModel(120, 30)
	if m.currentView != viewInventory {
		t.Fatalf("precondition: want viewInventory, got %v", m.currentView)
	}
	for i := 0; i < int(viewSnapshots); i++ {
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
		m = mm.(model)
	}
	if m.currentView != viewSnapshots {
		t.Fatalf("after %d ']' presses currentView = %v, want viewSnapshots", int(viewSnapshots), m.currentView)
	}
}

func TestSnapshotsViewContainsRowTitle(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectSnapshots(m, sampleSnapshots())
	m = switchToSnapshots(m)
	out := m.View()
	// The row title must contain engine data (reason) — always English.
	if !strings.Contains(out, "enable plugin:ecc@everything-claude-code") {
		t.Fatalf("Snapshots frame missing row engine data:\n%s", out)
	}
}

func TestSnapshotsViewChineseRendersChinese(t *testing.T) {
	defer func() { uiLang = langEN }()
	m := loadedModel(120, 30)
	m.lang = langZH // propagated into uiLang by the subsequent Update calls
	m = injectSnapshots(m, sampleSnapshots())
	m = switchToSnapshots(m)
	out := m.View()
	// The tab label must be Chinese.
	if !strings.Contains(out, "快照") {
		t.Fatalf("ZH Snapshots frame missing the 快照 tab label:\n%s", out)
	}
	// Engine data (reason) stays English.
	if !strings.Contains(out, "enable plugin:ecc@everything-claude-code") {
		t.Fatalf("ZH Snapshots frame should keep English engine data:\n%s", out)
	}
}

func TestHelpOverlayListsSnapshotsKey(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 40)
	m.showHelp = true
	out := m.View()
	if !strings.Contains(out, "jump to Snapshots") {
		t.Fatalf("help overlay should list the S → Snapshots shortcut:\n%s", out)
	}
}

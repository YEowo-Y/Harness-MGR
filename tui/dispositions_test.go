package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

// sampleDispositions returns two Disposition records covering both action paths:
//   - one removable loser (user-tier, carries a RemoveCommand), and
//   - one plugin-tier advisory loser (no RemoveCommand, advisoryOnly).
func sampleDispositions() []Disposition {
	return []Disposition{
		{
			Kind:     "agent",
			Key:      "tracer",
			Severity: "error",
			Winner: DispositionWinner{
				Name: "tracer", Path: "/cfg/agents/tracer.md", Tier: "user",
			},
			Shadowed: []DispositionShadowed{
				{
					Name:          "tracer",
					Path:          "/cfg/skills/tracker/SKILL.md",
					Tier:          "plugin",
					Plugin:        "my-plugin",
					Removable:     true,
					RemoveCommand: "remove agent:tracer",
				},
			},
			Suggestion: "Remove the user-tier duplicate to resolve the conflict.",
			RuleID:     "advice-agent-shadowing",
			DocURL:     "https://code.claude.com/docs/en/sub-agents",
			DocVersion: "2",
		},
		{
			Kind:     "skill",
			Key:      "helper",
			Severity: "warn",
			Winner: DispositionWinner{
				Name: "helper", Path: "/cfg/skills/helper/SKILL.md", Tier: "user",
			},
			Shadowed: []DispositionShadowed{
				{
					Name:      "helper",
					Path:      "/cfg/skills/helper2/SKILL.md",
					Tier:      "plugin",
					Plugin:    "other-plugin",
					Removable: false,
				},
			},
		},
	}
}

// injectDispositions delivers a dispositionsMsg to a model and returns the updated model.
func injectDispositions(m model, disps []Disposition) model {
	mm, _ := m.Update(dispositionsMsg{data: disps})
	return mm.(model)
}

// switchToDispositions navigates to the Dispositions tab directly.
// Uses a direct assignment (like TestHKeyFromDoctorAlsoJumpsToHealth) rather than
// cycling through "]" presses so that inserting a new tab before viewDispositions
// cannot silently navigate to the wrong tab.
func switchToDispositions(m model) model {
	m.currentView = viewDispositions
	return m
}

// ── parseDispositions tests ────────────────────────────────────────────────────

var sampleDispositionsJSON = []byte(`{
	"command": "conflicts",
	"version": 1,
	"result": {
		"conflicts": [],
		"dispositions": [
			{
				"kind": "agent",
				"key": "tracer",
				"severity": "error",
				"winner": {"name": "tracer", "path": "/cfg/agents/tracer.md", "tier": "user", "plugin": ""},
				"shadowed": [
					{"name": "tracer", "path": "/cfg/skills/tracker/SKILL.md", "tier": "plugin",
					 "plugin": "my-plugin", "removable": true, "removeCommand": "remove agent:tracer"}
				],
				"suggestion": "Remove the user-tier duplicate to resolve the conflict.",
				"ruleId": "advice-agent-shadowing",
				"docUrl": "https://code.claude.com/docs/en/sub-agents",
				"docVersion": "2"
			},
			{
				"kind": "skill",
				"key": "helper",
				"severity": "warn",
				"winner": {"name": "helper", "path": "/cfg/skills/helper/SKILL.md", "tier": "user", "plugin": ""},
				"shadowed": [
					{"name": "helper", "path": "/cfg/skills/helper2/SKILL.md", "tier": "plugin",
					 "plugin": "other-plugin", "removable": false, "removeCommand": ""}
				],
				"suggestion": "",
				"ruleId": "",
				"docUrl": "",
				"docVersion": ""
			}
		]
	},
	"diagnostics": []
}`)

func TestParseDispositions(t *testing.T) {
	disps, err := parseDispositions(sampleDispositionsJSON)
	if err != nil {
		t.Fatalf("parseDispositions error: %v", err)
	}
	if len(disps) != 2 {
		t.Fatalf("dispositions count = %d, want 2", len(disps))
	}
	d0 := disps[0]
	if d0.Kind != "agent" || d0.Key != "tracer" || d0.Severity != "error" {
		t.Fatalf("disps[0] = %+v, want agent/tracer/error", d0)
	}
	if d0.Winner.Path != "/cfg/agents/tracer.md" {
		t.Fatalf("disps[0].Winner.Path = %q, want /cfg/agents/tracer.md", d0.Winner.Path)
	}
	if len(d0.Shadowed) != 1 || !d0.Shadowed[0].Removable {
		t.Fatalf("disps[0].Shadowed = %+v, want one removable entry", d0.Shadowed)
	}
	if d0.Shadowed[0].RemoveCommand != "remove agent:tracer" {
		t.Fatalf("disps[0].Shadowed[0].RemoveCommand = %q, want remove agent:tracer", d0.Shadowed[0].RemoveCommand)
	}
	if d0.RuleID != "advice-agent-shadowing" {
		t.Fatalf("disps[0].RuleID = %q, want advice-agent-shadowing", d0.RuleID)
	}
	if d0.DocVersion != "2" {
		t.Fatalf("disps[0].DocVersion = %q, want 2", d0.DocVersion)
	}
	// Second disposition: advisory (non-removable loser, no suggestion).
	d1 := disps[1]
	if d1.Kind != "skill" || d1.Key != "helper" || d1.Severity != "warn" {
		t.Fatalf("disps[1] = %+v, want skill/helper/warn", d1)
	}
	if d1.Shadowed[0].Removable {
		t.Fatalf("disps[1].Shadowed[0].Removable should be false (plugin-tier advisory)")
	}
}

func TestParseDispositionsEmpty(t *testing.T) {
	data := []byte(`{"command":"conflicts","version":1,"result":{"conflicts":[],"dispositions":[]},"diagnostics":[]}`)
	disps, err := parseDispositions(data)
	if err != nil {
		t.Fatalf("parseDispositions error on empty: %v", err)
	}
	if len(disps) != 0 {
		t.Fatalf("expected 0 dispositions, got %d", len(disps))
	}
}

func TestParseDispositionsInvalidJSON(t *testing.T) {
	_, err := parseDispositions([]byte(`not json`))
	if err == nil {
		t.Fatal("parseDispositions should return error on invalid JSON")
	}
}

// ── dispositionTallies tests ───────────────────────────────────────────────────

func TestDispositionTallies(t *testing.T) {
	disps := sampleDispositions()
	tallies := dispositionTallies(disps)
	// clusters = 2, removable losers = 1, advisory losers = 1
	if tallies[0] != 2 {
		t.Fatalf("tallies[0] (clusters) = %d, want 2", tallies[0])
	}
	if tallies[1] != 1 {
		t.Fatalf("tallies[1] (removable) = %d, want 1", tallies[1])
	}
	if tallies[2] != 1 {
		t.Fatalf("tallies[2] (advisory) = %d, want 1", tallies[2])
	}
}

func TestDispositionTalliesEmpty(t *testing.T) {
	tallies := dispositionTallies(nil)
	if tallies[0] != 0 || tallies[1] != 0 || tallies[2] != 0 {
		t.Fatalf("tallies(nil) = %v, want [0 0 0]", tallies)
	}
}

// ── dispositionItems tests ────────────────────────────────────────────────────

func TestDispositionItemsCount(t *testing.T) {
	items := dispositionItems(sampleDispositions())
	if len(items) != 2 {
		t.Fatalf("dispositionItems count = %d, want 2", len(items))
	}
}

func TestDispositionItemsEmpty(t *testing.T) {
	items := dispositionItems(nil)
	if len(items) != 0 {
		t.Fatalf("dispositionItems(nil) count = %d, want 0", len(items))
	}
}

// ── Row title bilingual tests ─────────────────────────────────────────────────

func TestDispositionRowTitleEN(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0] // agent:tracer, 1 shadowed
	title := dispositionRowTitle(d)
	// Must contain kind:key prefix (engine data, always English).
	if !strings.Contains(title, "agent:tracer") {
		t.Fatalf("EN row title missing kind:key — got %q", title)
	}
	// Must read exactly "(1 shadowed)" — NOT a "%!(EXTRA int=1)" Sprintf leak from
	// passing the count to a verbless label (the tr-vs-tf trap).
	if !strings.Contains(title, "(1 shadowed)") {
		t.Fatalf("EN row title should read '(1 shadowed)' — got %q", title)
	}
	if strings.Contains(title, "%!(") {
		t.Fatalf("EN row title has a Sprintf format-arg leak — got %q", title)
	}
}

func TestDispositionRowTitleZH(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	d := sampleDispositions()[0]
	title := dispositionRowTitle(d)
	// Engine data (kind, key) stays English regardless of language.
	if !strings.Contains(title, "agent:tracer") {
		t.Fatalf("ZH row title should keep English kind:key — got %q", title)
	}
	// ZH shadow label, rendered exactly as "(1 被遮蔽)" with no Sprintf leak.
	if !strings.Contains(title, "(1 被遮蔽)") {
		t.Fatalf("ZH row title should read '(1 被遮蔽)' — got %q", title)
	}
	if strings.Contains(title, "%!(") {
		t.Fatalf("ZH row title has a Sprintf format-arg leak — got %q", title)
	}
}

// ── dispositionDetail content tests ──────────────────────────────────────────

func TestDispositionDetailShowsWinnerPath(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0]
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "/cfg/agents/tracer.md") {
		t.Fatalf("detail missing winner path:\n%s", body)
	}
	if !strings.Contains(body, "user") { // winner tier
		t.Fatalf("detail missing winner tier:\n%s", body)
	}
}

func TestDispositionDetailShowsShadowedPath(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0]
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "/cfg/skills/tracker/SKILL.md") {
		t.Fatalf("detail missing shadowed path:\n%s", body)
	}
}

func TestDispositionDetailShowsSuggestion(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0]
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "Remove the user-tier duplicate") {
		t.Fatalf("detail missing suggestion text:\n%s", body)
	}
}

func TestDispositionDetailShowsRemoveCommand(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0]
	body := dispositionDetail(d, 120)
	// Removable loser: show the remove command.
	if !strings.Contains(body, "remove agent:tracer") {
		t.Fatalf("detail missing remove command:\n%s", body)
	}
}

func TestDispositionDetailShowsReference(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[0]
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "advice-agent-shadowing") {
		t.Fatalf("detail missing ruleId:\n%s", body)
	}
	if !strings.Contains(body, "code.claude.com") {
		t.Fatalf("detail missing docUrl:\n%s", body)
	}
	if !strings.Contains(body, "(v2)") {
		t.Fatalf("detail missing doc version (v2):\n%s", body)
	}
}

// ── Plugin advisory path ──────────────────────────────────────────────────────

func TestDispositionPluginAdvisoryEN(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	d := sampleDispositions()[1] // advisory loser (Removable=false)
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "disable or uninstall the plugin") {
		t.Fatalf("EN advisory detail missing plugin advisory text:\n%s", body)
	}
}

func TestDispositionPluginAdvisoryZH(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	d := sampleDispositions()[1]
	body := dispositionDetail(d, 120)
	if !strings.Contains(body, "禁用或卸载插件") {
		t.Fatalf("ZH advisory detail missing ZH plugin advisory text:\n%s", body)
	}
}

// ── docWithVersion helper ─────────────────────────────────────────────────────

func TestDocWithVersion(t *testing.T) {
	got := docWithVersion("https://example.com", "3")
	want := "https://example.com (v3)"
	if got != want {
		t.Fatalf("docWithVersion = %q, want %q", got, want)
	}
}

func TestDocWithVersionEmptyVer(t *testing.T) {
	got := docWithVersion("https://example.com", "")
	if got != "https://example.com" {
		t.Fatalf("docWithVersion empty ver = %q, want %q", got, "https://example.com")
	}
}

func TestDocWithVersionEmptyURL(t *testing.T) {
	got := docWithVersion("", "3")
	if got != "" {
		t.Fatalf("docWithVersion empty url = %q, want empty", got)
	}
}

// ── pluginOrUnknown helper ────────────────────────────────────────────────────

func TestPluginOrUnknownNonEmpty(t *testing.T) {
	got := pluginOrUnknown("my-plugin")
	if got != "my-plugin" {
		t.Fatalf("pluginOrUnknown non-empty = %q, want %q", got, "my-plugin")
	}
}

func TestPluginOrUnknownEmptyEN(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	got := pluginOrUnknown("")
	if !strings.Contains(got, "none") {
		t.Fatalf("EN pluginOrUnknown empty = %q, want to contain 'none'", got)
	}
}

func TestPluginOrUnknownEmptyZH(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	got := pluginOrUnknown("")
	if !strings.Contains(got, "无") {
		t.Fatalf("ZH pluginOrUnknown empty = %q, want to contain '无'", got)
	}
}

// ── Model-level: dispositionsMsg delivery ─────────────────────────────────────

func TestDispositionsMsgSetsListAndSummary(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions())

	st := m.sections[viewDispositions]
	if st == nil {
		t.Fatal("sections[viewDispositions] is nil after dispositionsMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after dispositionsMsg")
	}
	if !st.loaded {
		t.Fatal("loaded should be true after dispositionsMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	// Summary: 2 clusters · 1 removable · 1 advisory.
	sum := st.summaryText()
	if !strings.Contains(sum, "2") {
		t.Fatalf("summary = %q, want cluster count 2", sum)
	}
	if !strings.Contains(sum, "1") {
		t.Fatalf("summary = %q, want removable/advisory count 1", sum)
	}
}

func TestDispositionsMsgSummaryZH(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions())
	sum := m.sections[viewDispositions].summaryText()
	if !strings.Contains(sum, "簇") {
		t.Fatalf("ZH summary = %q, want 簇 label", sum)
	}
	if !strings.Contains(sum, "可删除") {
		t.Fatalf("ZH summary = %q, want 可删除 label", sum)
	}
	if !strings.Contains(sum, "建议性") {
		t.Fatalf("ZH summary = %q, want 建议性 label", sum)
	}
}

func TestDispositionsErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(dispositionsMsg{err: errFmt("dispositions boom")})
	m = mm.(model)
	m = switchToDispositions(m)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("dispositions error state not rendered:\n%s", out)
	}
}

// ── tabBadge tests ────────────────────────────────────────────────────────────

func TestDispositionsBadgeRedOnError(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions()) // first entry has severity "error"
	color, show := tabBadge(m, viewDispositions)
	if !show {
		t.Fatal("tabBadge should show a badge for error-severity dispositions")
	}
	if color != colorRed {
		t.Fatalf("tabBadge color = %v, want colorRed (error severity)", color)
	}
}

func TestDispositionsBadgeOrangeOnWarnOnly(t *testing.T) {
	// Use only the warn-severity disposition (index 1).
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions()[1:]) // only the warn one
	color, show := tabBadge(m, viewDispositions)
	if !show {
		t.Fatal("tabBadge should show a badge for warn-severity dispositions")
	}
	if color != colorOrange {
		t.Fatalf("tabBadge color = %v, want colorOrange (warn severity)", color)
	}
}

func TestDispositionsBadgeHiddenWhenEmpty(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDispositions(m, nil) // empty dispositions
	_, show := tabBadge(m, viewDispositions)
	if show {
		t.Fatal("tabBadge should not show a badge when there are no dispositions")
	}
}

// ── Navigation: D key and cycle ───────────────────────────────────────────────

func TestDKeyNavigatesToDispositions(t *testing.T) {
	m := loadedModel(120, 30) // starts on Inventory
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("D")})
	m = mm.(model)
	if m.currentView != viewDispositions {
		t.Fatalf("D key should jump to viewDispositions, got %v", m.currentView)
	}
}

func TestDispositionsReachableByCycle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions())
	m = switchToDispositions(m)
	if m.currentView != viewDispositions {
		t.Fatalf("after %d ']' presses currentView = %v, want viewDispositions", int(viewDispositions), m.currentView)
	}
}

func TestDispositionsViewContainsRowTitle(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectDispositions(m, sampleDispositions())
	m = switchToDispositions(m)
	out := m.View()
	// The row title must contain engine data (kind:key) — always English.
	if !strings.Contains(out, "agent:tracer") {
		t.Fatalf("Dispositions frame missing row engine data:\n%s", out)
	}
}

func TestDispositionsViewChineseRendersChinese(t *testing.T) {
	defer func() { uiLang = langEN }()
	m := loadedModel(120, 30)
	m.lang = langZH
	m = injectDispositions(m, sampleDispositions())
	m = switchToDispositions(m)
	out := m.View()
	// The tab label must be Chinese.
	if !strings.Contains(out, "处置建议") {
		t.Fatalf("ZH Dispositions frame missing the 处置建议 tab label:\n%s", out)
	}
	// Engine data (kind:key) stays English.
	if !strings.Contains(out, "agent:tracer") {
		t.Fatalf("ZH Dispositions frame should keep English engine data:\n%s", out)
	}
}

func TestHelpOverlayListsDispositionsKey(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m.showHelp = true
	out := m.View()
	if !strings.Contains(out, "jump to Dispositions") {
		t.Fatalf("help overlay should list the D → Dispositions shortcut:\n%s", out)
	}
}

package main

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

func sampleConfigResult() ConfigResult {
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	return ConfigResult{
		Keys: map[string]ConfigKey{
			"theme": {
				Key:             "theme",
				MergeConfidence: "known",
				Strategy:        "scalar-highest",
				PerLayer: []ConfigLayer{
					{Name: "user", Value: raw(`"dark"`)},
				},
			},
			"model": {
				Key:             "model",
				MergeConfidence: "unknown",
				Strategy:        "scalar-highest",
				PerLayer: []ConfigLayer{
					{Name: "project", Value: raw(`"claude-sonnet-4-6"`)},
				},
			},
			"permissions": {
				Key:             "permissions",
				MergeConfidence: "known",
				Strategy:        "array-union",
				PerLayer: []ConfigLayer{
					{Name: "user", Value: raw(`["Bash","Edit"]`)},
					{Name: "project", Value: raw(`["Read"]`)},
				},
			},
		},
	}
}

func sampleHooksResult() HooksResult {
	return HooksResult{
		Hooks: map[string][]HookEntry{
			"PostToolUse": {
				{
					Matcher: "Bash",
					Hooks:   []HookCmd{{Type: "command", Command: "echo done"}},
				},
			},
			"PreToolUse": {
				{
					Hooks: []HookCmd{
						{Type: "command", Command: "echo pre"},
						{Type: "command", Command: "logger pre"},
					},
				},
			},
		},
	}
}

func sampleSelftestResult() SelftestResult {
	return SelftestResult{
		Ok: false,
		Checks: []SelftestCheck{
			{Name: "lint", Ok: true},
			{Name: "invariants", Ok: true},
			{Name: "boundary", Ok: false},
		},
	}
}

func sampleSelftestAllOk() SelftestResult {
	return SelftestResult{
		Ok: true,
		Checks: []SelftestCheck{
			{Name: "lint", Ok: true},
			{Name: "invariants", Ok: true},
		},
	}
}

// injectConfig/Hooks/Selftest deliver the three new msgs to a model.
func injectConfig(m model, r ConfigResult) model {
	mm, _ := m.Update(configMsg{data: r})
	return mm.(model)
}

func injectHooks(m model, r HooksResult) model {
	mm, _ := m.Update(hooksMsg{data: r})
	return mm.(model)
}

func injectSelftest(m model, r SelftestResult) model {
	mm, _ := m.Update(selftestMsg{data: r})
	return mm.(model)
}

// ── parseConfig tests ─────────────────────────────────────────────────────────

var sampleConfigJSON = []byte(`{
	"command": "config",
	"version": 1,
	"result": {
		"keys": {
			"theme": {
				"key": "theme",
				"mergeConfidence": "known",
				"strategy": "scalar-highest",
				"perLayer": [{"name": "user", "value": "\"dark\""}]
			}
		}
	},
	"diagnostics": []
}`)

func TestParseConfigHappyPath(t *testing.T) {
	r, err := parseConfig(sampleConfigJSON)
	if err != nil {
		t.Fatalf("parseConfig error: %v", err)
	}
	if len(r.Keys) != 1 {
		t.Fatalf("Keys count = %d, want 1", len(r.Keys))
	}
	ck, ok := r.Keys["theme"]
	if !ok {
		t.Fatal("expected key 'theme'")
	}
	if ck.MergeConfidence != "known" {
		t.Fatalf("MergeConfidence = %q, want %q", ck.MergeConfidence, "known")
	}
	if ck.Strategy != "scalar-highest" {
		t.Fatalf("Strategy = %q, want %q", ck.Strategy, "scalar-highest")
	}
	if len(ck.PerLayer) != 1 {
		t.Fatalf("PerLayer count = %d, want 1", len(ck.PerLayer))
	}
}

func TestParseConfigEmpty(t *testing.T) {
	data := []byte(`{"command":"config","version":1,"result":{"keys":{}},"diagnostics":[]}`)
	r, err := parseConfig(data)
	if err != nil {
		t.Fatalf("parseConfig error: %v", err)
	}
	if len(r.Keys) != 0 {
		t.Fatalf("expected 0 keys, got %d", len(r.Keys))
	}
}

func TestParseConfigInvalidJSON(t *testing.T) {
	_, err := parseConfig([]byte(`not json`))
	if err == nil {
		t.Fatal("parseConfig should return error on invalid JSON")
	}
}

// ── parseHooks tests ──────────────────────────────────────────────────────────

var sampleHooksJSON = []byte(`{
	"command": "hooks",
	"version": 1,
	"result": {
		"hooks": {
			"PostToolUse": [
				{
					"matcher": "Bash",
					"hooks": [{"type": "command", "command": "echo done"}]
				}
			]
		}
	},
	"diagnostics": []
}`)

func TestParseHooksHappyPath(t *testing.T) {
	r, err := parseHooks(sampleHooksJSON)
	if err != nil {
		t.Fatalf("parseHooks error: %v", err)
	}
	if len(r.Hooks) != 1 {
		t.Fatalf("Hooks count = %d, want 1", len(r.Hooks))
	}
	entries, ok := r.Hooks["PostToolUse"]
	if !ok {
		t.Fatal("expected event 'PostToolUse'")
	}
	if len(entries) != 1 {
		t.Fatalf("entries count = %d, want 1", len(entries))
	}
	if entries[0].Matcher != "Bash" {
		t.Fatalf("Matcher = %q, want %q", entries[0].Matcher, "Bash")
	}
	if len(entries[0].Hooks) != 1 {
		t.Fatalf("Hooks count = %d, want 1", len(entries[0].Hooks))
	}
	if entries[0].Hooks[0].Command != "echo done" {
		t.Fatalf("Command = %q, want %q", entries[0].Hooks[0].Command, "echo done")
	}
}

func TestParseHooksEmpty(t *testing.T) {
	data := []byte(`{"command":"hooks","version":1,"result":{"hooks":{}},"diagnostics":[]}`)
	r, err := parseHooks(data)
	if err != nil {
		t.Fatalf("parseHooks error: %v", err)
	}
	if len(r.Hooks) != 0 {
		t.Fatalf("expected 0 events, got %d", len(r.Hooks))
	}
}

func TestParseHooksInvalidJSON(t *testing.T) {
	_, err := parseHooks([]byte(`not json`))
	if err == nil {
		t.Fatal("parseHooks should return error on invalid JSON")
	}
}

// ── parseSelftest tests ───────────────────────────────────────────────────────

var sampleSelftestJSON = []byte(`{
	"command": "selftest",
	"version": 1,
	"result": {
		"checks": [
			{"name": "lint", "ok": true},
			{"name": "boundary", "ok": false}
		],
		"ok": false
	},
	"diagnostics": []
}`)

func TestParseSelftestHappyPath(t *testing.T) {
	r, err := parseSelftest(sampleSelftestJSON)
	if err != nil {
		t.Fatalf("parseSelftest error: %v", err)
	}
	if len(r.Checks) != 2 {
		t.Fatalf("Checks count = %d, want 2", len(r.Checks))
	}
	if r.Checks[0].Name != "lint" {
		t.Fatalf("Checks[0].Name = %q, want %q", r.Checks[0].Name, "lint")
	}
	if !r.Checks[0].Ok {
		t.Fatal("Checks[0].Ok should be true")
	}
	if r.Checks[1].Ok {
		t.Fatal("Checks[1].Ok should be false")
	}
	if r.Ok {
		t.Fatal("Result.Ok should be false")
	}
}

func TestParseSelftestEmpty(t *testing.T) {
	data := []byte(`{"command":"selftest","version":1,"result":{"checks":[],"ok":true},"diagnostics":[]}`)
	r, err := parseSelftest(data)
	if err != nil {
		t.Fatalf("parseSelftest error: %v", err)
	}
	if len(r.Checks) != 0 {
		t.Fatalf("expected 0 checks, got %d", len(r.Checks))
	}
	if !r.Ok {
		t.Fatal("Result.Ok should be true")
	}
}

func TestParseSelftestInvalidJSON(t *testing.T) {
	_, err := parseSelftest([]byte(`not json`))
	if err == nil {
		t.Fatal("parseSelftest should return error on invalid JSON")
	}
}

// ── configItems tests ─────────────────────────────────────────────────────────

func TestConfigItemsCount(t *testing.T) {
	items := configItems(sampleConfigResult())
	if len(items) != 3 {
		t.Fatalf("configItems count = %d, want 3", len(items))
	}
}

func TestConfigItemsSortedOrder(t *testing.T) {
	items := configItems(sampleConfigResult())
	// sorted: "model", "permissions", "theme"
	if items[0].title != "model" {
		t.Fatalf("items[0].title = %q, want %q", items[0].title, "model")
	}
	if items[1].title != "permissions" {
		t.Fatalf("items[1].title = %q, want %q", items[1].title, "permissions")
	}
	if items[2].title != "theme" {
		t.Fatalf("items[2].title = %q, want %q", items[2].title, "theme")
	}
}

func TestConfigItemsKnownConfidenceGreen(t *testing.T) {
	items := configItems(sampleConfigResult())
	// "theme" is known → colorPlugin (green)
	themeItem := items[2]
	if themeItem.color != colorPlugin {
		t.Fatalf("known confidence color = %v, want colorPlugin", themeItem.color)
	}
}

func TestConfigItemsUnknownConfidenceAmber(t *testing.T) {
	items := configItems(sampleConfigResult())
	// "model" is unknown → colorCommand (amber)
	modelItem := items[0]
	if modelItem.color != colorCommand {
		t.Fatalf("unknown confidence color = %v, want colorCommand", modelItem.color)
	}
}

func TestConfigItemsDetailContainsMergeConfidence(t *testing.T) {
	items := configItems(sampleConfigResult())
	// any item's detail should mention its confidence
	if !strings.Contains(items[2].detail, "known") {
		t.Fatalf("config detail missing mergeConfidence:\n%s", items[2].detail)
	}
}

func TestConfigItemsDetailContainsLayerName(t *testing.T) {
	items := configItems(sampleConfigResult())
	// "theme" has layer "user"
	if !strings.Contains(items[2].detail, "user") {
		t.Fatalf("config detail missing layer name:\n%s", items[2].detail)
	}
}

func TestConfigItemsDetailContainsLayerValue(t *testing.T) {
	items := configItems(sampleConfigResult())
	// "theme" layer value is "dark"
	if !strings.Contains(items[2].detail, "dark") {
		t.Fatalf("config detail missing layer value:\n%s", items[2].detail)
	}
}

func TestConfigItemsEmpty(t *testing.T) {
	items := configItems(ConfigResult{Keys: map[string]ConfigKey{}})
	if len(items) != 0 {
		t.Fatalf("configItems(empty) count = %d, want 0", len(items))
	}
}

// TestConfigItemsNilKeys covers a nil Keys map (what `"keys": null` decodes to),
// which must yield zero items without panicking.
func TestConfigItemsNilKeys(t *testing.T) {
	items := configItems(ConfigResult{})
	if len(items) != 0 {
		t.Fatalf("configItems(nil keys) count = %d, want 0", len(items))
	}
}

// ── hooksItems tests ──────────────────────────────────────────────────────────

func TestHooksItemsCount(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	if len(items) != 2 {
		t.Fatalf("hooksItems count = %d, want 2", len(items))
	}
}

func TestHooksItemsSortedOrder(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	// sorted: "PostToolUse", "PreToolUse"
	if !strings.HasPrefix(items[0].title, "PostToolUse") {
		t.Fatalf("items[0].title = %q, want prefix PostToolUse", items[0].title)
	}
	if !strings.HasPrefix(items[1].title, "PreToolUse") {
		t.Fatalf("items[1].title = %q, want prefix PreToolUse", items[1].title)
	}
}

func TestHooksItemsTitleIncludesCount(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	// PostToolUse has 1 entry; PreToolUse has 1 entry
	if !strings.Contains(items[0].title, "(1)") {
		t.Fatalf("hooksItems title missing entry count: %q", items[0].title)
	}
}

func TestHooksItemsColor(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	if items[0].color != accent {
		t.Fatalf("hooks item color = %v, want accent", items[0].color)
	}
}

func TestHooksItemsDetailContainsMatcher(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	// PostToolUse has matcher "Bash"
	if !strings.Contains(items[0].detail, "Bash") {
		t.Fatalf("hooks detail missing matcher:\n%s", items[0].detail)
	}
}

func TestHooksItemsDetailContainsCommand(t *testing.T) {
	items := hooksItems(sampleHooksResult())
	if !strings.Contains(items[0].detail, "echo done") {
		t.Fatalf("hooks detail missing command:\n%s", items[0].detail)
	}
}

func TestHooksItemsEmpty(t *testing.T) {
	items := hooksItems(HooksResult{Hooks: map[string][]HookEntry{}})
	if len(items) != 0 {
		t.Fatalf("hooksItems(empty) count = %d, want 0", len(items))
	}
}

// TestHooksItemsNilHooks covers a nil Hooks map (what `"hooks": null` decodes
// to), which must yield zero items without panicking.
func TestHooksItemsNilHooks(t *testing.T) {
	items := hooksItems(HooksResult{})
	if len(items) != 0 {
		t.Fatalf("hooksItems(nil hooks) count = %d, want 0", len(items))
	}
}

// ── selftestItems tests ───────────────────────────────────────────────────────

func TestSelftestItemsCount(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	if len(items) != 3 {
		t.Fatalf("selftestItems count = %d, want 3", len(items))
	}
}

func TestSelftestItemsPassingGreen(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	// "lint" is ok → colorPlugin (green)
	if items[0].color != colorPlugin {
		t.Fatalf("passing check color = %v, want colorPlugin", items[0].color)
	}
}

func TestSelftestItemsFailingRed(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	// "boundary" is failing → colorRed
	if items[2].color != colorRed {
		t.Fatalf("failing check color = %v, want colorRed", items[2].color)
	}
}

func TestSelftestItemsPassingTitleContainsOk(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	if !strings.Contains(items[0].title, "lint") {
		t.Fatalf("passing item title missing name: %q", items[0].title)
	}
}

func TestSelftestItemsFailingTitleContainsName(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	if !strings.Contains(items[2].title, "boundary") {
		t.Fatalf("failing item title missing name: %q", items[2].title)
	}
}

func TestSelftestItemsDetailContainsStatus(t *testing.T) {
	items := selftestItems(sampleSelftestResult())
	// passing: "ok"
	if !strings.Contains(items[0].detail, "ok") {
		t.Fatalf("passing detail missing status:\n%s", items[0].detail)
	}
	// failing: "failing"
	if !strings.Contains(items[2].detail, "failing") {
		t.Fatalf("failing detail missing status:\n%s", items[2].detail)
	}
}

func TestSelftestItemsEmpty(t *testing.T) {
	items := selftestItems(SelftestResult{})
	if len(items) != 0 {
		t.Fatalf("selftestItems(empty) count = %d, want 0", len(items))
	}
}

// ── Model-level: configMsg delivery ──────────────────────────────────────────

func TestConfigMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectConfig(m, sampleConfigResult())

	st := m.sections[viewConfig]
	if st == nil {
		t.Fatal("sections[viewConfig] is nil after configMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after configMsg")
	}
	if len(st.list.items) != 3 {
		t.Fatalf("list items = %d, want 3", len(st.list.items))
	}
	if !strings.Contains(st.summary, "3 keys") {
		t.Fatalf("summary = %q, want to contain %q", st.summary, "3 keys")
	}
}

func TestHooksMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectHooks(m, sampleHooksResult())

	st := m.sections[viewHooks]
	if st == nil {
		t.Fatal("sections[viewHooks] is nil after hooksMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after hooksMsg")
	}
	if len(st.list.items) != 2 {
		t.Fatalf("list items = %d, want 2", len(st.list.items))
	}
	if !strings.Contains(st.summary, "2 events") {
		t.Fatalf("summary = %q, want to contain %q", st.summary, "2 events")
	}
}

func TestSelftestMsgSetsListAndSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectSelftest(m, sampleSelftestResult())

	st := m.sections[viewSelftest]
	if st == nil {
		t.Fatal("sections[viewSelftest] is nil after selftestMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after selftestMsg")
	}
	if len(st.list.items) != 3 {
		t.Fatalf("list items = %d, want 3", len(st.list.items))
	}
	if !strings.Contains(st.summary, "1 failing") {
		t.Fatalf("summary = %q, want to contain %q", st.summary, "1 failing")
	}
}

func TestSelftestMsgSummaryAllOk(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectSelftest(m, sampleSelftestAllOk())

	st := m.sections[viewSelftest]
	if !strings.Contains(st.summary, "all ok") {
		t.Fatalf("all-ok summary = %q, want to contain %q", st.summary, "all ok")
	}
}

// ── View-level: switching to tabs 4/5/6 ──────────────────────────────────────

func TestSwitchToConfigViewContainsKeyTitle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectConfig(m, sampleConfigResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	if m.currentView != viewConfig {
		t.Fatalf("currentView = %v, want viewConfig", m.currentView)
	}
	out := m.View()
	// sorted first key is "model"
	if !strings.Contains(out, "model") {
		t.Fatalf("Config frame missing key title %q:\n%s", "model", out)
	}
}

func TestSwitchToConfigViewContainsSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectConfig(m, sampleConfigResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "3 keys") {
		t.Fatalf("Config frame missing summary %q:\n%s", "3 keys", out)
	}
}

func TestSwitchToHooksViewContainsEventTitle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectHooks(m, sampleHooksResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("5")})
	m = mm.(model)
	if m.currentView != viewHooks {
		t.Fatalf("currentView = %v, want viewHooks", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "PostToolUse") {
		t.Fatalf("Hooks frame missing event title %q:\n%s", "PostToolUse", out)
	}
}

func TestSwitchToSelftestViewContainsCheckTitle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectSelftest(m, sampleSelftestResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("6")})
	m = mm.(model)
	if m.currentView != viewSelftest {
		t.Fatalf("currentView = %v, want viewSelftest", m.currentView)
	}
	out := m.View()
	if !strings.Contains(out, "lint") {
		t.Fatalf("Selftest frame missing check name %q:\n%s", "lint", out)
	}
}

func TestSwitchToSelftestViewContainsSummary(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectSelftest(m, sampleSelftestResult())

	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("6")})
	m = mm.(model)
	out := m.View()
	if !strings.Contains(out, "failing") {
		t.Fatalf("Selftest frame missing summary with %q:\n%s", "failing", out)
	}
}

// ── Error state ───────────────────────────────────────────────────────────────

func TestConfigErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(configMsg{err: errFmt("config boom")})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("4")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("config error state not rendered:\n%s", out)
	}
}

func TestHooksErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(hooksMsg{err: errFmt("hooks boom")})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("5")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("hooks error state not rendered:\n%s", out)
	}
}

func TestSelftestErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(selftestMsg{err: errFmt("selftest boom")})
	m = mm.(model)
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("6")})
	m = mm.(model)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("selftest error state not rendered:\n%s", out)
	}
}

// errFmt is a thin fmt.Errorf-equivalent without importing fmt.
func errFmt(msg string) error { return &simpleErr{msg} }

type simpleErr struct{ s string }

func (e *simpleErr) Error() string { return e.s }

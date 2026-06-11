package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// ── Sample data helpers ───────────────────────────────────────────────────────

// sampleHealthReport models a representative passive run that exercises every
// row tier of healthItems:
//   - a not-loaded component (red) with an error reason,
//   - a degraded component (orange) with a warn reason,
//   - a loadable component (green) — must NOT appear in the problem list,
//   - an error advice card (with B1 zh fields) + a warn advice card whose zh
//     fields are EMPTY (exercises the English fallback) + an info card,
//   - a missing hook (red) + an indeterminate hook (orange) + a found hook
//     (must NOT appear in the problem list).
func sampleHealthReport() HealthReport {
	return HealthReport{
		Health: HealthSection{
			Summary: HealthSummary{Total: 3, Loadable: 1, Degraded: 1, NotLoaded: 1},
			Components: []HealthComponent{
				{
					Kind: "agent", Name: "broken-agent", Path: "/cfg/agents/broken-agent.md",
					Scope: "user", Status: "not-loaded", WorstSeverity: "error",
					Reasons: []HealthReason{
						{Code: "agent-shadowed", Severity: "error", Message: "shadowed by a higher-tier agent"},
					},
				},
				{
					Kind: "skill", Name: "shaky-skill", Path: "/cfg/skills/shaky-skill/SKILL.md",
					Scope: "user", Status: "degraded", WorstSeverity: "warn",
					Reasons: []HealthReason{
						{Code: "skill-shadowing-winner", Severity: "warn", Message: "shadows a same-named skill"},
					},
				},
				{
					Kind: "command", Name: "good-command", Path: "/cfg/commands/good-command.md",
					Scope: "user", Status: "loadable", WorstSeverity: "",
				},
			},
		},
		Advice: AdviceSection{
			Summary: AdviceSummary{Total: 3, Error: 1, Warn: 1, Info: 1},
			Advice: []AdviceItem{
				{
					RuleID: "overbroad-permissions", Title: "Tighten overbroad permissions", TitleZh: "收紧过宽权限",
					Severity: "warn", Advice: "permissions.allow has wildcards", AdviceZh: "permissions.allow 含有通配符",
					Fix: "replace with specific rules", FixZh: "替换为具体规则",
					AffectedPaths: []string{"settings.json"}, MatchedCodes: []string{"permissions-overbroad"},
					DocURL: "https://code.claude.com/docs/en/permissions", DocVersion: "1",
				},
				{
					RuleID: "config-error", Title: "Fix invalid settings.json", TitleZh: "修复无效的 settings.json",
					Severity: "error", Advice: "settings.json has a duplicate key", AdviceZh: "settings.json 有重复键",
					Fix: "remove the duplicate", FixZh: "删除重复键",
					AffectedPaths: []string{"settings.json"}, MatchedCodes: []string{"settings-json-valid"},
					DocURL: "https://code.claude.com/docs/en/settings", DocVersion: "1",
				},
				{
					// A CUSTOM rule with EMPTY zh fields — exercises the English fallback.
					RuleID: "custom-info", Title: "Custom advisory", TitleZh: "",
					Severity: "info", Advice: "an informational note", AdviceZh: "",
					Fix: "no action needed", FixZh: "",
					MatchedCodes: []string{"some-info-code"},
				},
			},
		},
		Hooks: HooksHealthSection{
			Summary: HooksHealthSummary{
				Total: 3, Missing: 1, Indeterminate: 1,
				ByKind: HooksByKind{File: 2, External: 1},
			},
			Explanations: []HookExplanation{
				{
					Event: "PreToolUse", Matcher: "Bash", Command: `node "$HOME/.claude/hooks/missing.mjs"`,
					Kind: "file", Target: "/cfg/hooks/missing.mjs", Status: "missing",
					Explanation: `On PreToolUse, for tools matching "Bash", runs the script "missing.mjs" (file, missing).`,
				},
				{
					Event: "SessionStart", Command: `node "$CLAUDE_PROJECT_DIR/x.mjs"`,
					Kind: "file", Target: "", Status: "indeterminate",
					Explanation: `On SessionStart, runs a script whose path could not be fully resolved (indeterminate).`,
				},
				{
					Event: "PostToolUse", Command: `any-buddy apply --silent`,
					Kind: "external", Target: "any-buddy", Status: "found",
					Explanation: `On PostToolUse, runs the external command "any-buddy" (found).`,
				},
			},
		},
		Diagnostics: []Diagnostic{
			{Severity: "warn", Code: "permissions-overbroad", Message: "wildcard rule"},
		},
	}
}

// injectHealth delivers a healthMsg to a model and returns the updated model.
func injectHealth(m model, r HealthReport) model {
	mm, _ := m.Update(healthMsg{data: r})
	return mm.(model)
}

// ── parseHealth tests ─────────────────────────────────────────────────────────

var sampleHealthJSON = []byte(`{
	"command": "health",
	"version": 1,
	"result": {
		"health": {
			"summary": {"total": 2, "loadable": 1, "degraded": 0, "notLoaded": 1},
			"groups": [{"scope": "user", "kind": "agent", "status": "not-loaded", "count": 1, "names": ["a"]}],
			"components": [
				{"kind": "agent", "name": "a", "path": "/cfg/agents/a.md", "scope": "user",
				 "status": "not-loaded", "worstSeverity": "error",
				 "reasons": [{"code": "agent-shadowed", "severity": "error", "message": "shadowed"}]},
				{"kind": "command", "name": "b", "path": "/cfg/commands/b.md", "scope": "user",
				 "status": "loadable", "worstSeverity": null, "reasons": []}
			]
		},
		"advice": {
			"summary": {"total": 1, "error": 0, "warn": 1, "info": 0},
			"advice": [
				{"ruleId": "overbroad-permissions", "title": "Tighten permissions", "titleZh": "收紧权限",
				 "severity": "warn", "advice": "wildcards present", "adviceZh": "存在通配符",
				 "fix": "use specific rules", "fixZh": "使用具体规则",
				 "affectedPaths": ["settings.json"], "matchedCodes": ["permissions-overbroad"],
				 "docUrl": "https://code.claude.com/docs/en/permissions", "docVersion": "1"}
			]
		},
		"hooks": {
			"summary": {"total": 1, "missing": 1, "indeterminate": 0, "byKind": {"file": 1, "external": 0, "opaque": 0}},
			"explanations": [
				{"event": "PreToolUse", "matcher": "Bash", "command": "node x.mjs",
				 "kind": "file", "target": "/cfg/hooks/x.mjs", "status": "missing",
				 "explanation": "runs x.mjs (file, missing)."}
			]
		}
	},
	"diagnostics": [
		{"severity": "warn", "code": "permissions-overbroad", "message": "wildcard rule", "phase": "doctor"}
	]
}`)

func TestParseHealthHappyPath(t *testing.T) {
	r, err := parseHealth(sampleHealthJSON)
	if err != nil {
		t.Fatalf("parseHealth error: %v", err)
	}
	if r.Health.Summary.NotLoaded != 1 {
		t.Fatalf("Health.Summary.NotLoaded = %d, want 1", r.Health.Summary.NotLoaded)
	}
	if len(r.Health.Components) != 2 {
		t.Fatalf("Components count = %d, want 2", len(r.Health.Components))
	}
	c0 := r.Health.Components[0]
	if c0.Kind != "agent" || c0.Name != "a" || c0.Status != "not-loaded" {
		t.Fatalf("Components[0] = %+v, want agent/a/not-loaded", c0)
	}
	if len(c0.Reasons) != 1 || c0.Reasons[0].Severity != "error" {
		t.Fatalf("Components[0].Reasons = %+v, want one error reason", c0.Reasons)
	}
	// worstSeverity null on the loadable component → "".
	if r.Health.Components[1].WorstSeverity != "" {
		t.Fatalf("loadable WorstSeverity = %q, want empty (null)", r.Health.Components[1].WorstSeverity)
	}
	if len(r.Advice.Advice) != 1 {
		t.Fatalf("Advice count = %d, want 1", len(r.Advice.Advice))
	}
	a0 := r.Advice.Advice[0]
	if a0.Title != "Tighten permissions" || a0.TitleZh != "收紧权限" {
		t.Fatalf("Advice[0] title/titleZh = %q/%q", a0.Title, a0.TitleZh)
	}
	if len(r.Hooks.Explanations) != 1 || r.Hooks.Explanations[0].Status != "missing" {
		t.Fatalf("Hooks.Explanations = %+v, want one missing hook", r.Hooks.Explanations)
	}
	if r.Hooks.Summary.ByKind.File != 1 {
		t.Fatalf("Hooks.Summary.ByKind.File = %d, want 1", r.Hooks.Summary.ByKind.File)
	}
	if len(r.Diagnostics) != 1 || r.Diagnostics[0].Code != "permissions-overbroad" {
		t.Fatalf("Diagnostics = %+v, want one permissions-overbroad diag", r.Diagnostics)
	}
}

func TestParseHealthEmpty(t *testing.T) {
	data := []byte(`{"command":"health","version":1,"result":{"health":{"summary":{"total":0,"loadable":0,"degraded":0,"notLoaded":0},"components":[]},"advice":{"summary":{"total":0,"error":0,"warn":0,"info":0},"advice":[]},"hooks":{"summary":{"total":0,"missing":0,"indeterminate":0,"byKind":{"file":0,"external":0,"opaque":0}},"explanations":[]}},"diagnostics":[]}`)
	r, err := parseHealth(data)
	if err != nil {
		t.Fatalf("parseHealth error: %v", err)
	}
	if len(r.Health.Components) != 0 || len(r.Advice.Advice) != 0 || len(r.Hooks.Explanations) != 0 {
		t.Fatalf("expected all-empty report, got %+v", r)
	}
}

func TestParseHealthInvalidJSON(t *testing.T) {
	_, err := parseHealth([]byte(`not json`))
	if err == nil {
		t.Fatal("parseHealth should return error on invalid JSON")
	}
}

// ── healthItems tier / count / order / color / icon tests ──────────────────────

func TestHealthItemsCountAndTierOrder(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	items := healthItems(sampleHealthReport())
	// 1 not-loaded + 1 degraded + 3 advice (err/warn/info) + 2 problem hooks = 7.
	// Loadable component + found hook are excluded.
	if len(items) != 7 {
		t.Fatalf("healthItems count = %d, want 7", len(items))
	}
	// Tier order: not-loaded comp → degraded comp → advice(error,warn,info) → hooks.
	wantContains := []string{
		"broken-agent",                  // tier 1: not-loaded component
		"shaky-skill",                   // tier 2: degraded component
		"Fix invalid settings.json",     // tier 3a: error advice (sorted error first)
		"Tighten overbroad permissions", // tier 3b: warn advice
		"Custom advisory",               // tier 3c: info advice
		"PreToolUse",                    // tier 4a: missing hook
		"SessionStart",                  // tier 4b: indeterminate hook
	}
	for i, want := range wantContains {
		if !strings.Contains(items[i].title, want) {
			t.Fatalf("items[%d].title = %q, want to contain %q", i, items[i].title, want)
		}
	}
}

func TestHealthItemsExcludesHealthyRows(t *testing.T) {
	items := healthItems(sampleHealthReport())
	joined := ""
	for _, it := range items {
		joined += it.title + "\n"
	}
	// The loadable component and the found hook must NOT appear in the problem list.
	if strings.Contains(joined, "good-command") {
		t.Fatalf("loadable component leaked into the problem list:\n%s", joined)
	}
	if strings.Contains(joined, "PostToolUse") {
		t.Fatalf("found hook leaked into the problem list:\n%s", joined)
	}
}

func TestHealthItemsColors(t *testing.T) {
	items := healthItems(sampleHealthReport())
	// not-loaded component → red.
	if items[0].color != colorRed {
		t.Fatalf("not-loaded color = %v, want colorRed", items[0].color)
	}
	// degraded component → orange.
	if items[1].color != colorOrange {
		t.Fatalf("degraded color = %v, want colorOrange", items[1].color)
	}
	// error advice → red.
	if items[2].color != colorRed {
		t.Fatalf("error advice color = %v, want colorRed", items[2].color)
	}
	// warn advice → orange.
	if items[3].color != colorOrange {
		t.Fatalf("warn advice color = %v, want colorOrange", items[3].color)
	}
	// info advice → cyan (colorMcp).
	if items[4].color != colorMcp {
		t.Fatalf("info advice color = %v, want colorMcp", items[4].color)
	}
	// missing hook → red.
	if items[5].color != colorRed {
		t.Fatalf("missing hook color = %v, want colorRed", items[5].color)
	}
	// indeterminate hook → orange.
	if items[6].color != colorOrange {
		t.Fatalf("indeterminate hook color = %v, want colorOrange", items[6].color)
	}
}

func TestHealthItemsEmpty(t *testing.T) {
	items := healthItems(HealthReport{})
	if len(items) != 0 {
		t.Fatalf("healthItems(empty) count = %d, want 0", len(items))
	}
}

// TestHealthItemsAllHealthyIsEmpty confirms a report where every component is
// loadable and every hook is found/unprobed yields zero problem rows.
func TestHealthItemsAllHealthyIsEmpty(t *testing.T) {
	r := HealthReport{
		Health: HealthSection{
			Components: []HealthComponent{
				{Kind: "agent", Name: "a", Status: "loadable"},
				{Kind: "skill", Name: "b", Status: "loadable"},
			},
		},
		Hooks: HooksHealthSection{
			Explanations: []HookExplanation{
				{Event: "PreToolUse", Status: "found"},
				{Event: "SessionStart", Status: "unprobed"},
			},
		},
	}
	if items := healthItems(r); len(items) != 0 {
		t.Fatalf("all-healthy healthItems count = %d, want 0", len(items))
	}
}

// ── Bilingual tests (the POINT of B2) ──────────────────────────────────────────

// TestHealthItemsBilingualStatusLabels asserts the row status tags translate:
// English rows carry the English status word; Chinese rows carry 未加载/降级 etc.
func TestHealthItemsBilingualStatusLabels(t *testing.T) {
	defer func() { uiLang = langEN }()

	uiLang = langEN
	en := healthItems(sampleHealthReport())
	if !strings.Contains(en[0].title, "not-loaded") {
		t.Fatalf("EN not-loaded row missing English status: %q", en[0].title)
	}
	if !strings.Contains(en[1].title, "degraded") {
		t.Fatalf("EN degraded row missing English status: %q", en[1].title)
	}

	uiLang = langZH
	zh := healthItems(sampleHealthReport())
	if !strings.Contains(zh[0].title, "未加载") {
		t.Fatalf("ZH not-loaded row missing 未加载: %q", zh[0].title)
	}
	if !strings.Contains(zh[1].title, "降级") {
		t.Fatalf("ZH degraded row missing 降级: %q", zh[1].title)
	}
	// Engine DATA (component name) stays English in BOTH languages.
	if !strings.Contains(zh[0].title, "broken-agent") {
		t.Fatalf("ZH row should keep the English component name: %q", zh[0].title)
	}
}

// TestHealthAdviceCardBilingual asserts the advice card uses titleZh/adviceZh/
// fixZh under langZH and FALLS BACK to the English fields when a zh string is
// empty (the custom info card). Under langEN it always uses the English fields.
func TestHealthAdviceCardBilingual(t *testing.T) {
	defer func() { uiLang = langEN }()

	// EN: warn advice (#3) uses the English title; detail uses English advice/fix.
	uiLang = langEN
	en := healthItems(sampleHealthReport())
	if !strings.Contains(en[3].title, "Tighten overbroad permissions") {
		t.Fatalf("EN advice row missing English title: %q", en[3].title)
	}
	enBody := en[3].detail(120)
	if !strings.Contains(enBody, "permissions.allow has wildcards") {
		t.Fatalf("EN advice detail missing English advice text:\n%s", enBody)
	}
	if !strings.Contains(enBody, "replace with specific rules") {
		t.Fatalf("EN advice detail missing English fix text:\n%s", enBody)
	}

	// ZH: same warn advice uses the zh title; detail uses zh advice/fix.
	uiLang = langZH
	zh := healthItems(sampleHealthReport())
	if !strings.Contains(zh[3].title, "收紧过宽权限") {
		t.Fatalf("ZH advice row missing zh title: %q", zh[3].title)
	}
	zhBody := zh[3].detail(120)
	if !strings.Contains(zhBody, "permissions.allow 含有通配符") {
		t.Fatalf("ZH advice detail missing zh advice text:\n%s", zhBody)
	}
	if !strings.Contains(zhBody, "替换为具体规则") {
		t.Fatalf("ZH advice detail missing zh fix text:\n%s", zhBody)
	}

	// ZH fallback: the custom info card (#5) has EMPTY zh fields → English title.
	if !strings.Contains(zh[4].title, "Custom advisory") {
		t.Fatalf("ZH custom-rule row should fall back to the English title: %q", zh[4].title)
	}
}

// TestHealthComponentDetailBilingual asserts the component detail pane translates
// its section/field labels (状态/原因) while keeping engine data (the reason
// message + path) English.
func TestHealthComponentDetailBilingual(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	items := healthItems(sampleHealthReport())
	body := items[0].detail(120) // the not-loaded component
	if !strings.Contains(body, "未加载") {
		t.Fatalf("ZH component detail missing translated status 未加载:\n%s", body)
	}
	if !strings.Contains(body, "原因") {
		t.Fatalf("ZH component detail missing translated Reasons label 原因:\n%s", body)
	}
	// Engine DATA: the reason message + path stay English.
	if !strings.Contains(body, "shadowed by a higher-tier agent") {
		t.Fatalf("ZH component detail should keep the English reason message:\n%s", body)
	}
	if !strings.Contains(body, "/cfg/agents/broken-agent.md") {
		t.Fatalf("ZH component detail should keep the English path:\n%s", body)
	}
}

// TestHealthHookDetailKeepsEnglishExplanation asserts the problem-hook detail
// translates its labels (事件/状态) but keeps the engine's English explanation
// sentence (the documented hook-sentence scope).
func TestHealthHookDetailKeepsEnglishExplanation(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	items := healthItems(sampleHealthReport())
	body := items[5].detail(120) // the missing hook
	if !strings.Contains(body, "事件") {
		t.Fatalf("ZH hook detail missing translated Event label 事件:\n%s", body)
	}
	if !strings.Contains(body, "缺失") {
		t.Fatalf("ZH hook detail missing translated missing status 缺失:\n%s", body)
	}
	// Engine DATA: the explanation sentence + event name stay English.
	if !strings.Contains(body, "runs the script") {
		t.Fatalf("ZH hook detail should keep the English explanation sentence:\n%s", body)
	}
	if !strings.Contains(body, "PreToolUse") {
		t.Fatalf("ZH hook detail should keep the English event name:\n%s", body)
	}
}

// ── Model-level: healthMsg delivery ───────────────────────────────────────────

func TestHealthMsgSetsListAndSummary(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectHealth(m, sampleHealthReport())

	st := m.sections[viewHealth]
	if st == nil {
		t.Fatal("sections[viewHealth] is nil after healthMsg")
	}
	if st.loading {
		t.Fatal("loading should be false after healthMsg")
	}
	if !st.loaded {
		t.Fatal("loaded should be true after healthMsg (Health lazy-loads)")
	}
	if len(st.list.items) != 7 {
		t.Fatalf("list items = %d, want 7", len(st.list.items))
	}
	// Summary: 1 not-loaded · 1 degraded · 3 advice.
	sum := st.summaryText()
	if !strings.Contains(sum, "1 not-loaded") {
		t.Fatalf("summary = %q, want to contain %q", sum, "1 not-loaded")
	}
	if !strings.Contains(sum, "1 degraded") {
		t.Fatalf("summary = %q, want to contain %q", sum, "1 degraded")
	}
	if !strings.Contains(sum, "3 advice") {
		t.Fatalf("summary = %q, want to contain %q", sum, "3 advice")
	}
}

func TestHealthMsgSummaryChinese(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH
	m := loadedModel(120, 30)
	m = injectHealth(m, sampleHealthReport())
	sum := m.sections[viewHealth].summaryText()
	if !strings.Contains(sum, "未加载") || !strings.Contains(sum, "降级") || !strings.Contains(sum, "建议") {
		t.Fatalf("ZH summary = %q, want 未加载/降级/建议", sum)
	}
}

func TestHealthErrorStateRendered(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(healthMsg{err: errFmt("health boom")})
	m = mm.(model)
	m = switchToHealth(m)
	if out := m.View(); !strings.Contains(out, "load failed") {
		t.Fatalf("health error state not rendered:\n%s", out)
	}
}

// ── View-level: switching to the Health tab ───────────────────────────────────

// switchToHealth cycles to the Health tab via "]" (it is the LAST tab, so
// int(viewHealth) presses from Inventory land on it — digit keys only reach the
// first ten tabs).
func switchToHealth(m model) model {
	for i := 0; i < int(viewHealth); i++ {
		mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]")})
		m = mm.(model)
	}
	return m
}

func TestSwitchToHealthViewReachableByCycle(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectHealth(m, sampleHealthReport())
	m = switchToHealth(m)
	if m.currentView != viewHealth {
		t.Fatalf("after %d ']' presses currentView = %v, want viewHealth", int(viewHealth), m.currentView)
	}
}

func TestSwitchToHealthViewContainsRowAndSummary(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langEN
	m := loadedModel(120, 30)
	m = injectHealth(m, sampleHealthReport())
	m = switchToHealth(m)
	out := m.View()
	// A problem row's engine data (component name) shows in the frame.
	if !strings.Contains(out, "broken-agent") {
		t.Fatalf("Health frame missing a problem row:\n%s", out)
	}
	// The summary bar shows the advice count.
	if !strings.Contains(out, "advice") {
		t.Fatalf("Health frame missing the summary:\n%s", out)
	}
}

// TestHealthViewChineseRendersChinese asserts the rendered Health frame under
// langZH carries Chinese guidance (the tab label + a translated status tag),
// while still carrying English engine data.
func TestHealthViewChineseRendersChinese(t *testing.T) {
	defer func() { uiLang = langEN }()
	m := loadedModel(120, 30)
	m.lang = langZH // View() syncs uiLang from m.lang each render
	m = injectHealth(m, sampleHealthReport())
	m = switchToHealth(m)
	out := m.View()
	if !strings.Contains(out, "健康") {
		t.Fatalf("ZH Health frame missing the 健康 tab label:\n%s", out)
	}
	if !strings.Contains(out, "未加载") {
		t.Fatalf("ZH Health frame missing the 未加载 status tag:\n%s", out)
	}
	// Engine data still English even in the ZH frame.
	if !strings.Contains(out, "broken-agent") {
		t.Fatalf("ZH Health frame should keep the English component name:\n%s", out)
	}
}

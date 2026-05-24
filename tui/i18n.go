package main

import "fmt"

// ── UI localization (Tier-1 chrome only) ────────────────────────────────────
//
// Translates the main interface chrome — tab bar, status bar, counts bar, splash,
// "coming soon" placeholders, empty states, and section summary bars — between
// English and Simplified Chinese. Detail-pane internals (section headers, field
// labels) and engine data (component names, paths, raw JSON) deliberately stay
// English. English is the source of truth and every English entry below is kept
// byte-identical to the former hardcoded string, so the default (English) UI — and
// the tests that assert on it — render exactly as before.

// language identifies the active UI language.
type language int

const (
	langEN language = iota
	langZH
)

// uiLang is the active UI language consulted by t/tf. It is a package var rather
// than a parameter threaded through every render function (that would touch dozens
// of signatures and their callers/tests): there is exactly ONE writer — View(),
// which syncs it from the model's lang each render — and many readers. It defaults
// to English so headless renders (--splash/--snapshot/--probe) and unit tests that
// call render helpers directly stay English.
var uiLang = langEN

// otherLang toggles between the two supported languages (the splash picker).
func otherLang(l language) language {
	if l == langEN {
		return langZH
	}
	return langEN
}

// translations maps a string KEY to its {English, 简体中文} text. The English entry
// is the source of truth (byte-identical to the former literal).
var translations = map[string][2]string{
	// Tab bar.
	"tab.inventory": {"Inventory", "清单"},
	"tab.conflicts": {"Conflicts", "冲突"},
	"tab.orphans":   {"Orphans", "孤儿文件"},
	"tab.config":    {"Config", "配置"},
	"tab.hooks":     {"Hooks", "钩子"},
	"tab.selftest":  {"Selftest", "自检"},

	// Status-bar hint words (the keys — Enter, j/k, Tab, 1-6, q — stay literal).
	"status.expand":  {"expand", "展开"},
	"status.move":    {"move", "移动"},
	"status.focus":   {"focus", "切换焦点"},
	"status.section": {"section", "切换标签"},
	"status.quit":    {"quit", "退出"},

	// Counts overview bar labels (looked up by the English plural label).
	"count.skills":       {"skills", "技能"},
	"count.agents":       {"agents", "智能体"},
	"count.commands":     {"commands", "命令"},
	"count.plugins":      {"plugins", "插件"},
	"count.marketplaces": {"marketplaces", "市场"},
	"count.mcp":          {"mcp", "mcp"},

	// Splash.
	"splash.tagline": {"agent harness configuration governance · read-only", "智能体框架配置治理 · 只读"},
	"splash.nav":     {"← → select · Enter enter", "← → 选择 · Enter 进入"},

	// "coming soon" placeholder tabs.
	"placeholder.comingSoon": {"coming soon", "即将推出"},

	// Empty states.
	"empty.selectObject":     {"select an object", "请在左侧选择一项"},
	"empty.selectObjectLeft": {"select an object on the left", "请在左侧选择一项"},
	"empty.selectItemLeft":   {"select an item on the left", "请在左侧选择一项"},
	"empty.conflicts":        {"no conflicts found", "未发现冲突"},
	"empty.orphans":          {"no orphans found", "未发现孤儿文件"},
	"empty.config":           {"no config keys found", "未发现配置项"},
	"empty.hooks":            {"no hooks found", "未发现钩子"},
	"empty.selftest":         {"no checks found", "未发现检查项"},
	"empty.items":            {"no items found", "未发现条目"},
	"empty.objects":          {"no objects found", "未发现对象"},

	// Transient loading / error / uninitialized states.
	"loading.inventory":     {"loading inventory…", "正在加载清单…"},
	"loading.generic":       {"loading…", "加载中…"},
	"loading.failed":        {"load failed", "加载失败"},
	"section.uninitialized": {"section not initialized", "分区未初始化"},

	// Section summary bars (format strings — counts are filled in by tf).
	"summary.conflicts":    {"%d conflicts", "%d 个冲突"},
	"summary.orphans":      {"%d hard · %d soft", "%d 严重 · %d 轻微"},
	"summary.config":       {"%d keys", "%d 个配置项"},
	"summary.hooks":        {"%d events", "%d 个事件"},
	"summary.selftestOk":   {"%d checks, all ok", "%d 项检查,全部通过"},
	"summary.selftestFail": {"%d checks, %d failing", "%d 项检查,%d 项失败"},
}

// tr returns key's text in the active UI language, falling back to English (then
// the key itself) when a translation is missing or empty. Named "tr" (not "t")
// because "t" is the universal *testing.T parameter name — a translate helper
// called "t" would be shadowed inside every test.
func tr(key string) string {
	pair, ok := translations[key]
	if !ok {
		return key
	}
	if s := pair[uiLang]; s != "" {
		return s
	}
	return pair[langEN]
}

// tf is tr followed by fmt.Sprintf, for translated format strings such as
// "%d conflicts" → "%d 个冲突".
func tf(key string, args ...any) string {
	return fmt.Sprintf(tr(key), args...)
}

// tabKeys maps a viewID to its tab-label translation key, in viewID iota order.
var tabKeys = []string{
	"tab.inventory", "tab.conflicts", "tab.orphans", "tab.config", "tab.hooks", "tab.selftest",
}

// tabLabel returns the translated tab label for v (empty string if out of range).
func tabLabel(v viewID) string {
	i := int(v)
	if i < 0 || i >= len(tabKeys) {
		return ""
	}
	return tr(tabKeys[i])
}

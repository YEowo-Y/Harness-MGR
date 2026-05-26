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
	"tab.inventory":   {"Inventory", "清单"},
	"tab.conflicts":   {"Conflicts", "冲突"},
	"tab.orphans":     {"Orphans", "孤儿文件"},
	"tab.config":      {"Config", "配置"},
	"tab.hooks":       {"Hooks", "钩子"},
	"tab.selftest":    {"Selftest", "自检"},
	"tab.doctor":      {"Doctor", "体检"},
	"tab.permissions": {"Permissions", "权限"},
	"tab.drift":       {"Drift", "偏移"},
	"tab.audit":       {"Audit", "审计"},

	// Status-bar hint words (the keys — Enter, j/k, Tab, 1-7, q — stay literal).
	"status.expand":  {"expand", "展开"},
	"status.move":    {"move", "移动"},
	"status.focus":   {"focus", "切换焦点"},
	"status.section": {"section", "切换标签"},
	"status.filter":  {"filter", "过滤"},
	"status.help":    {"help", "帮助"},
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
	"empty.doctor":           {"no checks found", "未发现检查项"},
	"empty.permissions":      {"no permission rules found", "未发现权限规则"},
	"empty.drift":            {"no drift changes", "无偏移变更"},
	"empty.audit":            {"no audit entries yet", "暂无审计记录"},
	"empty.items":            {"no items found", "未发现条目"},
	"empty.objects":          {"no objects found", "未发现对象"},
	"empty.noMatch":          {"no matches", "无匹配项"},

	// Transient loading / error / uninitialized states.
	"loading.inventory":     {"loading inventory…", "正在加载清单…"},
	"loading.generic":       {"loading…", "加载中…"},
	"loading.failed":        {"load failed", "加载失败"},
	"section.uninitialized": {"section not initialized", "分区未初始化"},

	// Help overlay (toggled with ?).
	"help.title":    {"Keyboard shortcuts", "键盘快捷键"},
	"help.move":     {"move cursor", "移动光标"},
	"help.activate": {"expand / select", "展开 / 选择"},
	"help.focus":    {"switch pane", "切换面板"},
	"help.jump":     {"jump to tab", "跳转到标签页"},
	"help.tabs":     {"prev / next tab", "上一个 / 下一个标签页"},
	"help.help":     {"toggle this help", "开关此帮助"},
	"help.dismiss":  {"? / Esc / q to close", "? / Esc / q 关闭"},
	"help.filter":   {"filter items", "过滤条目"},
	"help.refresh":  {"refresh this tab", "刷新本页"},

	// Filter bar (/).
	"filter.label": {"filter:", "过滤:"},
	"filter.apply": {"apply", "应用"},
	"filter.clear": {"clear", "清除"},
	"filter.edit":  {"edit", "编辑"},

	// Section summary bars (format strings — counts are filled in by tf).
	"summary.conflicts":    {"%d conflicts", "%d 个冲突"},
	"summary.orphans":      {"%d hard · %d soft", "%d 严重 · %d 轻微"},
	"summary.config":       {"%d keys", "%d 个配置项"},
	"summary.hooks":        {"%d events", "%d 个事件"},
	"summary.selftestOk":   {"%d checks, all ok", "%d 项检查,全部通过"},
	"summary.selftestFail": {"%d checks, %d failing", "%d 项检查,%d 项失败"},
	"summary.doctor":       {"%d checks · %d findings", "%d 项检查 · %d 处发现"},
	"summary.permissions":  {"%d allow · %d ask · %d deny · %d overbroad", "%d 允许 · %d 询问 · %d 拒绝 · %d 过宽"},

	// Confirm-gated write actions (Phase A).
	"write.confirmYes":  {"confirm", "确认"},
	"write.confirmNo":   {"cancel", "取消"},
	"write.running":     {"working…", "处理中…"},
	"write.failed":      {"write failed", "写入失败"},
	"write.drift.title": {"Update drift baseline?", "更新偏移基线?"},
	"write.drift.body":  {"Writes a fingerprint of your config to .mgr-state/lockfile.json so future drift checks have a baseline to compare against. Your Claude config is NOT modified — only the .mgr-state working file.", "将你配置的指纹写入 .mgr-state/lockfile.json,供日后偏移检测对比基线。不会修改你的 Claude 配置——只写 .mgr-state 工作文件。"},
	"write.drift.done":  {"drift baseline updated", "偏移基线已更新"},
	"write.drift.hint":  {"update", "更新"},
	"help.write":        {"run write action", "执行写入操作"},
	"help.writeMode":    {"toggle write mode", "开关写入模式"},

	"status.writesOn":    {"writes on", "写入开"},
	"status.writesOff":   {"writes off", "写入关"},
	"write.modeOn":       {"write mode enabled", "写入模式已开启"},
	"write.modeOff":      {"write mode disabled", "写入模式已关闭"},
	"write.disabledHint": {"writes disabled — press W to enable", "写入已关闭 — 按 W 开启"},

	"write.activeProbe.title":    {"Run active probes?", "运行主动探针?"},
	"write.activeProbe.body":     {"Runs the 3 active doctor checks: they spawn node/claude and write a transient probe file into ~/.claude/agents that is immediately removed. Nothing else is modified.", "运行 3 项主动体检:会启动 node/claude,并向 ~/.claude/agents 写入一个临时探针文件(随即删除)。不改动其它任何东西。"},
	"write.activeProbe.disabled": {"active probes need write mode — press W", "主动探针需要写入模式 — 按 W 开启"},
	"write.activeProbe.hint":     {"active probes", "主动探针"},
	"write.activeProbe.done":     {"active probes complete", "主动探针已完成"},
	"help.activeProbe":           {"run active doctor probes", "运行主动体检探针"},

	"summary.drifted":         {"%d added · %d modified · %d removed", "%d 新增 · %d 修改 · %d 删除"},
	"summary.driftClean":      {"clean · matches baseline", "无偏移 · 与基线一致"},
	"summary.driftNoBaseline": {"no baseline — run drift --update", "无基线 — 运行 drift --update"},
	"summary.audit":           {"%d entries", "%d 条记录"},
	"summary.auditSkipped":    {"%d entries · %d malformed", "%d 条记录 · %d 条损坏"},
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
	"tab.inventory", "tab.conflicts", "tab.orphans", "tab.config", "tab.hooks", "tab.selftest", "tab.doctor", "tab.permissions", "tab.drift", "tab.audit",
}

// tabLabel returns the translated tab label for v (empty string if out of range).
func tabLabel(v viewID) string {
	i := int(v)
	if i < 0 || i >= len(tabKeys) {
		return ""
	}
	return tr(tabKeys[i])
}

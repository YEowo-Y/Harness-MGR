package main

import "fmt"

// ── UI localization (Tier-1 chrome only) ────────────────────────────────────
//
// Translates the main interface chrome — tab bar, status bar, counts bar, splash,
// "coming soon" placeholders, empty states, section summary bars, AND the
// detail-pane section/field labels (the detail.* keys) — between English and
// Simplified Chinese. Only engine DATA (component/event/plugin names, file paths,
// raw JSON values, the engine's English explanation sentence) deliberately stays
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
	"tab.health":      {"Health", "健康"},

	// Status-bar hint words (the keys — Enter, j/k, Tab, 1-7, q — stay literal).
	"status.expand":  {"expand", "展开"},
	"status.move":    {"move", "移动"},
	"status.focus":   {"focus", "切换焦点"},
	"status.section": {"section", "切换标签"},
	"status.filter":  {"filter", "过滤"},
	"status.help":    {"help", "帮助"},
	"status.quit":    {"quit", "退出"},

	// Target switcher (T) — the codex badge shown in the status bar when the active
	// harness is codex (claude, the default, shows no badge). "codex" is an engine
	// identifier shown verbatim in both langs.
	"status.targetCodex": {"codex", "codex"},
	// Transient toast shown after the T switcher flips the active target (verbless →
	// looked up via tr). The harness name is an engine identifier kept verbatim.
	"status.switchedToClaude": {"switched to claude", "已切换到 claude"},
	"status.switchedToCodex":  {"switched to codex", "已切换到 codex"},

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
	"empty.health":           {"all healthy", "全部健康"},
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
	"help.health":   {"jump to Health", "跳转到健康"},
	"help.help":     {"toggle this help", "开关此帮助"},
	"help.dismiss":  {"? / Esc / q to close", "? / Esc / q 关闭"},
	"help.filter":   {"filter items", "过滤条目"},
	"help.refresh":  {"refresh this tab", "刷新本页"},
	"help.target":   {"switch target", "切换目标"},

	// Filter bar (/).
	"filter.label": {"filter:", "过滤:"},
	"filter.apply": {"apply", "应用"},
	"filter.clear": {"clear", "清除"},
	"filter.edit":  {"edit", "编辑"},

	// Section summary bars (format strings — counts are filled in by tf).
	"summary.conflicts":    {"%d conflicts", "%d 个冲突"},
	"summary.orphans":      {"%d hard · %d soft", "%d 严重 · %d 轻微"},
	"summary.config":       {"%d keys", "%d 个配置项"},
	"summary.hooks":        {"%d hooks · %d missing · %d indeterminate", "%d 个钩子 · %d 缺失 · %d 不确定"},
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
	// Codex is read-only in slice 1 — every write entry point (w/x/a/rollback) shows
	// this toast and no-ops under the codex target.
	"write.codexReadOnly": {"codex is read-only", "codex 为只读"},

	"write.activeProbe.title":    {"Run active probes?", "运行主动探针?"},
	"write.activeProbe.body":     {"Runs the 3 active doctor checks: they spawn node/claude and write a transient probe file into ~/.claude/agents that is immediately removed. Nothing else is modified.", "运行 3 项主动体检:会启动 node/claude,并向 ~/.claude/agents 写入一个临时探针文件(随即删除)。不改动其它任何东西。"},
	"write.activeProbe.disabled": {"active probes need write mode — press W", "主动探针需要写入模式 — 按 W 开启"},
	"write.activeProbe.hint":     {"active probes", "主动探针"},
	"write.activeProbe.done":     {"active probes complete", "主动探针已完成"},

	// Plugin enable/disable confirm-apply flow (Inventory tab). The plugin key and
	// the before→after diff fragments are engine DATA shown verbatim; only the
	// surrounding prose is translated.
	"write.plugin.enableTitle":    {"Enable plugin?", "启用插件?"},
	"write.plugin.disableTitle":   {"Disable plugin?", "停用插件?"},
	"write.plugin.willEnable":     {"Will ENABLE plugin «%s» — writes settings.json enabledPlugins.", "将【启用】插件「%s」—— 写入 settings.json 的 enabledPlugins。"},
	"write.plugin.willDisable":    {"Will DISABLE plugin «%s» — writes settings.json enabledPlugins.", "将【停用】插件「%s」—— 写入 settings.json 的 enabledPlugins。"},
	"write.plugin.change":         {"Change in %s (line %d):", "改动(%s 第 %d 行):"},
	"write.plugin.reversible":     {"An auto-snapshot is taken first, so rollback can undo it. Restart Claude Code for it to take effect.", "落盘前会自动快照,可用 rollback 撤销。改动需重启 Claude Code 生效。"},
	"write.plugin.overrideCaveat": {"Note: settings.local.json also sets this plugin and takes precedence — the effective state may not change.", "注意:settings.local.json 也设置了该插件且优先级更高 —— 实际生效状态可能不变。"},
	"write.plugin.done":           {"plugin updated — restart Claude Code", "插件已更新 —— 重启 Claude Code 生效"},
	"write.plugin.hint":           {"toggle plugin", "切换插件"},
	"write.plugin.selectHint":     {"select a plugin row, then press w to toggle it", "请先选中一个插件行,再按 w 切换启用/停用"},

	// Per-skill visibility confirm-apply flow (Inventory tab, Claude-only). The
	// skill name, the chosen state (an engine enum value), and the before→after diff
	// fragments are engine DATA shown verbatim; only the surrounding prose is
	// translated. The state strings ("on"/"name-only"/…) stay English everywhere.
	"write.skillVis.title":      {"Set skill visibility", "设置技能可见性"},
	"write.skillVis.pickHint":   {"↑/↓ choose · enter confirm · esc cancel", "↑/↓ 选择 · enter 确认 · esc 取消"},
	"write.skillVis.setTitle":   {"Set skill visibility", "设置技能可见性"},
	"write.skillVis.willSet":    {"Set %s visibility to %s", "将技能 %s 的可见性设为 %s"},
	"write.skillVis.reversible": {"Writes settings.json. Reversible — an auto-snapshot is taken first.", "将写入 settings.json。可回滚 —— 写入前会自动快照。"},
	"write.skillVis.already":    {"%s is already %s", "技能 %s 已是 %s"},
	"write.skillVis.done":       {"visibility updated", "可见性已更新"},
	"write.skillVis.hint":       {"press w to set visibility", "按 w 设置可见性"},

	// Component delete / remove confirm-apply flow (Inventory tab, skill/agent/command).
	// The component name and the engine-resolved target path are engine DATA shown
	// verbatim; only the surrounding prose is translated. The modal renders in danger
	// red (a destructive delete); only willDelete carries a format verb (%s).
	"write.remove.title":      {"Delete component", "删除组件"},
	"write.remove.willDelete": {"Permanently delete «%s»?", "永久删除「%s」?"},
	"write.remove.pathLabel":  {"Will delete:", "将删除:"},
	"write.remove.folderWarn": {"This is a skill — the entire folder is removed.", "这是一个 skill —— 会删除整个文件夹。"},
	"write.remove.reversible": {"Reversible — an auto-snapshot is taken first, so a rollback can undo it.", "可回滚 —— 会先自动快照,之后可用 rollback 撤销。"},
	"write.remove.done":       {"component removed", "已删除组件"},
	"write.remove.hint":       {"delete", "删除"},
	"write.remove.selectHint": {"select a skill, agent, or command row, then press x to delete it", "请先选中一个 skill / agent / command 行,再按 x 删除"},

	// Snapshot rollback confirm-apply flow (Snapshots tab). The reason/id are engine
	// DATA shown verbatim; only the surrounding prose is translated. A drifted
	// rollback leads with driftWarn and the modal turns red.
	"write.rollback.title":        {"Roll back to this snapshot?", "回滚到该快照?"},
	"write.rollback.body":         {"Will restore your config to snapshot «%s» (about %d files).", "将把配置恢复到快照「%s」的状态(约 %d 个文件)。"},
	"write.rollback.driftWarn":    {"⚠ Your live config has CHANGED since this snapshot. Rolling back will OVERWRITE those changes.", "⚠ 自该快照拍摄后,实时配置已发生变化。回滚会用快照【覆盖】这些变化。"},
	"write.rollback.autoSnapshot": {"A snapshot of your CURRENT state is taken first, so this rollback can itself be undone.", "回滚前会先给【当前状态】自动拍一张快照,所以这次回滚也能再撤销。"},
	"write.rollback.restart":      {"Restart Claude Code after the rollback for it to take effect.", "回滚后需重启 Claude Code 生效。"},
	"write.rollback.done":         {"rolled back — restart Claude Code", "已回滚 —— 重启 Claude Code 生效"},
	"write.rollback.hint":         {"roll back", "回滚"},
	"write.rollback.selectHint":   {"select a snapshot row, then press w to roll back", "请先选中一个快照行,再按 w 回滚"},
	"help.activeProbe":            {"run active doctor probes", "运行主动体检探针"},

	"summary.drifted":         {"%d added · %d modified · %d removed", "%d 新增 · %d 修改 · %d 删除"},
	"summary.driftClean":      {"clean · matches baseline", "无偏移 · 与基线一致"},
	"summary.driftNoBaseline": {"no baseline — run drift --update", "无基线 — 运行 drift --update"},
	"summary.audit":           {"%d entries", "%d 条记录"},
	"summary.auditSkipped":    {"%d entries · %d malformed", "%d 条记录 · %d 条损坏"},

	// Health tab — the FIRST detail-pane content to go bilingual (B2). The
	// GUIDANCE/MEANING (status & severity labels, summary, detail-pane section
	// labels) is translated; engine DATA (component names, paths, hook command
	// strings, event names, codes, reason messages, the engine's explanation
	// sentence) stays English — see the bilingual design note in tabs.go.
	"summary.health": {"%d not-loaded · %d degraded · %d advice", "%d 未加载 · %d 降级 · %d 建议"},

	// Component load-status labels.
	"health.loadable":  {"loadable", "可加载"},
	"health.degraded":  {"degraded", "降级"},
	"health.notLoaded": {"not-loaded", "未加载"},

	// Reason / advice severity labels.
	"sev.error": {"error", "错误"},
	"sev.warn":  {"warn", "警告"},
	"sev.info":  {"info", "提示"},

	// Hook resolution-status labels.
	"hookstatus.found":         {"found", "存在"},
	"hookstatus.missing":       {"missing", "缺失"},
	"hookstatus.indeterminate": {"indeterminate", "不确定"},
	"hookstatus.unprobed":      {"unprobed", "未探测"},

	// Hook kind labels.
	"hookkind.file":     {"file", "文件"},
	"hookkind.external": {"external", "外部命令"},
	"hookkind.opaque":   {"opaque", "未解析"},

	// Health detail-pane section / field labels.
	"detail.status":     {"Status", "状态"},
	"detail.reasons":    {"Reasons", "原因"},
	"detail.advice":     {"Advice", "建议"},
	"detail.fix":        {"Fix", "修复"},
	"detail.hook":       {"Hook", "钩子"},
	"detail.kind":       {"Kind", "类型"},
	"detail.scope":      {"Scope", "范围"},
	"detail.path":       {"Path", "路径"},
	"detail.event":      {"Event", "事件"},
	"detail.matcher":    {"Matcher", "匹配器"},
	"detail.severity":   {"Severity", "严重度"},
	"detail.message":    {"Message", "消息"},
	"detail.docs":       {"Docs", "文档"},
	"health.allHealthy": {"all components loadable", "全部组件均可加载"},
	"health.hooksOk":    {"all hooks resolved", "全部钩子均已解析"},

	// Dispositions tab — same bilingual principle as Health: chrome/guidance translated,
	// engine data (kind, key, paths, ruleId, suggestion sentences) stays English.
	"tab.dispositions":            {"Dispositions", "处置建议"},
	"empty.dispositions":          {"no dispositions", "无处置建议"},
	"summary.dispositions":        {"%d clusters · %d removable · %d advisory", "%d 簇 · %d 可删除 · %d 建议性"},
	"disposition.shadowedCount":   {"shadowed", "被遮蔽"},
	"disposition.winner":          {"Winner", "胜者"},
	"disposition.shadowed":        {"Shadowed", "被遮蔽组件"},
	"disposition.none":            {"none", "无"},
	"disposition.action":          {"Action", "操作"},
	"disposition.pluginAdvisory":  {"disable or uninstall the plugin to resolve", "禁用或卸载插件以解决"},
	"disposition.suggestionLabel": {"Suggestion", "建议操作"},
	"disposition.reference":       {"Reference", "参考"},
	"disposition.rule":            {"Rule", "规则"},
	"detail.tier":                 {"Tier", "层级"},
	"detail.plugin":               {"Plugin", "插件"},
	"help.dispositions":           {"jump to Dispositions", "跳转到处置建议"},

	// Snapshots tab — same bilingual principle as Dispositions: chrome/guidance
	// translated, engine data (id, createdAt, reason) stays English.
	"tab.snapshots":      {"Snapshots", "快照"},
	"empty.snapshots":    {"no snapshots", "无快照"},
	"summary.snapshots":  {"%d snapshots", "%d 个快照"},
	"help.snapshots":     {"jump to Snapshots", "跳转到快照"},
	"detail.id":          {"Id", "标识"},
	"detail.createdAt":   {"Created at", "创建时间"},
	"detail.fileCount":   {"File count", "文件数"},
	"detail.pinned":      {"Pinned", "已固定"},
	"snapshot.pinnedYes": {"yes", "是"},
	"snapshot.pinnedNo":  {"no", "否"},

	// Detail-pane section / field labels for the remaining tabs (Inventory,
	// Conflicts, Orphans, Config, Selftest, Doctor, Permissions, Drift, Audit).
	// CHROME — translated; engine DATA (names, paths, raw values) stays English.
	// Each English entry is byte-identical to the former hardcoded literal.
	"detail.classification":     {"Classification", "分类"},
	"detail.confidence":         {"Confidence", "置信度"},
	"detail.resolution":         {"Resolution", "解析"},
	"detail.likelyWinner":       {"Likely winner", "可能胜者"},
	"detail.winnerPath":         {"Winner path", "胜者路径"},
	"detail.possibleWinners":    {"Possible winners", "可能的胜者"},
	"detail.explanation":        {"Explanation", "说明"},
	"detail.reason":             {"Reason", "原因"},
	"detail.category":           {"Category", "类别"},
	"detail.entryType":          {"Entry type", "条目类型"},
	"detail.container":          {"Container", "容器"},
	"detail.location":           {"Location", "位置"},
	"detail.merge":              {"Merge", "合并"},
	"detail.mergeConfidence":    {"Merge confidence", "合并置信度"},
	"detail.strategy":           {"Strategy", "策略"},
	"detail.layers":             {"Layers", "层"},
	"detail.layer":              {"Layer", "层"},
	"detail.result":             {"Result", "结果"},
	"detail.probeLevel":         {"Probe level", "探测级别"},
	"detail.findings":           {"Findings", "发现"},
	"detail.permission":         {"Permission", "权限"},
	"detail.overbroad":          {"Overbroad", "过宽"},
	"detail.why":                {"Why", "原因"},
	"detail.change":             {"Change", "变更"},
	"detail.fields":             {"Fields", "字段"},
	"detail.provenance":         {"Provenance", "出处"},
	"detail.source":             {"Source", "来源"},
	"detail.about":              {"About", "关于"},
	"detail.identity":           {"Identity", "标识"},
	"detail.key":                {"Key", "键"},
	"detail.enabled":            {"Enabled", "已启用"},
	"detail.cachePresent":       {"Cache present", "缓存存在"},
	"detail.repository":         {"Repository", "仓库"},
	"detail.sourceRepo":         {"Source repo", "源仓库"},
	"detail.local":              {"Local", "本地"},
	"detail.onDisk":             {"On disk", "磁盘上"},
	"detail.installLocation":    {"Install location", "安装位置"},
	"detail.connection":         {"Connection", "连接"},
	"detail.transport":          {"Transport", "传输"},
	"detail.invocation":         {"Invocation", "调用"},
	"detail.command":            {"Command", "命令"},
	"detail.args":               {"Args", "参数"},
	"detail.version":            {"Version", "版本"},
	"detail.marketplace":        {"Marketplace", "市场"},
	"detail.description":        {"Description", "描述"},
	"detail.activeProbeSkipped": {"active probe skipped in passive run", "被动运行中跳过主动探针"},
	"detail.noFindings":         {"passed — no findings", "通过 — 无发现"},
	"detail.emptyEntry":         {"empty entry", "空记录"},
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
	"tab.inventory", "tab.conflicts", "tab.orphans", "tab.config", "tab.hooks",
	"tab.selftest", "tab.doctor", "tab.permissions", "tab.drift", "tab.audit",
	"tab.health", "tab.dispositions", "tab.snapshots",
}

// tabLabel returns the translated tab label for v (empty string if out of range).
func tabLabel(v viewID) string {
	i := int(v)
	if i < 0 || i >= len(tabKeys) {
		return ""
	}
	return tr(tabKeys[i])
}

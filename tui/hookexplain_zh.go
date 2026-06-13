package main

import (
	"fmt"
	"strings"
)

// hookEventPhrasesZh maps each hook event name to a Chinese phrase describing
// when it fires. Grounded in the same official hooks docs as the JS engine's
// HOOK_EVENT_PHRASES (src/analysis/hook-explain.mjs). Unknown events fall back
// to "该事件触发时" — never dropped.
var hookEventPhrasesZh = map[string]string{
	"SessionStart":        "会话开始或恢复时",
	"Setup":               "Claude Code 运行初始化或维护(--init/--maintenance)时",
	"UserPromptSubmit":    "提交提示词后、Claude 处理之前",
	"UserPromptExpansion": "输入的命令展开为提示词时",
	"PreToolUse":          "工具调用运行前",
	"PermissionRequest":   "出现权限对话框时",
	"PermissionDenied":    "工具调用被自动拒绝时",
	"PostToolUse":         "工具调用完成后",
	"PostToolUseFailure":  "工具调用失败后",
	"PostToolBatch":       "一批并行工具调用全部完成后",
	"Notification":        "Claude Code 发送通知时",
	"MessageDisplay":      "正在显示助手消息文本时",
	"SubagentStart":       "子智能体被启动时",
	"SubagentStop":        "子智能体结束时",
	"TaskCreated":         "任务被创建时",
	"TaskCompleted":       "任务被标记完成时",
	"Stop":                "Claude 完成回复时",
	"StopFailure":         "因 API 错误结束本轮时",
	"TeammateIdle":        "团队伙伴即将进入空闲时",
	"InstructionsLoaded":  "CLAUDE.md 或规则文件被加载进上下文时",
	"ConfigChange":        "会话期间配置文件发生变化时",
	"CwdChanged":          "工作目录改变时",
	"FileChanged":         "被监视的文件在磁盘上变化时",
	"WorktreeCreate":      "正在创建工作树时",
	"WorktreeRemove":      "正在移除工作树时",
	"PreCompact":          "上下文压缩前",
	"PostCompact":         "上下文压缩完成后",
	"Elicitation":         "MCP 服务器请求用户输入时",
	"ElicitationResult":   "用户响应 MCP 询问后",
	"SessionEnd":          "会话结束时",
}

// hookToolMatcherEvents is the set of events whose matcher matches tool names
// (mirrors TOOL_MATCHER_EVENTS in src/analysis/hook-explain.mjs).
var hookToolMatcherEvents = map[string]bool{
	"PreToolUse":         true,
	"PostToolUse":        true,
	"PostToolUseFailure": true,
	"PermissionRequest":  true,
	"PermissionDenied":   true,
}

// hookEventPhraseZh returns the Chinese phrase for an event, or the generic
// fallback. Never panics on unknown/empty input.
func hookEventPhraseZh(event string) string {
	if p, ok := hookEventPhrasesZh[event]; ok {
		return p
	}
	return "该事件触发时"
}

// hookMatcherClauseZh returns the Chinese matcher clause (with trailing comma
// and space when non-empty). Mirrors matcherClause() in the JS engine.
func hookMatcherClauseZh(event, matcher string) string {
	isTool := hookToolMatcherEvents[event]
	m := strings.TrimSpace(matcher)
	if m == "" || m == "*" {
		if isTool {
			return "对所有工具调用,"
		}
		return ""
	}
	if isTool {
		return fmt.Sprintf("对匹配 \"%s\" 的工具,", matcher)
	}
	return fmt.Sprintf("匹配 \"%s\" 时,", matcher)
}

// hookStatusTextZh returns the Chinese status text for a hook entry. The
// 'missing' cause is kind-dependent (mirrors statusText() in the JS engine).
// Never panics on unknown input.
func hookStatusTextZh(status, kind string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "missing":
		if strings.ToLower(strings.TrimSpace(kind)) == "file" {
			return "缺失 — 文件未找到"
		}
		return "缺失 — PATH 中未找到"
	case "found":
		return "存在"
	case "indeterminate":
		return "不确定 — 含未展开的运行时变量"
	case "unprobed":
		return "未探测 — 本次运行未解析"
	default:
		return status
	}
}

// hookExplainKindLabelZh returns the Chinese kind label directly, without going
// through tr() so it is independent of the global uiLang state.
func hookExplainKindLabelZh(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "file":
		return "文件"
	case "external":
		return "外部命令"
	case "opaque":
		return "未解析"
	default:
		return kind
	}
}

// hookExplainSentenceZh composes a Chinese explanation sentence for one hook
// entry. It is the zh-mode counterpart of buildExplanation() in the JS engine.
//
// Sentence patterns:
//
//	opaque: 在 Event(phrase),matcherClause 运行命令 "target"(无法解析命令形式,statusZh)。
//	file:   在 Event(phrase),matcherClause 运行脚本 "target"(kindLabel,statusZh)。
//	other:  在 Event(phrase),matcherClause 运行外部命令 "target"(kindLabel,statusZh)。
//
// Embedded engine DATA (Event key, matcher value, target path) stays English.
// Kind/status labels are translated via hookExplainKindLabel / hookStatusTextZh.
// Never panics on empty or unknown fields.
func hookExplainSentenceZh(h HookExplanation) string {
	matcherPart := hookMatcherClauseZh(h.Event, h.Matcher)

	var head string
	if matcherPart != "" {
		head = fmt.Sprintf("在 %s(%s),%s", h.Event, hookEventPhraseZh(h.Event), matcherPart)
	} else {
		head = fmt.Sprintf("在 %s(%s),", h.Event, hookEventPhraseZh(h.Event))
	}

	st := hookStatusTextZh(h.Status, h.Kind)

	if strings.ToLower(strings.TrimSpace(h.Kind)) == "opaque" {
		return fmt.Sprintf("%s运行命令 \"%s\"(无法解析命令形式,%s)。", head, h.Target, st)
	}

	kindLabel := hookExplainKindLabelZh(h.Kind)
	var action string
	if strings.ToLower(strings.TrimSpace(h.Kind)) == "file" {
		action = fmt.Sprintf("运行脚本 \"%s\"", h.Target)
	} else {
		action = fmt.Sprintf("运行外部命令 \"%s\"", h.Target)
	}
	return fmt.Sprintf("%s%s(%s,%s)。", head, action, kindLabel, st)
}

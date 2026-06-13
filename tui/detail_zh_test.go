package main

import (
	"strings"
	"testing"
)

// TestDetailLabelsRenderChineseInZhMode is the falsifiable oracle for the
// detail-pane label localization: in zh mode the section/field labels render in
// Chinese, while engine DATA (keys, commands, paths) stays English. Reverting any
// label to its English literal (or dropping its i18n entry) turns an assertion red.
func TestDetailLabelsRenderChineseInZhMode(t *testing.T) {
	defer func() { uiLang = langEN }()
	uiLang = langZH

	// Conflicts detail — unconditional labels: 分类/类型/解析/说明.
	c := ConflictCluster{Kind: "skill", Key: "seo", Confidence: "likely", Reason: "because", Fix: "do x"}
	cb := conflictDetail(c, 120)
	for _, want := range []string{"分类", "类型", "解析", "说明"} {
		if !strings.Contains(cb, want) {
			t.Errorf("conflictDetail (zh) missing %q:\n%s", want, cb)
		}
	}
	if !strings.Contains(cb, "seo") { // engine data stays English
		t.Errorf("conflictDetail (zh) should keep the English key 'seo':\n%s", cb)
	}

	// Config detail — unconditional labels: 合并/策略.
	ck := ConfigKey{Key: "model", MergeConfidence: "known", Strategy: "highest"}
	cfb := configDetail(ck, 120)
	for _, want := range []string{"合并", "策略"} {
		if !strings.Contains(cfb, want) {
			t.Errorf("configDetail (zh) missing %q:\n%s", want, cfb)
		}
	}

	// MCP detail — unconditional labels: 连接/传输/调用/命令.
	ms := McpServer{Name: "ctx7", Transport: "stdio", Scope: "user", Command: "npx", Args: []string{"-y", "pkg"}}
	mb := mcpDetail(ms, accent, 120)
	for _, want := range []string{"连接", "传输", "调用", "命令"} {
		if !strings.Contains(mb, want) {
			t.Errorf("mcpDetail (zh) missing %q:\n%s", want, mb)
		}
	}
	if !strings.Contains(mb, "npx") { // engine data stays English
		t.Errorf("mcpDetail (zh) should keep the English command 'npx':\n%s", mb)
	}
}

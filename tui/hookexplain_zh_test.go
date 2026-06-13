package main

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

// TestHookExplainZhDriftGuard verifies that hookEventPhrasesZh covers every
// event in the JS engine's HOOK_EVENT_PHRASES map. It reads the Node source
// file and extracts the event keys; if the file is unreadable the test is
// skipped gracefully (CI without the Node tree, or path changes).
func TestHookExplainZhDriftGuard(t *testing.T) {
	const jsFile = "../src/analysis/hook-explain.mjs"
	f, err := os.Open(jsFile)
	if err != nil {
		t.Skipf("drift-guard: cannot open %s (%v) — skipping", jsFile, err)
	}
	defer f.Close()

	// Extract keys from the HOOK_EVENT_PHRASES = Object.freeze({ block.
	var inBlock bool
	var engineEvents []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "export const HOOK_EVENT_PHRASES = Object.freeze({") {
			inBlock = true
			continue
		}
		if inBlock {
			if strings.HasPrefix(trimmed, "})") {
				break
			}
			// Lines look like:  SessionStart: 'when …',
			colonIdx := strings.Index(trimmed, ":")
			if colonIdx <= 0 {
				continue
			}
			key := strings.TrimSpace(trimmed[:colonIdx])
			if key == "" || strings.HasPrefix(key, "//") {
				continue
			}
			engineEvents = append(engineEvents, key)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("drift-guard: scanner error: %v", err)
	}
	if len(engineEvents) == 0 {
		t.Skip("drift-guard: no events extracted — JS file format may have changed")
	}

	for _, ev := range engineEvents {
		if _, ok := hookEventPhrasesZh[ev]; !ok {
			t.Errorf("hookEventPhrasesZh is missing engine event %q — add a Chinese phrase", ev)
		}
	}
	t.Logf("drift-guard: checked %d engine events against hookEventPhrasesZh", len(engineEvents))
}

// TestHookExplainSentenceZhGoldens verifies the composed Chinese sentences for
// representative inputs. Embedded engine DATA (event key, matcher, target path)
// must appear verbatim in the output; Chinese prose must wrap them.
func TestHookExplainSentenceZhGoldens(t *testing.T) {
	cases := []struct {
		name string
		h    HookExplanation
		want string
	}{
		{
			name: "PostToolUse all-tools file found",
			h: HookExplanation{
				Event:   "PostToolUse",
				Matcher: "",
				Kind:    "file",
				Target:  "/h/post.mjs",
				Status:  "found",
			},
			want: "在 PostToolUse（工具调用完成后），对所有工具调用，运行脚本“/h/post.mjs”（文件，存在）。",
		},
		{
			name: "PreToolUse Bash-matcher file found",
			h: HookExplanation{
				Event:   "PreToolUse",
				Matcher: "Bash",
				Kind:    "file",
				Target:  "/h/pre.mjs",
				Status:  "found",
			},
			want: "在 PreToolUse（工具调用运行前），对匹配“Bash”的工具，运行脚本“/h/pre.mjs”（文件，存在）。",
		},
		{
			name: "file missing — file not found",
			h: HookExplanation{
				Event:   "PreToolUse",
				Matcher: "",
				Kind:    "file",
				Target:  "/missing.mjs",
				Status:  "missing",
			},
			// Check key substrings separately below; also verify the full string.
			want: "在 PreToolUse（工具调用运行前），对所有工具调用，运行脚本“/missing.mjs”（文件，缺失：文件未找到）。",
		},
		{
			name: "Stop external found (no matcher clause)",
			h: HookExplanation{
				Event:   "Stop",
				Matcher: "",
				Kind:    "external",
				Target:  "any-buddy",
				Status:  "found",
			},
			want: "在 Stop（Claude 完成回复时），运行外部命令“any-buddy”（外部命令，存在）。",
		},
		{
			name: "opaque unprobed",
			h: HookExplanation{
				Event:   "PreToolUse",
				Matcher: "",
				Kind:    "opaque",
				Target:  "weird | cmd",
				Status:  "unprobed",
			},
			want: "在 PreToolUse（工具调用运行前），对所有工具调用，运行命令“weird | cmd”（无法解析命令形式，未探测：本次运行未解析）。",
		},
		{
			name: "unknown event fallback",
			h: HookExplanation{
				Event:   "MadeUpEvent",
				Matcher: "",
				Kind:    "external",
				Target:  "some-cmd",
				Status:  "found",
			},
			want: "在 MadeUpEvent（该事件触发时），运行外部命令“some-cmd”（外部命令，存在）。",
		},
		{
			name: "SessionStart no matcher no tool clause",
			h: HookExplanation{
				Event:   "SessionStart",
				Matcher: "",
				Kind:    "file",
				Target:  "/s/start.mjs",
				Status:  "found",
			},
			want: "在 SessionStart（会话开始或恢复时），运行脚本“/s/start.mjs”（文件，存在）。",
		},
		{
			name: "indeterminate status",
			h: HookExplanation{
				Event:   "PostToolUse",
				Matcher: "*",
				Kind:    "file",
				Target:  "/h/indeterminate.mjs",
				Status:  "indeterminate",
			},
			want: "在 PostToolUse（工具调用完成后），对所有工具调用，运行脚本“/h/indeterminate.mjs”（文件，不确定：含未展开的运行时变量）。",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := hookExplainSentenceZh(tc.h)
			if got != tc.want {
				t.Errorf("\ngot:  %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// TestHookExplainSentenceZhEngineDataEnglish verifies that embedded engine DATA
// (event key, matcher value, target path) appears verbatim (English) inside the
// Chinese sentence — these are not translated.
func TestHookExplainSentenceZhEngineDataEnglish(t *testing.T) {
	h := HookExplanation{
		Event:   "PostToolUse",
		Matcher: "Bash",
		Kind:    "file",
		Target:  "/hooks/my-hook.mjs",
		Status:  "found",
	}
	got := hookExplainSentenceZh(h)

	// Engine data must appear verbatim.
	for _, token := range []string{"PostToolUse", "Bash", "/hooks/my-hook.mjs"} {
		if !strings.Contains(got, token) {
			t.Errorf("expected engine data %q to appear verbatim in zh sentence, got: %s", token, got)
		}
	}

	// Must be Chinese prose (contains at least one CJK character).
	hasCJK := false
	for _, r := range got {
		if r >= 0x4E00 && r <= 0x9FFF {
			hasCJK = true
			break
		}
	}
	if !hasCJK {
		t.Errorf("expected Chinese prose in zh sentence, got: %s", got)
	}
}

// TestHookExplainDetailZhWiring verifies that hookExplainDetail uses the zh
// sentence in zh mode and keeps the engine's English sentence in en mode.
func TestHookExplainDetailZhWiring(t *testing.T) {
	h := HookExplanation{
		Event:       "PostToolUse",
		Matcher:     "",
		Kind:        "file",
		Target:      "/h/post.mjs",
		Status:      "found",
		Explanation: `On PostToolUse (after a tool call completes), for all tool calls, runs the script "/h/post.mjs" (file, found).`,
	}

	// zh mode: output must contain Chinese prose.
	origLang := uiLang
	defer func() { uiLang = origLang }()

	uiLang = langZH
	zhOut := hookExplainDetail(h, 120)
	if !strings.Contains(zhOut, "运行脚本") {
		t.Errorf("zh mode: expected zh sentence containing '运行脚本', got:\n%s", zhOut)
	}
	// Engine data stays English.
	if !strings.Contains(zhOut, "/h/post.mjs") {
		t.Errorf("zh mode: expected target path '/h/post.mjs' verbatim in zh output, got:\n%s", zhOut)
	}

	// en mode: output must contain the engine's English sentence verbatim.
	uiLang = langEN
	enOut := hookExplainDetail(h, 120)
	if !strings.Contains(enOut, "runs the script") {
		t.Errorf("en mode: expected engine English sentence, got:\n%s", enOut)
	}
	// Must NOT contain zh prose in en mode.
	if strings.Contains(enOut, "运行脚本") {
		t.Errorf("en mode: must not contain zh prose, got:\n%s", enOut)
	}
}

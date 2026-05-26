package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
)

// ── TUI preferences (the front-end's OWN config, NOT the governed harness) ──
//
// claude-mgr is a read-only governance tool for ~/.claude and must NEVER write
// there. This file persists only the TUI's own UI preferences — currently the
// chosen language and the opt-in write-mode flag — under the user's OS config
// dir, so choices are remembered across launches. Every write is best-effort: a
// preference is not worth failing a launch over, so all errors are swallowed and
// the defaults (English, writes off) are used.

// uiConfig is the persisted TUI preference document.
type uiConfig struct {
	Language      string `json:"language"`      // "en" | "zh"
	WritesEnabled bool   `json:"writesEnabled"` // TUI write actions opt-in; default false (off)
}

// lang maps the persisted language code to the language enum (English default).
func (c uiConfig) lang() language {
	if c.Language == "zh" {
		return langZH
	}
	return langEN
}

// langCode maps a language enum to its persisted code. Inverse of uiConfig.lang().
func langCode(l language) string {
	if l == langZH {
		return "zh"
	}
	return "en"
}

// uiConfigPath returns the TUI preference-file path under the user's OS config
// dir (e.g. %AppData%\claude-mgr\ui.json on Windows), or "" if it can't be
// resolved (in which case prefs simply aren't persisted).
func uiConfigPath() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "claude-mgr", "ui.json")
}

// loadConfig reads the persisted TUI preferences, defaulting to the zero config
// (English, writes off) on any missing file, read error, or parse error.
func loadConfig() uiConfig { return loadConfigFrom(uiConfigPath()) }

// loadConfigFrom is loadConfig with an explicit path (a testable seam).
func loadConfigFrom(path string) uiConfig {
	if path == "" {
		return uiConfig{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return uiConfig{}
	}
	var c uiConfig
	if json.Unmarshal(data, &c) != nil {
		return uiConfig{}
	}
	return c
}

// saveConfigTo writes the whole preference doc to path (best-effort; all errors
// ignored). Writing the WHOLE doc — not one field — is what prevents saving one
// preference from clobbering the other.
func saveConfigTo(path string, c uiConfig) {
	if path == "" {
		return
	}
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	// Atomic write: temp file then rename, so a crash mid-write can't leave a
	// partially-written (corrupt) config behind.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

// saveConfigCmd persists the whole preference doc as a tea.Cmd, so the write runs
// off the Update path — and unit tests, which don't execute returned Cmds, never
// touch the filesystem. It produces no message.
func saveConfigCmd(c uiConfig) tea.Cmd {
	return func() tea.Msg {
		saveConfigTo(uiConfigPath(), c)
		return nil
	}
}

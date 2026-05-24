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
// chosen language — under the user's OS config dir, so the choice is remembered
// across launches. Every write is best-effort: a preference is not worth failing
// a launch over, so all errors are swallowed and the default (English) is used.

// uiConfig is the persisted TUI preference document.
type uiConfig struct {
	Language string `json:"language"` // "en" | "zh"
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

// loadLang reads the persisted UI language, defaulting to English on any missing
// file, read error, or unrecognized value.
func loadLang() language { return loadLangFrom(uiConfigPath()) }

// loadLangFrom is loadLang with an explicit path (a testable seam).
func loadLangFrom(path string) language {
	if path == "" {
		return langEN
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return langEN
	}
	var c uiConfig
	if json.Unmarshal(data, &c) != nil {
		return langEN
	}
	if c.Language == "zh" {
		return langZH
	}
	return langEN
}

// saveLangTo writes the chosen language to path (best-effort; all errors ignored).
func saveLangTo(path string, lang language) {
	if path == "" {
		return
	}
	code := "en"
	if lang == langZH {
		code = "zh"
	}
	data, err := json.Marshal(uiConfig{Language: code})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	// Atomic write: write to a temp file then rename, so a crash mid-write can't
	// leave a partially-written (corrupt) config file behind.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

// saveLangCmd persists the chosen language as a tea.Cmd, so the write runs off the
// Update path — and unit tests, which don't execute returned Cmds, never touch
// the filesystem. It produces no message.
func saveLangCmd(lang language) tea.Cmd {
	return func() tea.Msg {
		saveLangTo(uiConfigPath(), lang)
		return nil
	}
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Counts mirrors result.counts in the claude-mgr `inventory --format json` envelope.
// All fields are non-negative integers emitted by the Node CLI.
type Counts struct {
	Agents       int `json:"agents"`
	Commands     int `json:"commands"`
	Marketplaces int `json:"marketplaces"`
	McpServers   int `json:"mcpServers"`
	Plugins      int `json:"plugins"`
	Skills       int `json:"skills"`
}

// StatusLine mirrors result.statusLine. It may be null in the JSON, in which
// case the pointer on Result is nil.
type StatusLine struct {
	Command string `json:"command"`
	Type    string `json:"type"`
}

// Diagnostic is a single entry from the top-level diagnostics array. We capture
// only the fields the TUI needs (severity drives the health summary); unknown
// fields are ignored by encoding/json.
type Diagnostic struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

// Result mirrors the `result` object of the inventory envelope.
type Result struct {
	Counts         Counts      `json:"counts"`
	StatusLine     *StatusLine `json:"statusLine"`
	TopDirs        []string    `json:"topDirs"`
	UnknownTopDirs []string    `json:"unknownTopDirs"`
}

// Inventory is the full `inventory --format json` envelope (version:1).
type Inventory struct {
	Command     string       `json:"command"`
	Version     int          `json:"version"`
	Result      Result       `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// resolveCLIPath determines the path to the Node CLI entry (src/cli.mjs).
// Precedence (explicit beats ambient):
//
//	(a) --cli flag value (passed in as flagCLI), if non-empty;
//	(b) CLAUDE_MGR_CLI environment variable, if set;
//	(c) default "src/cli.mjs" relative to the current working directory.
//
// Assumption for (c): the user runs the TUI from the claude-mgr repo root,
// e.g. `./tui/claude-mgr-tui.exe`, so "src/cli.mjs" resolves correctly.
func resolveCLIPath(flagCLI string) string {
	if flagCLI != "" {
		return flagCLI
	}
	if env := os.Getenv("CLAUDE_MGR_CLI"); env != "" {
		return env
	}
	return "src/cli.mjs"
}

// fetchInventory shells out to `node <cliPath> inventory --format json`, captures
// stdout, and unmarshals it into an Inventory. It never panics: exec failures,
// timeouts, and malformed JSON are all returned as errors.
func fetchInventory(cliPath string) (Inventory, error) {
	var inv Inventory

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", cliPath, "inventory", "--format", "json")
	// cmd.Output() buffers all of stdout in memory. The inventory JSON is small
	// (~1 KB), so this is safe. A future multi-command version should wrap the
	// reader with io.LimitReader to defend against a misbehaving CLI emitting
	// unbounded output.
	out, err := cmd.Output()
	if err != nil {
		// Surface stderr from the Node process when available for a useful message.
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return inv, fmt.Errorf("running node CLI (%s): %v: %s", cliPath, err, string(ee.Stderr))
		}
		return inv, fmt.Errorf("running node CLI (%s): %w", cliPath, err)
	}

	if err := json.Unmarshal(out, &inv); err != nil {
		return inv, fmt.Errorf("parsing CLI JSON output: %w", err)
	}

	return inv, nil
}

// countDiagnostics returns how many diagnostics are errors and warnings.
// Severities are matched case-insensitively via strings.EqualFold.
func countDiagnostics(diags []Diagnostic) (errors, warnings int) {
	for _, d := range diags {
		switch {
		case strings.EqualFold(d.Severity, "error"):
			errors++
		case strings.EqualFold(d.Severity, "warn"),
			strings.EqualFold(d.Severity, "warning"):
			warnings++
		}
	}
	return errors, warnings
}

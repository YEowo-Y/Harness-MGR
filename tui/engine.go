package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
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

// ComponentSource mirrors the `source` map of a trimmed component record:
// `{tier, plugin?, marketplace?, version?}`. The TUI's detail pane surfaces
// Tier and Plugin; the remaining fields are captured but currently unused.
// All fields are optional in the JSON — encoding/json leaves missing ones "".
type ComponentSource struct {
	Tier        string `json:"tier"`
	Plugin      string `json:"plugin"`
	Marketplace string `json:"marketplace"`
	Version     string `json:"version"`
}

// Component mirrors one element of result.components from
// `inventory --detail --format json`: a discovered skill/agent/command trimmed
// to the fields a browsing UI needs. Kind is one of "skill"|"agent"|"command".
type Component struct {
	Name   string          `json:"name"`
	Kind   string          `json:"kind"`
	Source ComponentSource `json:"source"`
	Path   string          `json:"path"`
}

// detailInventory is a narrow envelope used only to decode result.components
// from the `--detail` run. It deliberately mirrors just the components array so
// the decode is independent of the counts-oriented Inventory struct above.
type detailInventory struct {
	Result struct {
		Components []Component `json:"components"`
	} `json:"result"`
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

// fetchComponents shells out to `node <cliPath> inventory --detail --format json`,
// captures stdout, and unmarshals result.components into a []Component. It reuses
// the same exec + 30s context timeout + JSON-unmarshal pattern as fetchInventory
// and never panics: exec failures, timeouts, and malformed JSON return errors,
// surfacing node stderr when available. The returned slice is ordered by kind
// then name so the list pane has a stable, grouped order.
func fetchComponents(cliPath string) ([]Component, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", cliPath, "inventory", "--detail", "--format", "json")
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("running node CLI (%s): %v: %s", cliPath, err, string(ee.Stderr))
		}
		return nil, fmt.Errorf("running node CLI (%s): %w", cliPath, err)
	}

	var di detailInventory
	if err := json.Unmarshal(out, &di); err != nil {
		return nil, fmt.Errorf("parsing CLI JSON output: %w", err)
	}

	comps := di.Result.Components
	sortComponents(comps)
	return comps, nil
}

// sortComponents orders components by kind then name (both ascending), in place.
// Ordering is case-insensitive on the surface text so "Foo" and "foo" cluster
// naturally; ties fall back to the case-sensitive value for determinism.
func sortComponents(comps []Component) {
	sort.SliceStable(comps, func(i, j int) bool {
		a, b := comps[i], comps[j]
		if !strings.EqualFold(a.Kind, b.Kind) {
			return strings.ToLower(a.Kind) < strings.ToLower(b.Kind)
		}
		if !strings.EqualFold(a.Name, b.Name) {
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		}
		return a.Name < b.Name
	})
}

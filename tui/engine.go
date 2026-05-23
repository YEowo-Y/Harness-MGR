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
// Description is the component's one-line summary (now emitted by --detail).
type Component struct {
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Source      ComponentSource `json:"source"`
	Path        string          `json:"path"`
	Description string          `json:"description"`
}

// Plugin mirrors one element of result.plugins from `inventory --detail`: an
// installed plugin with its marketplace provenance and cache/enabled facts.
type Plugin struct {
	Name         string `json:"name"`
	Key          string `json:"key"`
	Marketplace  string `json:"marketplace"`
	Version      string `json:"version"`
	Enabled      bool   `json:"enabled"`
	CachePresent bool   `json:"cachePresent"`
}

// Marketplace mirrors one element of result.marketplaces: a known marketplace
// with its source repo and on-disk facts.
type Marketplace struct {
	Name            string `json:"name"`
	SourceRepo      string `json:"sourceRepo"`
	OnDisk          bool   `json:"onDisk"`
	InstallLocation string `json:"installLocation"`
}

// McpServer mirrors one element of result.mcpServers: a configured MCP server
// with its transport, scope, and launch command. Args may be empty.
type McpServer struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport"`
	Scope     string   `json:"scope"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
}

// DetailData bundles all four object arrays decoded from a single
// `inventory --detail --format json` run. The tree groups these by type.
type DetailData struct {
	Components   []Component
	Plugins      []Plugin
	Marketplaces []Marketplace
	McpServers   []McpServer
}

// detailInventory is a narrow envelope used only to decode the four object
// arrays from the `--detail` run. It mirrors just those arrays so the decode is
// independent of the counts-oriented Inventory struct above.
type detailInventory struct {
	Result struct {
		Components   []Component   `json:"components"`
		Plugins      []Plugin      `json:"plugins"`
		Marketplaces []Marketplace `json:"marketplaces"`
		McpServers   []McpServer   `json:"mcpServers"`
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

// fetchDetail shells out to `node <cliPath> inventory --detail --format json`,
// captures stdout, and unmarshals ALL FOUR object arrays (components, plugins,
// marketplaces, mcpServers) into a DetailData in a single call. It reuses the
// same exec + 30s context timeout + JSON-unmarshal pattern as fetchInventory and
// never panics: exec failures, timeouts, and malformed JSON return errors,
// surfacing node stderr when available. Components are ordered by kind then name
// so the tree's per-type folders have a stable order.
func fetchDetail(cliPath string) (DetailData, error) {
	var d DetailData

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", cliPath, "inventory", "--detail", "--format", "json")
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return d, fmt.Errorf("running node CLI (%s): %v: %s", cliPath, err, string(ee.Stderr))
		}
		return d, fmt.Errorf("running node CLI (%s): %w", cliPath, err)
	}

	var di detailInventory
	if err := json.Unmarshal(out, &di); err != nil {
		return d, fmt.Errorf("parsing CLI JSON output: %w", err)
	}

	d.Components = di.Result.Components
	d.Plugins = di.Result.Plugins
	d.Marketplaces = di.Result.Marketplaces
	d.McpServers = di.Result.McpServers
	sortComponents(d.Components)
	return d, nil
}

// ── Conflicts & Orphans structs ───────────────────────────────────────────────

// ConflictMember is one component record inside a ConflictCluster.
type ConflictMember struct {
	Name   string          `json:"name"`
	Path   string          `json:"path"`
	Source ComponentSource `json:"source"`
}

// ConflictCluster is one shadowing cluster from the `conflicts --format json`
// result. Kind is "skill"/"agent"/"command"; Key is the resolution key; Confidence
// is "likely"/"verified"; Severity is the diagnostic severity. LikelyWinner is
// the component that wins; PossibleWinners are the others in the cluster.
type ConflictCluster struct {
	Kind            string           `json:"kind"`
	Key             string           `json:"key"`
	Confidence      string           `json:"confidence"`
	Severity        string           `json:"severity"`
	LikelyWinner    ConflictMember   `json:"likelyWinner"`
	PossibleWinners []ConflictMember `json:"possibleWinners"`
	Reason          string           `json:"reason"`
	Fix             string           `json:"fix"`
}

// Orphan is one entry from the `orphans --format json` result. Category is
// "hard" or "soft"; Container is the containing directory name; EntryType is
// "file" or "dir"; Path is the absolute path.
type Orphan struct {
	Category  string `json:"category"`
	Container string `json:"container"`
	EntryType string `json:"entryType"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Reason    string `json:"reason"`
}

// OrphanSummary holds the hard/soft/total counts from the `orphans` result.
type OrphanSummary struct {
	Hard  int `json:"hard"`
	Soft  int `json:"soft"`
	Total int `json:"total"`
}

// OrphansResult bundles the orphan list and summary from the `orphans` command.
type OrphansResult struct {
	Orphans []Orphan      `json:"orphans"`
	Summary OrphanSummary `json:"summary"`
}

// ── Narrow envelopes for conflicts / orphans decoding ────────────────────────

type conflictsEnvelope struct {
	Result struct {
		Conflicts []ConflictCluster `json:"conflicts"`
	} `json:"result"`
}

type orphansEnvelope struct {
	Result struct {
		Orphans []Orphan      `json:"orphans"`
		Summary OrphanSummary `json:"summary"`
	} `json:"result"`
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

// runJSON shells out to `node <cliPath> <args...>`, captures stdout, and returns
// the raw bytes. It never panics: exec failures, timeouts, and non-zero exits
// return errors with stderr included when available. The 30-second timeout
// matches the existing fetchInventory / fetchDetail pattern.
func runJSON(cliPath string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	allArgs := append([]string{cliPath}, args...)
	cmd := exec.CommandContext(ctx, "node", allArgs...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("running node CLI (%s): %v: %s", cliPath, err, string(ee.Stderr))
		}
		return nil, fmt.Errorf("running node CLI (%s): %w", cliPath, err)
	}
	return out, nil
}

// parseConflicts unmarshals a raw `conflicts --format json` envelope into a
// ConflictCluster slice. Pure function — no exec, never panics.
func parseConflicts(data []byte) ([]ConflictCluster, error) {
	var env conflictsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("parsing conflicts JSON: %w", err)
	}
	return env.Result.Conflicts, nil
}

// parseOrphans unmarshals a raw `orphans --format json` envelope into an
// OrphansResult. Pure function — no exec, never panics.
func parseOrphans(data []byte) (OrphansResult, error) {
	var env orphansEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return OrphansResult{}, fmt.Errorf("parsing orphans JSON: %w", err)
	}
	return OrphansResult{
		Orphans: env.Result.Orphans,
		Summary: env.Result.Summary,
	}, nil
}

// fetchConflicts shells out to `node <cliPath> conflicts --format json`,
// captures stdout, and unmarshals it into a ConflictCluster slice. It never
// panics: exec failures, timeouts, and malformed JSON are returned as errors.
func fetchConflicts(cliPath string) ([]ConflictCluster, error) {
	data, err := runJSON(cliPath, "conflicts", "--format", "json")
	if err != nil {
		return nil, err
	}
	return parseConflicts(data)
}

// fetchOrphans shells out to `node <cliPath> orphans --format json`, captures
// stdout, and unmarshals it into an OrphansResult. It never panics: exec
// failures, timeouts, and malformed JSON are returned as errors.
func fetchOrphans(cliPath string) (OrphansResult, error) {
	data, err := runJSON(cliPath, "orphans", "--format", "json")
	if err != nil {
		return OrphansResult{}, err
	}
	return parseOrphans(data)
}

// ── Config structs ────────────────────────────────────────────────────────────

// ConfigLayer is one layer entry in a ConfigKey's perLayer array.
type ConfigLayer struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"` // arbitrary JSON; render via string(Value)
}

// ConfigKey is one key entry from the `config show-effective --format json`
// result. Value is ARBITRARY JSON (string or object).
type ConfigKey struct {
	Key             string        `json:"key"`
	MergeConfidence string        `json:"mergeConfidence"`
	Strategy        string        `json:"strategy"`
	PerLayer        []ConfigLayer `json:"perLayer"`
}

// ConfigResult bundles the keys map from the `config show-effective` command.
type ConfigResult struct {
	Keys map[string]ConfigKey `json:"keys"`
}

// ── Hooks structs ────────────────────────────────────────────────────────────

// HookCmd is one command entry inside a HookEntry.
type HookCmd struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

// HookEntry is one entry in a hook event's array.
type HookEntry struct {
	Matcher string    `json:"matcher"`
	Hooks   []HookCmd `json:"hooks"`
}

// HooksResult bundles the hooks map from the `hooks --format json` command.
type HooksResult struct {
	Hooks map[string][]HookEntry `json:"hooks"`
}

// ── Selftest structs ──────────────────────────────────────────────────────────

// SelftestCheck is one check entry from the `selftest --format json` result.
type SelftestCheck struct {
	Name string `json:"name"`
	Ok   bool   `json:"ok"`
}

// SelftestResult bundles the checks slice and overall ok flag.
type SelftestResult struct {
	Checks []SelftestCheck `json:"checks"`
	Ok     bool            `json:"ok"`
}

// ── Narrow envelopes for config / hooks / selftest decoding ──────────────────

type configEnvelope struct {
	Result struct {
		Keys map[string]ConfigKey `json:"keys"`
	} `json:"result"`
}

type hooksEnvelope struct {
	Result struct {
		Hooks map[string][]HookEntry `json:"hooks"`
	} `json:"result"`
}

type selftestEnvelope struct {
	Result struct {
		Checks []SelftestCheck `json:"checks"`
		Ok     bool            `json:"ok"`
	} `json:"result"`
}

// ── Pure parse functions ──────────────────────────────────────────────────────

// parseConfig unmarshals a raw `config show-effective --format json` envelope
// into a ConfigResult. Pure function — no exec, never panics.
func parseConfig(data []byte) (ConfigResult, error) {
	var env configEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return ConfigResult{}, fmt.Errorf("parsing config JSON: %w", err)
	}
	return ConfigResult{Keys: env.Result.Keys}, nil
}

// parseHooks unmarshals a raw `hooks --format json` envelope into a HooksResult.
// Pure function — no exec, never panics.
func parseHooks(data []byte) (HooksResult, error) {
	var env hooksEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return HooksResult{}, fmt.Errorf("parsing hooks JSON: %w", err)
	}
	return HooksResult{Hooks: env.Result.Hooks}, nil
}

// parseSelftest unmarshals a raw `selftest --format json` envelope into a
// SelftestResult. Pure function — no exec, never panics.
func parseSelftest(data []byte) (SelftestResult, error) {
	var env selftestEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return SelftestResult{}, fmt.Errorf("parsing selftest JSON: %w", err)
	}
	return SelftestResult{Checks: env.Result.Checks, Ok: env.Result.Ok}, nil
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

// fetchConfig shells out to `node <cliPath> config show-effective --format json`,
// captures stdout, and unmarshals it into a ConfigResult. It never panics.
func fetchConfig(cliPath string) (ConfigResult, error) {
	data, err := runJSON(cliPath, "config", "show-effective", "--format", "json")
	if err != nil {
		return ConfigResult{}, err
	}
	return parseConfig(data)
}

// fetchHooks shells out to `node <cliPath> hooks --format json`, captures
// stdout, and unmarshals it into a HooksResult. It never panics.
func fetchHooks(cliPath string) (HooksResult, error) {
	data, err := runJSON(cliPath, "hooks", "--format", "json")
	if err != nil {
		return HooksResult{}, err
	}
	return parseHooks(data)
}

// fetchSelftest shells out to `node <cliPath> selftest --format json`, captures
// stdout, and unmarshals it into a SelftestResult. It never panics.
func fetchSelftest(cliPath string) (SelftestResult, error) {
	data, err := runJSON(cliPath, "selftest", "--format", "json")
	if err != nil {
		return SelftestResult{}, err
	}
	return parseSelftest(data)
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

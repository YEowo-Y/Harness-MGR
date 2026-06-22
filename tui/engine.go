package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
// fields are ignored by encoding/json. Fix is the engine's optional remediation
// hint (present on doctor diagnostics, "" elsewhere); it is surfaced in the
// Doctor tab's findings detail.
type Diagnostic struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Fix      string `json:"fix"`
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
//	(c) src/cli.mjs found by walking UP from the current working directory;
//	(d) src/cli.mjs found by walking UP from the executable's directory;
//	(e) bare "src/cli.mjs" (the historical default, relative to CWD).
//
// (c) lets `cd tui && go run .` work (CWD=tui/ → parent repo root has src/cli.mjs);
// (d) lets the built binary run from anywhere (tui/claude-mgr-tui.exe → its dir's
// parent is the repo root). (e) preserves the original behavior as a last resort.
func resolveCLIPath(flagCLI string) string {
	cwd, _ := os.Getwd()
	exe, _ := os.Executable()
	return resolveCLIPathFrom(flagCLI, os.Getenv("CLAUDE_MGR_CLI"), cwd, exe)
}

// resolveCLIPathFrom is the pure, testable core of resolveCLIPath: all ambient
// inputs (env, cwd, executable path) are parameters so tests can drive every arm.
func resolveCLIPathFrom(flagCLI, envCLI, cwd, exePath string) string {
	if flagCLI != "" {
		return flagCLI
	}
	if envCLI != "" {
		return envCLI
	}
	if cwd != "" {
		if p, ok := findCLIUpwards(cwd); ok {
			return p
		}
	}
	if exePath != "" {
		if p, ok := findCLIUpwards(filepath.Dir(exePath)); ok {
			return p
		}
	}
	return "src/cli.mjs"
}

// findCLIUpwards walks from startDir toward the filesystem root, returning the
// first existing <dir>/src/cli.mjs FILE (not a directory). Pure except for the
// os.Stat probe; never panics. Returns ("", false) if none is found.
func findCLIUpwards(startDir string) (string, bool) {
	dir := startDir
	for {
		candidate := filepath.Join(dir, "src", "cli.mjs")
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			return candidate, true
		}
		parent := filepath.Dir(dir)
		if parent == dir { // reached the filesystem root — stop
			return "", false
		}
		dir = parent
	}
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

// ── Dispositions (P5.U10) ─────────────────────────────────────────────────────

// DispositionWinner is the loader-winner component in a disposition record.
type DispositionWinner struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Tier   string `json:"tier"`
	Plugin string `json:"plugin"`
}

// DispositionShadowed is one shadowed loser component. Removable is true only
// when the loser is user-tier (remove can delete it); RemoveCommand is the
// ready-to-run `remove <kind>:<name>` string when removable, else "".
type DispositionShadowed struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	Tier          string `json:"tier"`
	Plugin        string `json:"plugin"`
	Removable     bool   `json:"removable"`
	RemoveCommand string `json:"removeCommand"`
}

// Disposition is one actionable record from result.dispositions in the
// `conflicts --format json` envelope. Kind/Key/Severity mirror the underlying
// ConflictCluster. Suggestion is the engine-composed English resolution hint.
// RuleID/DocURL/DocVersion link to the cited best-practice rule.
type Disposition struct {
	Kind       string                `json:"kind"`
	Key        string                `json:"key"`
	Severity   string                `json:"severity"`
	Winner     DispositionWinner     `json:"winner"`
	Shadowed   []DispositionShadowed `json:"shadowed"`
	Suggestion string                `json:"suggestion"`
	RuleID     string                `json:"ruleId"`
	DocURL     string                `json:"docUrl"`
	DocVersion string                `json:"docVersion"`
}

// dispositionsEnvelope is a narrow struct used only to decode the dispositions
// array from the `conflicts --format json` response.
type dispositionsEnvelope struct {
	Result struct {
		Dispositions []Disposition `json:"dispositions"`
	} `json:"result"`
}

// parseDispositions unmarshals a raw `conflicts --format json` envelope into a
// Disposition slice. Pure function — no exec, never panics.
func parseDispositions(data []byte) ([]Disposition, error) {
	var env dispositionsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("parsing dispositions JSON: %w", err)
	}
	return env.Result.Dispositions, nil
}

// fetchDispositions shells out to `node <cliPath> conflicts --format json`,
// captures stdout, and unmarshals the dispositions array. It never panics.
func fetchDispositions(cliPath string) ([]Disposition, error) {
	data, err := runJSON(cliPath, "conflicts", "--format", "json")
	if err != nil {
		return nil, err
	}
	return parseDispositions(data)
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

// ── Config-edit (plugin toggle) structs ─────────────────────────────────────
//
// The write half of the Inventory tab's confirm-apply flow toggles a plugin via
// the engine's `disable`/`enable --type plugin <key> --format json` command. These
// mirror that command's flat result envelope (the CLI summarize() shape) so the
// TUI can show a dry-run preview before the user confirms the real --apply.

// ConfigEditDiff is the before→after fragment from a config-edit dry-run's
// result.diff. Before is "" for an INSERT (the key did not exist yet). Line is the
// 1-based line in the target file. The fragments are engine DATA (raw JSON), shown
// verbatim in the confirm modal.
type ConfigEditDiff struct {
	Before string `json:"before"`
	After  string `json:"after"`
	Line   int    `json:"line"`
}

// ConfigEditResult mirrors the flat `result` object of a `disable`/`enable
// --type plugin <key> --format json` run. AlreadyInState is the authoritative
// state probe (an `enable` dry-run with AlreadyInState true ⇒ the plugin is
// already enabled in settings.json); Diff is nil for an already-in-state no-op.
type ConfigEditResult struct {
	Status         string          `json:"status"`
	Ok             bool            `json:"ok"`
	DryRun         bool            `json:"dryRun"`
	Name           string          `json:"name"`
	Target         string          `json:"target"`
	Desired        bool            `json:"desired"`
	AlreadyInState bool            `json:"alreadyInState"`
	Diff           *ConfigEditDiff `json:"diff"`
}

// configEditEnvelope decodes result + the top-level diagnostics from a config-edit
// JSON envelope (diagnostics sit beside result, mirroring doctorEnvelope).
type configEditEnvelope struct {
	Result      ConfigEditResult `json:"result"`
	Diagnostics []Diagnostic     `json:"diagnostics"`
}

// parseConfigEdit unmarshals a raw config-edit envelope into its result plus the
// top-level diagnostics. Pure function — no exec, never panics.
func parseConfigEdit(data []byte) (ConfigEditResult, []Diagnostic, error) {
	var env configEditEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return ConfigEditResult{}, nil, fmt.Errorf("parsing config-edit JSON: %w", err)
	}
	return env.Result, env.Diagnostics, nil
}

// runJSONCapture runs `node <cliPath> <args...>` and returns stdout EVEN when the
// process exits non-zero. Config-edit commands print their full JSON envelope to
// stdout AND set a non-zero exit code on a refusal (exit 2/3); the envelope's own
// ok/status/diagnostics carry the real outcome, so for these commands the exit
// code is redundant. A genuine failure with no stdout (e.g. node missing) still
// returns an error. The 30-second timeout matches runJSON.
func runJSONCapture(cliPath string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	allArgs := append([]string{cliPath}, args...)
	cmd := exec.CommandContext(ctx, "node", allArgs...)
	out, err := cmd.Output()
	if err != nil {
		if len(out) > 0 {
			return out, nil // refusal: the JSON envelope is still on stdout
		}
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("running node CLI (%s): %v: %s", cliPath, err, string(ee.Stderr))
		}
		return nil, fmt.Errorf("running node CLI (%s): %w", cliPath, err)
	}
	return out, nil
}

// fetchPluginToggleDry runs a DRY-RUN `enable|disable --type plugin <key>
// --format json` (NO --apply, so it writes NOTHING) and returns the parsed result
// plus the top-level diagnostics. It is the probe/preview half of the Inventory
// confirm-apply flow: the result's AlreadyInState reveals the authoritative
// settings.json state and Diff carries the before→after preview. Never panics.
func fetchPluginToggleDry(cliPath, key string, desired bool) (ConfigEditResult, []Diagnostic, error) {
	verb := "disable"
	if desired {
		verb = "enable"
	}
	data, err := runJSONCapture(cliPath, verb, "--type", "plugin", key, "--format", "json")
	if err != nil {
		return ConfigEditResult{}, nil, err
	}
	return parseConfigEdit(data)
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

// HooksResult bundles the hook explanations from the `hooks --format json`
// command. The raw hooks map is not decoded; only the explanations slice
// (result.explanations) is consumed by the TUI.
type HooksResult struct {
	Explanations []HookExplanation `json:"explanations"`
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

// ── Doctor structs ─────────────────────────────────────────────────────────────

// DoctorCheck is one check entry from result.checks of the `doctor --format json`
// envelope. ID + Code identify the check; ProbeLevel is "passive"/"active"; Ran
// is false for active checks skipped in the default passive run; Findings is the
// count of diagnostics the check produced. The check's Code joins to a top-level
// diagnostic's Code to recover its severity (that join drives the row color).
type DoctorCheck struct {
	ID         int    `json:"id"`
	Code       string `json:"code"`
	ProbeLevel string `json:"probeLevel"`
	Ran        bool   `json:"ran"`
	Findings   int    `json:"findings"`
}

// DoctorReport bundles the doctor run's probe level, its check list, and the
// top-level diagnostics (reusing the shared Diagnostic struct). Diagnostics carry
// the severity + message + fix that the Doctor tab joins back to each check by Code.
type DoctorReport struct {
	ProbeLevel  string        `json:"probeLevel"`
	Checks      []DoctorCheck `json:"checks"`
	Diagnostics []Diagnostic  `json:"diagnostics"`
}

// ── Narrow envelopes for config / hooks / selftest decoding ──────────────────

type configEnvelope struct {
	Result struct {
		Keys map[string]ConfigKey `json:"keys"`
	} `json:"result"`
}

type hooksEnvelope struct {
	Result struct {
		Explanations []HookExplanation `json:"explanations"`
	} `json:"result"`
}

type selftestEnvelope struct {
	Result struct {
		Checks []SelftestCheck `json:"checks"`
		Ok     bool            `json:"ok"`
	} `json:"result"`
}

// doctorEnvelope decodes result.probeLevel + result.checks and the TOP-LEVEL
// diagnostics array (diagnostics sit beside result in the doctor envelope, not
// inside it — that is where the per-check severities live).
type doctorEnvelope struct {
	Result struct {
		ProbeLevel string        `json:"probeLevel"`
		Checks     []DoctorCheck `json:"checks"`
	} `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
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
// It reads result.explanations (the U4 human-readable explanation slice).
// Pure function — no exec, never panics.
func parseHooks(data []byte) (HooksResult, error) {
	var env hooksEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return HooksResult{}, fmt.Errorf("parsing hooks JSON: %w", err)
	}
	return HooksResult{Explanations: env.Result.Explanations}, nil
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

// parseDoctor unmarshals a raw `doctor --format json` envelope into a
// DoctorReport, lifting the top-level diagnostics in alongside the result's
// probe level and checks. Pure function — no exec, never panics.
func parseDoctor(data []byte) (DoctorReport, error) {
	var env doctorEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return DoctorReport{}, fmt.Errorf("parsing doctor JSON: %w", err)
	}
	return DoctorReport{
		ProbeLevel:  env.Result.ProbeLevel,
		Checks:      env.Result.Checks,
		Diagnostics: env.Diagnostics,
	}, nil
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

// fetchDoctor shells out to `node <cliPath> doctor --format json`, captures
// stdout, and unmarshals it into a DoctorReport. It never panics.
//
// PASSIVE ONLY — it deliberately does NOT pass --active-probes. The active
// probes spawn child processes and WRITE a transient loader-probe file into the
// real ~/.claude/agents; that side effect must never fire merely because the
// user opened the TUI. The passive run is pure read-only judgment over already
// gathered facts.
func fetchDoctor(cliPath string) (DoctorReport, error) {
	data, err := runJSON(cliPath, "doctor", "--format", "json")
	if err != nil {
		return DoctorReport{}, err
	}
	return parseDoctor(data)
}

// fetchDoctorActive shells out to `node <cliPath> doctor --active-probes --format
// json` — the OPT-IN active run that executes the side-effecting probes (#4 node
// --check, #15 claude --version, #19 the transient loader-probe write/cleanup).
// It NEVER runs at startup or on a passive refresh; only an explicit, confirmed
// user action reaches it. Distinct from fetchDoctor, which stays passive. Never
// panics: exec/timeout/JSON errors are returned.
func fetchDoctorActive(cliPath string) (DoctorReport, error) {
	data, err := runJSON(cliPath, "doctor", "--active-probes", "--format", "json")
	if err != nil {
		return DoctorReport{}, err
	}
	return parseDoctor(data)
}

// ── Permissions structs ───────────────────────────────────────────────────────

// PermissionsResult bundles the allow/ask/deny rule lists and the overbroad
// subset from `permissions --audit --format json`. Overbroad is the subset of
// Allow entries that contain a wildcard (*); it may be empty.
type PermissionsResult struct {
	Allow       []string     `json:"allow"`
	Ask         []string     `json:"ask"`
	Deny        []string     `json:"deny"`
	Overbroad   []string     `json:"overbroad"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// permissionsEnvelope decodes result.allow/ask/deny/overbroad and the top-level
// diagnostics from the `permissions --audit --format json` envelope.
type permissionsEnvelope struct {
	Result struct {
		Allow     []string `json:"allow"`
		Ask       []string `json:"ask"`
		Deny      []string `json:"deny"`
		Overbroad []string `json:"overbroad"`
	} `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// parsePermissions unmarshals a raw `permissions --audit --format json` envelope
// into a PermissionsResult. Pure function — no exec, never panics.
func parsePermissions(data []byte) (PermissionsResult, error) {
	var env permissionsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return PermissionsResult{}, fmt.Errorf("parsing permissions JSON: %w", err)
	}
	return PermissionsResult{
		Allow:       env.Result.Allow,
		Ask:         env.Result.Ask,
		Deny:        env.Result.Deny,
		Overbroad:   env.Result.Overbroad,
		Diagnostics: env.Diagnostics,
	}, nil
}

// fetchPermissions shells out to `node <cliPath> permissions --audit --format json`,
// captures stdout, and unmarshals it into a PermissionsResult. It never panics:
// exec failures, timeouts, and malformed JSON are returned as errors. This is
// fully READ-ONLY — `permissions --audit` never writes to the config dir.
func fetchPermissions(cliPath string) (PermissionsResult, error) {
	data, err := runJSON(cliPath, "permissions", "--audit", "--format", "json")
	if err != nil {
		return PermissionsResult{}, err
	}
	return parsePermissions(data)
}

// ── Drift structs ───────────────────────────────────────────────────────────

// DriftChange is one changed file from `drift --format json` result.changes.
// Change is "added" | "removed" | "modified"; Path is the POSIX-relative path
// within the governed config surface.
type DriftChange struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// DriftSummary holds the added/removed/modified counts from the drift result.
type DriftSummary struct {
	Added    int `json:"added"`
	Removed  int `json:"removed"`
	Modified int `json:"modified"`
}

// DriftResult bundles the drift status, the change list, the summary counts, and
// the top-level diagnostics from `drift --format json`. Status is
// "no-baseline" | "clean" | "drifted".
type DriftResult struct {
	Status      string        `json:"status"`
	Changes     []DriftChange `json:"changes"`
	Summary     DriftSummary  `json:"summary"`
	Diagnostics []Diagnostic  `json:"diagnostics"`
}

// driftEnvelope decodes result.{status,changes,summary} + the top-level
// diagnostics from the `drift --format json` envelope.
type driftEnvelope struct {
	Result struct {
		Status  string        `json:"status"`
		Changes []DriftChange `json:"changes"`
		Summary DriftSummary  `json:"summary"`
	} `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// parseDrift unmarshals a raw `drift --format json` envelope into a DriftResult.
// Pure function — no exec, never panics.
func parseDrift(data []byte) (DriftResult, error) {
	var env driftEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return DriftResult{}, fmt.Errorf("parsing drift JSON: %w", err)
	}
	return DriftResult{
		Status:      env.Result.Status,
		Changes:     env.Result.Changes,
		Summary:     env.Result.Summary,
		Diagnostics: env.Diagnostics,
	}, nil
}

// fetchDrift shells out to `node <cliPath> drift --format json`, captures stdout,
// and unmarshals it into a DriftResult. It never panics.
//
// READ-ONLY — it deliberately does NOT pass --update. `drift` is dry-run by
// default: without --update it only READS the config surface + the lockfile and
// reports the diff; the lockfile is written ONLY under --update. Opening the TUI
// must never persist a new baseline.
func fetchDrift(cliPath string) (DriftResult, error) {
	data, err := runJSON(cliPath, "drift", "--format", "json")
	if err != nil {
		return DriftResult{}, err
	}
	return parseDrift(data)
}

// ── Audit structs ───────────────────────────────────────────────────────────

// AuditEntry is one metadata-only audit-log record. Its schema is intentionally
// open: the write side (Phase 3) is not built yet and the entry shape is not
// frozen, so each entry is decoded as an arbitrary key→raw-JSON map and rendered
// generically (sorted keys). Only "timestamp" is treated specially (the list
// title + the engine's sort key).
type AuditEntry map[string]json.RawMessage

// AuditSummary holds the counts + ISO bounds from the audit result.summary.
// Total counts well-formed entries before any --since filter; Returned counts
// those returned after it (the TUI passes no --since, so they match). Oldest /
// Newest are ISO strings, or "" when there are no timestamped entries (the JSON
// emits null, which decodes to the empty string).
type AuditSummary struct {
	Total            int    `json:"total"`
	Returned         int    `json:"returned"`
	SkippedMalformed int    `json:"skippedMalformed"`
	Oldest           string `json:"oldest"`
	Newest           string `json:"newest"`
}

// AuditResult bundles the entry list, the summary, and the top-level diagnostics
// from `audit --format json`.
type AuditResult struct {
	Entries     []AuditEntry `json:"entries"`
	Summary     AuditSummary `json:"summary"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// auditEnvelope decodes result.{entries,summary} + the top-level diagnostics
// from the `audit --format json` envelope.
type auditEnvelope struct {
	Result struct {
		Entries []AuditEntry `json:"entries"`
		Summary AuditSummary `json:"summary"`
	} `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// parseAudit unmarshals a raw `audit --format json` envelope into an AuditResult.
// Pure function — no exec, never panics.
func parseAudit(data []byte) (AuditResult, error) {
	var env auditEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return AuditResult{}, fmt.Errorf("parsing audit JSON: %w", err)
	}
	return AuditResult{
		Entries:     env.Result.Entries,
		Summary:     env.Result.Summary,
		Diagnostics: env.Diagnostics,
	}, nil
}

// fetchAudit shells out to `node <cliPath> audit --format json`, captures stdout,
// and unmarshals it into an AuditResult. It never panics. Fully READ-ONLY — the
// audit command only reads the metadata-only .mgr-state/audit.log (a missing log
// is benign: zero entries).
func fetchAudit(cliPath string) (AuditResult, error) {
	data, err := runJSON(cliPath, "audit", "--format", "json")
	if err != nil {
		return AuditResult{}, err
	}
	return parseAudit(data)
}

// ── Health structs ────────────────────────────────────────────────────────────
//
// The `health --format json` envelope (version:1) bundles three sub-objects the
// Health tab renders together: result.health (per-component loadability),
// result.advice (the offline best-practice rule matches, with B1's bilingual
// zh fields), and result.hooks (a compact hook-resolution status). These structs
// mirror that REAL shape field-for-field; encoding/json ignores any extra fields.

// HealthReason is one reason a component is degraded or not-loaded — a
// code/severity/message triple lifted straight from the engine. Severity is
// "error" | "warn" | "info". Engine DATA stays English (the message is a literal
// engine string, never translated — see the bilingual design note in tabs.go).
type HealthReason struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// HealthComponent is one element of result.health.components: a discovered
// component with its resolved load status and the reasons behind it. Status is
// "loadable" | "degraded" | "not-loaded". WorstSeverity is "error" | "warn" |
// "info" or "" (the JSON emits null when there are no reasons).
type HealthComponent struct {
	Kind          string         `json:"kind"`
	Name          string         `json:"name"`
	Path          string         `json:"path"`
	Scope         string         `json:"scope"`
	Status        string         `json:"status"`
	WorstSeverity string         `json:"worstSeverity"`
	Reasons       []HealthReason `json:"reasons"`
}

// HealthSummary holds the component-count rollup from result.health.summary.
type HealthSummary struct {
	Total     int `json:"total"`
	Loadable  int `json:"loadable"`
	Degraded  int `json:"degraded"`
	NotLoaded int `json:"notLoaded"`
}

// HealthSection mirrors result.health: the per-component status list plus its
// summary. The groups array (scope×kind×status rollup) is present in the JSON but
// the TUI renders from components directly, so it is not decoded here.
type HealthSection struct {
	Summary    HealthSummary     `json:"summary"`
	Components []HealthComponent `json:"components"`
}

// AdviceItem is one offline best-practice rule match from result.advice.advice.
// The zh fields (TitleZh/AdviceZh/FixZh) are B1's bilingual payload — the Health
// tab renders them under langZH and falls back to the English field when a zh
// string is empty (a custom rule may lack a translation). Severity is "error" |
// "warn" | "info". AffectedPaths/MatchedCodes are engine DATA (stay English).
type AdviceItem struct {
	RuleID        string   `json:"ruleId"`
	Title         string   `json:"title"`
	TitleZh       string   `json:"titleZh"`
	Severity      string   `json:"severity"`
	Advice        string   `json:"advice"`
	AdviceZh      string   `json:"adviceZh"`
	Fix           string   `json:"fix"`
	FixZh         string   `json:"fixZh"`
	AffectedPaths []string `json:"affectedPaths"`
	MatchedCodes  []string `json:"matchedCodes"`
	DocURL        string   `json:"docUrl"`
	DocVersion    string   `json:"docVersion"`
}

// AdviceSummary holds the advice-count rollup by severity from
// result.advice.summary.
type AdviceSummary struct {
	Total int `json:"total"`
	Error int `json:"error"`
	Warn  int `json:"warn"`
	Info  int `json:"info"`
}

// AdviceSection mirrors result.advice: the rule-match list plus its summary.
type AdviceSection struct {
	Summary AdviceSummary `json:"summary"`
	Advice  []AdviceItem  `json:"advice"`
}

// HookExplanation is one element of result.hooks.explanations: a configured hook
// with its resolution status and the engine's English explanation sentence. Kind
// is "file" | "external" | "opaque"; Status is "found" | "missing" |
// "indeterminate" | "unprobed". Explanation is the engine's English sentence,
// used verbatim in en mode; in zh mode the TUI recomposes a Chinese sentence
// from the other fields (hookExplainSentenceZh) rather than translating it.
type HookExplanation struct {
	Event       string `json:"event"`
	Matcher     string `json:"matcher"`
	Command     string `json:"command"`
	Kind        string `json:"kind"`
	Target      string `json:"target"`
	Status      string `json:"status"`
	Explanation string `json:"explanation"`
}

// HooksByKind holds the per-kind hook counts from result.hooks.summary.byKind.
type HooksByKind struct {
	File     int `json:"file"`
	External int `json:"external"`
	Opaque   int `json:"opaque"`
}

// HooksHealthSummary holds the hook-resolution rollup from result.hooks.summary.
type HooksHealthSummary struct {
	Total         int         `json:"total"`
	Missing       int         `json:"missing"`
	Indeterminate int         `json:"indeterminate"`
	ByKind        HooksByKind `json:"byKind"`
}

// HooksHealthSection mirrors result.hooks: the per-hook explanations plus its
// summary.
type HooksHealthSection struct {
	Summary      HooksHealthSummary `json:"summary"`
	Explanations []HookExplanation  `json:"explanations"`
}

// HealthReport bundles the three sub-objects of the `health --format json`
// envelope plus the top-level diagnostics. It is what parseHealth returns and the
// Health tab renders from.
type HealthReport struct {
	Health      HealthSection      `json:"health"`
	Advice      AdviceSection      `json:"advice"`
	Hooks       HooksHealthSection `json:"hooks"`
	Diagnostics []Diagnostic       `json:"diagnostics"`
}

// healthEnvelope decodes result.{health,advice,hooks} + the TOP-LEVEL diagnostics
// array from the `health --format json` envelope (diagnostics sit beside result,
// not inside it — mirrors doctorEnvelope).
type healthEnvelope struct {
	Result struct {
		Health HealthSection      `json:"health"`
		Advice AdviceSection      `json:"advice"`
		Hooks  HooksHealthSection `json:"hooks"`
	} `json:"result"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// parseHealth unmarshals a raw `health --format json` envelope into a
// HealthReport, lifting the top-level diagnostics in alongside the three result
// sub-objects. Pure function — no exec, never panics.
func parseHealth(data []byte) (HealthReport, error) {
	var env healthEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return HealthReport{}, fmt.Errorf("parsing health JSON: %w", err)
	}
	return HealthReport{
		Health:      env.Result.Health,
		Advice:      env.Result.Advice,
		Hooks:       env.Result.Hooks,
		Diagnostics: env.Diagnostics,
	}, nil
}

// fetchHealth shells out to `node <cliPath> health --format json`, captures
// stdout, and unmarshals it into a HealthReport. It never panics.
//
// READ-ONLY but HEAVY — `health` aggregates scan + a PASSIVE doctor run + hooks
// + the advice engine in a single command (no --active-probes, so no child
// spawn and no transient probe write). It is the heaviest single section fetch,
// which is why the Health tab lazy-loads on first visit rather than eager-fetching
// at startup (see lazyLoadCurrent).
func fetchHealth(cliPath string) (HealthReport, error) {
	data, err := runJSON(cliPath, "health", "--format", "json")
	if err != nil {
		return HealthReport{}, err
	}
	return parseHealth(data)
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

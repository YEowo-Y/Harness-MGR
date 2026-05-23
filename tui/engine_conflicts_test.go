package main

import (
	"testing"
)

// ── Sample JSON fixtures ──────────────────────────────────────────────────────

// sampleConflictsJSON is a minimal `conflicts --format json` envelope with one
// cluster: kind=agent, key=executor, one likelyWinner, two possibleWinners.
var sampleConflictsJSON = []byte(`{
	"command": "conflicts",
	"version": 1,
	"result": {
		"conflicts": [
			{
				"kind": "agent",
				"key": "executor",
				"confidence": "likely",
				"severity": "warn",
				"likelyWinner": {
					"name": "executor",
					"path": "/user/.claude/agents/executor.md",
					"source": { "tier": "user", "plugin": "" }
				},
				"possibleWinners": [
					{
						"name": "executor",
						"path": "/plugins/alpha/agents/executor.md",
						"source": { "tier": "plugin", "plugin": "alpha" }
					},
					{
						"name": "executor",
						"path": "/plugins/beta/agents/executor.md",
						"source": { "tier": "plugin", "plugin": "beta" }
					}
				],
				"reason": "user agent shadows plugin agents",
				"fix": "rename or remove the shadowed agent"
			}
		]
	},
	"diagnostics": []
}`)

// sampleOrphansJSON is a minimal `orphans --format json` envelope with two hard
// orphans and one soft orphan (summary hard:2 / soft:1 / total:3).
var sampleOrphansJSON = []byte(`{
	"command": "orphans",
	"version": 1,
	"result": {
		"orphans": [
			{
				"category": "hard",
				"container": ".claude",
				"entryType": "file",
				"name": "stale.txt",
				"path": "/user/.claude/stale.txt",
				"reason": "not in KNOWN_TOP_FILES"
			},
			{
				"category": "hard",
				"container": ".claude",
				"entryType": "dir",
				"name": "junk",
				"path": "/user/.claude/junk",
				"reason": "not in KNOWN_TOP_DIRS"
			},
			{
				"category": "soft",
				"container": "skills",
				"entryType": "file",
				"name": "loose.txt",
				"path": "/user/.claude/skills/loose.txt",
				"reason": "loose non-.md file in skills/"
			}
		],
		"summary": { "hard": 2, "soft": 1, "total": 3 }
	},
	"diagnostics": []
}`)

// ── parseConflicts tests ──────────────────────────────────────────────────────

func TestParseConflictsClusterCount(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	if len(clusters) != 1 {
		t.Fatalf("cluster count = %d, want 1", len(clusters))
	}
}

func TestParseConflictsKindAndKey(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	c := clusters[0]
	if c.Kind != "agent" {
		t.Fatalf("Kind = %q, want %q", c.Kind, "agent")
	}
	if c.Key != "executor" {
		t.Fatalf("Key = %q, want %q", c.Key, "executor")
	}
}

func TestParseConflictsConfidenceAndSeverity(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	c := clusters[0]
	if c.Confidence != "likely" {
		t.Fatalf("Confidence = %q, want %q", c.Confidence, "likely")
	}
	if c.Severity != "warn" {
		t.Fatalf("Severity = %q, want %q", c.Severity, "warn")
	}
}

func TestParseConflictsLikelyWinner(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	w := clusters[0].LikelyWinner
	if w.Name != "executor" {
		t.Fatalf("LikelyWinner.Name = %q, want %q", w.Name, "executor")
	}
	if w.Source.Tier != "user" {
		t.Fatalf("LikelyWinner.Source.Tier = %q, want %q", w.Source.Tier, "user")
	}
}

func TestParseConflictsPossibleWinnersCount(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	pw := clusters[0].PossibleWinners
	if len(pw) != 2 {
		t.Fatalf("PossibleWinners count = %d, want 2", len(pw))
	}
}

func TestParseConflictsPossibleWinnersPlugins(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	pw := clusters[0].PossibleWinners
	if pw[0].Source.Plugin != "alpha" {
		t.Fatalf("PossibleWinners[0].Source.Plugin = %q, want %q", pw[0].Source.Plugin, "alpha")
	}
	if pw[1].Source.Plugin != "beta" {
		t.Fatalf("PossibleWinners[1].Source.Plugin = %q, want %q", pw[1].Source.Plugin, "beta")
	}
}

func TestParseConflictsReasonAndFix(t *testing.T) {
	clusters, err := parseConflicts(sampleConflictsJSON)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	c := clusters[0]
	if c.Reason == "" {
		t.Fatal("Reason should not be empty")
	}
	if c.Fix == "" {
		t.Fatal("Fix should not be empty")
	}
}

func TestParseConflictsInvalidJSON(t *testing.T) {
	_, err := parseConflicts([]byte(`not json`))
	if err == nil {
		t.Fatal("parseConflicts should return error on invalid JSON")
	}
}

func TestParseConflictsEmptyConflicts(t *testing.T) {
	data := []byte(`{"command":"conflicts","version":1,"result":{"conflicts":[]},"diagnostics":[]}`)
	clusters, err := parseConflicts(data)
	if err != nil {
		t.Fatalf("parseConflicts error: %v", err)
	}
	if len(clusters) != 0 {
		t.Fatalf("expected 0 clusters, got %d", len(clusters))
	}
}

// ── parseOrphans tests ────────────────────────────────────────────────────────

func TestParseOrphansSummary(t *testing.T) {
	result, err := parseOrphans(sampleOrphansJSON)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	s := result.Summary
	if s.Hard != 2 {
		t.Fatalf("Summary.Hard = %d, want 2", s.Hard)
	}
	if s.Soft != 1 {
		t.Fatalf("Summary.Soft = %d, want 1", s.Soft)
	}
	if s.Total != 3 {
		t.Fatalf("Summary.Total = %d, want 3", s.Total)
	}
}

func TestParseOrphansCount(t *testing.T) {
	result, err := parseOrphans(sampleOrphansJSON)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	if len(result.Orphans) != 3 {
		t.Fatalf("orphan count = %d, want 3", len(result.Orphans))
	}
}

func TestParseOrphansHardCategory(t *testing.T) {
	result, err := parseOrphans(sampleOrphansJSON)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	o := result.Orphans[0]
	if o.Category != "hard" {
		t.Fatalf("Orphans[0].Category = %q, want %q", o.Category, "hard")
	}
	if o.Name != "stale.txt" {
		t.Fatalf("Orphans[0].Name = %q, want %q", o.Name, "stale.txt")
	}
	if o.EntryType != "file" {
		t.Fatalf("Orphans[0].EntryType = %q, want %q", o.EntryType, "file")
	}
}

func TestParseOrphansSoftCategory(t *testing.T) {
	result, err := parseOrphans(sampleOrphansJSON)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	o := result.Orphans[2]
	if o.Category != "soft" {
		t.Fatalf("Orphans[2].Category = %q, want %q", o.Category, "soft")
	}
	if o.Container != "skills" {
		t.Fatalf("Orphans[2].Container = %q, want %q", o.Container, "skills")
	}
}

func TestParseOrphansPathField(t *testing.T) {
	result, err := parseOrphans(sampleOrphansJSON)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	if result.Orphans[0].Path == "" {
		t.Fatal("Orphans[0].Path should not be empty")
	}
	if result.Orphans[0].Reason == "" {
		t.Fatal("Orphans[0].Reason should not be empty")
	}
}

func TestParseOrphansInvalidJSON(t *testing.T) {
	_, err := parseOrphans([]byte(`not json`))
	if err == nil {
		t.Fatal("parseOrphans should return error on invalid JSON")
	}
}

func TestParseOrphansEmptyResult(t *testing.T) {
	data := []byte(`{"command":"orphans","version":1,"result":{"orphans":[],"summary":{"hard":0,"soft":0,"total":0}},"diagnostics":[]}`)
	result, err := parseOrphans(data)
	if err != nil {
		t.Fatalf("parseOrphans error: %v", err)
	}
	if len(result.Orphans) != 0 {
		t.Fatalf("expected 0 orphans, got %d", len(result.Orphans))
	}
	if result.Summary.Total != 0 {
		t.Fatalf("Summary.Total = %d, want 0", result.Summary.Total)
	}
}

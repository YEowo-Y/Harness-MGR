package main

import (
	"strings"
	"testing"
)

// TestTypeIconKnownKinds asserts each of the six known kind strings returns its
// designated single-width symbol. typeIcon is pure (not gated) so we test it
// directly without worrying about the unicode gate.
func TestTypeIconKnownKinds(t *testing.T) {
	cases := []struct {
		kind string
		want string
	}{
		{"skill", "◆"},
		{"agent", "●"},
		{"command", "▸"},
		{"plugin", "✦"},
		{"marketplace", "▪"},
		{"mcp", "◇"},
	}
	for _, tc := range cases {
		if got := typeIcon(tc.kind); got != tc.want {
			t.Errorf("typeIcon(%q) = %q, want %q", tc.kind, got, tc.want)
		}
	}
}

// TestTypeIconCaseInsensitive checks that mixed-case and whitespace-padded
// inputs are normalised correctly.
func TestTypeIconCaseInsensitive(t *testing.T) {
	if got := typeIcon("Skill"); got != "◆" {
		t.Errorf("typeIcon(%q) = %q, want %q", "Skill", got, "◆")
	}
	if got := typeIcon("  MCP  "); got != "◇" {
		t.Errorf("typeIcon(%q) = %q, want %q", "  MCP  ", got, "◇")
	}
}

// TestTypeIconUnknown asserts that unknown and empty kind strings return "".
func TestTypeIconUnknown(t *testing.T) {
	for _, kind := range []string{"", "unknown", "other", "PLUGIN_EXTRA"} {
		if got := typeIcon(kind); got != "" {
			t.Errorf("typeIcon(%q) = %q, want %q", kind, got, "")
		}
	}
}

// TestIconsTestView verifies the --icons render test includes every type label
// plus both its emoji and symbol candidate.
func TestIconsTestView(t *testing.T) {
	got := iconsTestView()
	if got == "" {
		t.Fatal("iconsTestView returned empty")
	}
	if len(iconCandidates) != 6 {
		t.Fatalf("iconCandidates = %d, want 6 (skill/agent/command/plugin/marketplace/mcp)", len(iconCandidates))
	}
	for _, ic := range iconCandidates {
		if !strings.Contains(got, ic.label) {
			t.Fatalf("iconsTestView missing label %q", ic.label)
		}
		if !strings.Contains(got, ic.emoji) {
			t.Fatalf("iconsTestView missing emoji %q for %q", ic.emoji, ic.label)
		}
		if !strings.Contains(got, ic.symbol) {
			t.Fatalf("iconsTestView missing symbol %q for %q", ic.symbol, ic.label)
		}
	}
}

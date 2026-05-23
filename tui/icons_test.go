package main

import (
	"strings"
	"testing"
)

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

package main

import (
	"strings"
	"testing"
)

func TestGradientTextEmpty(t *testing.T) {
	if got := gradientText("", "#2DD4BF", "#A78BFA"); got != "" {
		t.Fatalf("gradientText(\"\") = %q, want \"\"", got)
	}
}

// TestGradientTextPlainRunes verifies that in the no-TTY test environment
// (Ascii color profile) the rune content survives even though lipgloss drops
// ANSI sequences. The output must contain all runes of the input in order.
func TestGradientTextPlainRunes(t *testing.T) {
	got := gradientText("claude-mgr", "#2DD4BF", "#A78BFA")
	if !strings.Contains(got, "claude-mgr") {
		t.Fatalf("gradientText(\"claude-mgr\") = %q, want it to contain \"claude-mgr\"", got)
	}
}

// TestGradientTextBadHex verifies that a bad hex color in EITHER argument falls
// back to plain bold rendering without panicking, and the input text survives.
func TestGradientTextBadHex(t *testing.T) {
	for _, tc := range []struct{ from, to string }{
		{"nothex", "#A78BFA"},
		{"#2DD4BF", "nothex"},
		{"nothex", "alsobad"},
	} {
		got := gradientText("hi", tc.from, tc.to)
		if !strings.Contains(got, "hi") {
			t.Fatalf("gradientText(\"hi\", %q, %q) = %q, want it to contain \"hi\"", tc.from, tc.to, got)
		}
	}
}

// TestGradientTextSingleRune covers the n==1 boundary: the t computation must
// not divide by zero, and the lone rune must survive.
func TestGradientTextSingleRune(t *testing.T) {
	got := gradientText("X", "#2DD4BF", "#A78BFA")
	if !strings.Contains(got, "X") {
		t.Fatalf("single-rune gradientText = %q, want it to contain \"X\"", got)
	}
}

// TestBrandWordmarkContainsText verifies brandWordmark() returns text containing
// "claude-mgr" in a no-TTY test environment.
func TestBrandWordmarkContainsText(t *testing.T) {
	got := brandWordmark()
	if !strings.Contains(got, "claude-mgr") {
		t.Fatalf("brandWordmark() = %q, want it to contain \"claude-mgr\"", got)
	}
}

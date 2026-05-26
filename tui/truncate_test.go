package main

import (
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// truncate must measure DISPLAY COLUMNS (via lipgloss.Width), not rune count: a
// CJK rune is 2 columns wide, so the previous rune-count truncate let Chinese
// labels overflow their cell. The core invariant these tests pin is:
//   lipgloss.Width(truncate(s, w)) <= w   for every s and w >= 0.

// ── ASCII: unchanged when it already fits ─────────────────────────────────────

func TestTruncateASCIIWithinWidth(t *testing.T) {
	if got := truncate("hello", 10); got != "hello" {
		t.Fatalf("truncate(hello,10) = %q, want hello", got)
	}
}

func TestTruncateZeroWidth(t *testing.T) {
	if got := truncate("anything", 0); got != "" {
		t.Fatalf("truncate(_,0) = %q, want empty", got)
	}
}

// ── CJK: a 2-rune / 4-column string fits in width 4, not width 2 ──────────────

func TestTruncateCJKExactFit(t *testing.T) {
	s := "清单" // 2 runes, 4 columns
	if got := truncate(s, 4); got != s {
		t.Fatalf("truncate(%q,4) = %q, want unchanged (4 cols fit)", s, got)
	}
}

// ── The regression: CJK truncation must NEVER render wider than the budget ────

func TestTruncateCJKNeverExceedsWidth(t *testing.T) {
	s := "孤儿文件检测与清理报告" // 11 CJK runes = 22 columns
	for _, w := range []int{1, 2, 3, 5, 8, 13, 21} {
		got := truncate(s, w)
		if gw := lipgloss.Width(got); gw > w {
			t.Fatalf("truncate(%q,%d)=%q has display width %d > %d", s, w, got, gw, w)
		}
	}
}

func TestTruncateMixedNeverExceedsWidth(t *testing.T) {
	s := "skill: 孤儿文件 detector" // ASCII + CJK + ASCII
	for _, w := range []int{4, 7, 10, 15, 20, 24} {
		got := truncate(s, w)
		if gw := lipgloss.Width(got); gw > w {
			t.Fatalf("truncate(%q,%d)=%q has display width %d > %d", s, w, got, gw, w)
		}
	}
}

// ── an over-width string actually gets cut (and keeps an ellipsis when room) ──

func TestTruncateCutsAndFits(t *testing.T) {
	got := truncate("hello world", 8)
	if got == "hello world" {
		t.Fatal("expected truncation of an over-width string")
	}
	if gw := lipgloss.Width(got); gw > 8 {
		t.Fatalf("truncate(hello world,8)=%q width %d > 8", got, gw)
	}
}

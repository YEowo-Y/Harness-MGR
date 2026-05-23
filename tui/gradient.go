package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/lucasb-eyer/go-colorful"
)

// gradientText renders s with a per-rune Lab-space color blend from fromHex to
// toHex (bold). Degrades for free: on a no-color profile lipgloss drops the
// foreground, leaving plain text. Empty s -> "". Bad hex -> plain bold text.
func gradientText(s, fromHex, toHex string) string {
	if s == "" {
		return ""
	}
	c1, err1 := colorful.Hex(fromHex)
	c2, err2 := colorful.Hex(toHex)
	if err1 != nil || err2 != nil {
		return lipgloss.NewStyle().Bold(true).Render(s)
	}
	runes := []rune(s)
	n := len(runes)
	var b strings.Builder
	for i, r := range runes {
		t := 0.0
		if n > 1 {
			t = float64(i) / float64(n-1)
		}
		hex := c1.BlendLab(c2, t).Clamped().Hex()
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(hex)).Render(string(r)))
	}
	return b.String()
}

// brandWordmark returns "claude-mgr" rendered with a teal→violet gradient.
func brandWordmark() string {
	return gradientText("claude-mgr", "#2DD4BF", "#A78BFA")
}

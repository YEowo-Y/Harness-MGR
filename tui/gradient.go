package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/lucasb-eyer/go-colorful"
)

// gradientText renders s with a per-rune HCL blend from fromHex to toHex (bold).
// Thin wrapper over gradientStops for the common two-color case.
func gradientText(s, fromHex, toHex string) string {
	return gradientStops(s, []string{fromHex, toHex})
}

// brandWordmark renders "warden" in a vivid teal→cyan→blue→violet gradient,
// blended in HCL space so the midtones stay saturated (a Lab blend washes out
// through the middle). The stop list is rebuilt per call so no shared mutable
// slice can be aliased.
func brandWordmark() string {
	return gradientStops("warden", []string{"#2DD4BF", "#22D3EE", "#3B82F6", "#A855F7"})
}

// gradientStops renders s with a per-rune color blend across an ordered list of
// hex stops, interpolating in HCL space (vivid midtones), bold. Degrades for
// free: a no-color profile drops the foreground, leaving plain text. Empty s ->
// "". No stops / a single stop / any bad hex -> a safe plain or solid fallback.
// Never panics.
func gradientStops(s string, stops []string) string {
	if s == "" {
		return ""
	}
	cols, ok := parseStops(stops)
	if !ok {
		return lipgloss.NewStyle().Bold(true).Render(s)
	}
	runes := []rune(s)
	n := len(runes)
	segs := len(cols) - 1
	var b strings.Builder
	for i, r := range runes {
		hex := stopColorAt(cols, segs, fraction(i, n)).Hex()
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(hex)).Render(string(r)))
	}
	return b.String()
}

// parseStops parses hex stops into colors. ok=false (caller falls back to plain
// bold) when there are no stops or any hex is invalid.
func parseStops(stops []string) ([]colorful.Color, bool) {
	if len(stops) == 0 {
		return nil, false
	}
	cols := make([]colorful.Color, len(stops))
	for i, h := range stops {
		c, err := colorful.Hex(h)
		if err != nil {
			return nil, false
		}
		cols[i] = c
	}
	return cols, true
}

// fraction returns rune i's position in [0,1] across n runes (0 when n<=1).
func fraction(i, n int) float64 {
	if n <= 1 {
		return 0
	}
	return float64(i) / float64(n-1)
}

// stopColorAt maps t in [0,1] to a color along the stop list, HCL-blending the
// bracketing pair. segs == len(cols)-1; a single stop (segs<=0) returns cols[0].
func stopColorAt(cols []colorful.Color, segs int, t float64) colorful.Color {
	if segs <= 0 {
		return cols[0]
	}
	pos := t * float64(segs)
	idx := int(pos)
	if idx >= segs {
		idx = segs - 1
	}
	local := pos - float64(idx)
	return cols[idx].BlendHcl(cols[idx+1], local).Clamped()
}

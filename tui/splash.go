package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// mascotColor is the mascot's own coral — a distinct hue not reused elsewhere in
// the palette (the six type colors, orphan orange, and error red are all
// separate), so the corner pet reads as its own element against the
// teal→violet wordmark gradient.
var mascotColor = lipgloss.Color("#F4845C")

// splashMascot is the corner pet: a 3-line block-pixel creature (a solid
// forehead, two eyes, and three little legs) rendered in mascotColor in the
// dashboard's top-right. Drawn with full-block glyphs; the eye and leg gaps are
// spaces, so the dark terminal background shows through as the dark eyes/feet.
// Only shown when unicodeEnabled(). Kept at exactly 3 rows so mascotExtraRows
// (the splitDims header-height reservation) stays correct.
var splashMascot = []string{
	`██████████`,
	`███ ██ ███`,
	`██  ██  ██`,
}

// splashBanner is the ASCII-art block for "warden" (ANSI Shadow font), 6 rows
// tall, ~52 columns. Each line is individually gradient-colored at render time.
var splashBanner = []string{
	`██╗    ██╗ █████╗ ██████╗ ██████╗ ███████╗███╗   ██╗`,
	`██║    ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝████╗  ██║`,
	`██║ █╗ ██║███████║██████╔╝██║  ██║█████╗  ██╔██╗ ██║`,
	`██║███╗██║██╔══██║██╔══██╗██║  ██║██╔══╝  ██║╚██╗██║`,
	`╚███╔███╔╝██║  ██║██║  ██║██████╔╝███████╗██║ ╚████║`,
	` ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝`,
}

// splashStops are the brand gradient stops: teal → cyan → blue → violet.
var splashStops = []string{"#2DD4BF", "#22D3EE", "#3B82F6", "#A855F7"}

// splashTagline is the dim subtitle rendered below the banner.
const splashTagline = "agent harness configuration governance · read-only"

// splashHint is the dim instruction line rendered below the tagline.
const splashHint = "▸ press any key to enter"

// splashView renders the startup splash screen centered in the given terminal
// dimensions. Each banner line is gradient-colored via gradientStops. When the
// banner is wider than width (narrow terminal) it falls back to brandWordmark().
// Guards width<1 / height<1 to never panic.
func splashView(width, height int) string {
	if width < 1 || height < 1 {
		return ""
	}

	// Measure the widest banner line (visible runes, no ANSI yet).
	bannerWidth := 0
	for _, line := range splashBanner {
		if n := len([]rune(line)); n > bannerWidth {
			bannerWidth = n
		}
	}

	// Build the gradient banner block or fall back to the single-line wordmark.
	var bannerBlock string
	if unicodeEnabled() && bannerWidth > 0 && bannerWidth <= width {
		lines := make([]string, len(splashBanner))
		for i, line := range splashBanner {
			lines[i] = gradientStops(line, splashStops)
		}
		bannerBlock = strings.Join(lines, "\n")
	} else {
		// Narrow or non-Unicode terminal: single-line wordmark fallback (the
		// banner's box-drawing glyphs would be mojibake on an Ascii profile).
		bannerBlock = brandWordmark()
	}

	tagStyle := lipgloss.NewStyle().Foreground(configGray)
	hintStyle := lipgloss.NewStyle().Foreground(leaderDim)

	block := bannerBlock +
		"\n\n" + tagStyle.Render(splashTagline) +
		"\n" + hintStyle.Render(splashHint)

	// Center the whole block in the terminal.
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, block)
}

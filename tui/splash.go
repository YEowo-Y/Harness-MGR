package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// mascotStops are the mascot's own vivid multi-color gradient (rose → amber →
// green → sky → purple), distinct from the brand wordmark's teal→violet so the
// corner pet reads as its own playful element. renderMascot blends these per row.
var mascotStops = []string{"#FB7185", "#FBBF24", "#34D399", "#38BDF8", "#C084FC"}

// mascotColor is the solid fallback used only if mascotStops can't be parsed (it
// never should); it keeps renderMascot degrading to a single hue, never blank.
var mascotColor = lipgloss.Color("#F4845C")

// splashMascot is the corner pet's "eyes open" frame: a 4-line block-pixel CAT
// FACE (rounded ears, a face with two eyes, a chin) shown in the dashboard's
// top-right. renderMascot colors it with a vivid multi-stop gradient
// (mascotStops); the Update loop briefly swaps in splashMascotBlink to blink.
// Only shown when unicodeEnabled(). The header-height reservation
// (mascotExtraRows) is derived from len(splashMascot), so the row count is free
// to change without touching splitDims.
var splashMascot = []string{
	` ▟███▙ `,
	`███████`,
	`█ ▀ ▀ █`,
	` █▄▄▄█ `,
}

// splashMascotBlink is the "eyes closed" frame: identical to splashMascot except
// the open eyes (▀ ▀) drop to ▄ ▄, so briefly swapping to it reads as a blink.
// Same dimensions as splashMascot, so the layout never shifts mid-blink.
var splashMascotBlink = []string{
	` ▟███▙ `,
	`███████`,
	`█ ▄ ▄ █`,
	` █▄▄▄█ `,
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

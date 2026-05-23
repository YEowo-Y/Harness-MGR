package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// mascotColor is the warm amber used to render the mascot so it stands out
// from the teal→violet wordmark gradient.
var mascotColor = lipgloss.Color("#F59E0B")

// splashMascot is the small sparkle sprite rendered above the wordmark.
// Uses Unicode fullwidth/box-drawing glyphs; only shown when unicodeEnabled().
// Each line is individually centered to the sprite's own max width so the
// asymmetric arm widths still look symmetric.
var splashMascot = []string{
	` ＼ ✦ ／`,
	`( ◠ ‿ ◠ )`,
	` ╰─ ◡ ─╯`,
}

// splashBanner is the ASCII-art block for "claude-mgr", 7 rows tall, ≤64 columns.
// Each line is individually gradient-colored at render time.
var splashBanner = []string{
	` ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗`,
	`██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝`,
	`██║     ██║     ███████║██║   ██║██║  ██║█████╗  `,
	`██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  `,
	`╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗`,
	` ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`,
	`                    ── mgr ──                     `,
}

// splashStops are the brand gradient stops: teal → cyan → blue → violet.
var splashStops = []string{"#2DD4BF", "#22D3EE", "#3B82F6", "#A855F7"}

// splashTagline is the dim subtitle rendered below the banner.
const splashTagline = "Claude Code configuration governance · read-only"

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

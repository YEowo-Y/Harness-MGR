package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// mascotMosaic is the scattered pastel palette for the cat's body cells — the
// vibrant "炫彩" look; renderMascot hashes each body cell's (row, col) into it.
var mascotMosaic = []string{
	"#5EEAD4", "#F0ABFC", "#A78BFA", "#67E8F9", "#86EFAC", "#FDA4AF", "#93C5FD", "#F9A8D4",
}

// mascotCellColor maps a mascot grid cell KEY to its color: white eye (w), dark
// pupil / closed eye (k), brown nose (n), pink mouth (m), and a position-hashed
// mosaic color for every body cell (b and any other key).
func mascotCellColor(key rune, row, col int) lipgloss.Color {
	switch key {
	case 'w':
		return lipgloss.Color("#F8FAFC") // eye white
	case 'k':
		return lipgloss.Color("#1F2937") // pupil / closed eye
	case 'n':
		return lipgloss.Color("#7C3F1D") // brown nose
	case 'm':
		return lipgloss.Color("#F472B6") // pink mouth
	default: // body cell
		return lipgloss.Color(mascotMosaic[(row*7+col*13)%len(mascotMosaic)])
	}
}

// splashMascot is the corner pet's "eyes open" frame: a compact 6x9 SOLID-BLOCK
// CAT (pointy ears, white eyes (w) + dark pupils (k), a brown nose (n), a pink
// mouth (m), four legs, and a vibrant mosaic body) for the dashboard's top-right.
// Each cell is a color KEY drawn as █ by renderMascot via mascotCellColor; '.'
// is transparent. Only shown when unicodeEnabled(). The header-height
// reservation (mascotExtraRows) is derived from len(splashMascot).
var splashMascot = []string{
	`bb.....bb`,
	`bbbbbbbbb`,
	`bwkbbbkwb`,
	`bbbbnbbbb`,
	`bbbmmmbbb`,
	`.b.b.b.b.`,
}

// splashMascotBlink is the "eyes closed" frame: identical to splashMascot except
// the eye whites (w) go dark (k), so briefly swapping to it reads as a blink.
// Same dimensions as splashMascot, so the layout never shifts mid-blink.
var splashMascotBlink = []string{
	`bb.....bb`,
	`bbbbbbbbb`,
	`bkkbbbkkb`,
	`bbbbnbbbb`,
	`bbbmmmbbb`,
	`.b.b.b.b.`,
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

package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// mascotMosaic is the cool, calm multi-color palette for the cat's body cells:
// teal/cyan/sky/indigo/violet/green only — deliberately NO pinks or near-white,
// so the white eyes, hot-pink mouth, and warm-rust nose stay easy to read
// against it. renderMascot hashes each body cell's (row, col) into it.
var mascotMosaic = []string{
	"#2DD4BF", "#22D3EE", "#38BDF8", "#818CF8", "#A78BFA", "#34D399",
}

// mascotCellColor maps a mascot grid cell KEY to its color: white eye (w), dark
// pupil / closed eye (k), warm-rust nose (n), hot-pink mouth (m), and a
// position-hashed mosaic color for every body cell (b and any other key).
func mascotCellColor(key rune, row, col int) lipgloss.Color {
	switch key {
	case 'w':
		return lipgloss.Color("#FFFFFF") // eye white (max contrast)
	case 'k':
		return lipgloss.Color("#0F172A") // pupil / closed eye (near-black)
	case 'n':
		return lipgloss.Color("#C2410C") // warm-rust nose
	case 'm':
		return lipgloss.Color("#EC4899") // hot-pink mouth
	default: // body cell
		return lipgloss.Color(mascotMosaic[(row*7+col*13)%len(mascotMosaic)])
	}
}

// splashMascot is the corner pet's "eyes open" frame: a compact 5x7 SOLID-BLOCK
// CAT (ears, white eyes (w) + dark pupils (k), a warm-rust nose (n), a hot-pink
// mouth (m), four legs, and a cool mosaic body) for the dashboard's top-right.
// Each cell is a color KEY drawn as █ by renderMascot via mascotCellColor; '.'
// is transparent. Only shown when unicodeEnabled(). The header-height
// reservation (mascotExtraRows) is derived from len(splashMascot).
var splashMascot = []string{
	`bb...bb`,
	`bwkbkwb`,
	`bbbnbbb`,
	`bbmmmbb`,
	`b.b.b.b`,
}

// splashMascotBlink is the "eyes closed" frame: identical to splashMascot except
// the eye whites (w) go dark (k), so briefly swapping to it reads as a blink.
// Same dimensions as splashMascot, so the layout never shifts mid-blink.
var splashMascotBlink = []string{
	`bb...bb`,
	`bkkbkkb`,
	`bbbnbbb`,
	`bbmmmbb`,
	`b.b.b.b`,
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

// splashTagline is the dim subtitle rendered below the banner (English source;
// the splash renders it via tr("splash.tagline")). Also reused by the dormant
// header health lockup.
const splashTagline = "agent harness configuration governance · read-only"

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
	navStyle := lipgloss.NewStyle().Foreground(leaderDim)

	block := bannerBlock +
		"\n\n" + tagStyle.Render(tr("splash.tagline")) +
		"\n\n" + languagePicker() +
		"\n" + navStyle.Render(tr("splash.nav"))

	// Center the whole block in the terminal.
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, block)
}

// languagePicker renders the splash's two language options — the active one
// (uiLang, synced from the model in View) highlighted in the accent color with
// brackets, the other dim. Labels are the languages' own endonyms (English /
// 简体中文), shown untranslated so each is recognizable regardless of the
// current selection.
func languagePicker() string {
	active := lipgloss.NewStyle().Foreground(accent).Bold(true)
	dim := lipgloss.NewStyle().Foreground(configGray)
	opt := func(label string, on bool) string {
		if on {
			return active.Render("[ " + label + " ]")
		}
		return dim.Render("  " + label + "  ")
	}
	return opt("English", uiLang == langEN) + "   " + opt("简体中文", uiLang == langZH)
}

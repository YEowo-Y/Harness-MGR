package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── --mascot preview ────────────────────────────────────────────────────────
//
// The corner mascot's recognizability can only be judged from the REAL terminal
// render: a plain-text preview hides both the gradient (which bands the rows into
// colored stripes) and the terminal cell aspect ratio (~2:1 tall, which distorts
// proportions). The --mascot flag prints several cat-face candidates exactly as
// they would appear so the user can pick the clearest one. Preview-only; the
// chosen design becomes splashMascot.

// mascotCandidate is one cat-face design shown by --mascot.
type mascotCandidate struct {
	name  string
	frame []string
}

// mascotCandidates are the cat designs offered for comparison. The ASCII faces
// read as a cat instantly; the block face is the pixel style. All are kept short
// so they fit the dashboard's top-right corner.
var mascotCandidates = []mascotCandidate{
	{"1  kitty (ASCII)", []string{
		` /\_/\ `,
		`( o.o )`,
		` > ^ < `,
	}},
	{"2  whiskers (ASCII)", []string{
		` /\___/\ `,
		`=( o.o )=`,
		`  )   (  `,
	}},
	{"3  block, triangle ears", []string{
		`▲     ▲`,
		`███████`,
		`█ ● ● █`,
		` █▄▄▄█ `,
	}},
}

// catReplica is a best-effort terminal replica of the reference image: a
// colorful pixel cat with pointy ears, big golden eyes (◉ = iris + pupil), a
// pink nose (▾) and a faint smile (╰───╯). All rows are 11 columns wide.
var catReplica = []string{
	` █▙     ▟█ `,
	`███████████`,
	`██ ◉   ◉ ██`,
	`███████████`,
	`████ ▾ ████`,
	`██ ╰───╯ ██`,
	` █████████ `,
}

// catMosaic is the scattered pastel palette for the cat's body cells, giving the
// reference image's multi-color "mosaic" look (vs. a single hue or row bands).
var catMosaic = []string{
	"#5EEAD4", "#F0ABFC", "#A78BFA", "#67E8F9", "#86EFAC", "#FDA4AF", "#93C5FD", "#F9A8D4",
}

// pixelCatColor picks a cell's color: golden eyes, pink nose, dim smile, and a
// position-hashed pastel for every body cell (the mosaic). The (row*7+col*13)
// hash scatters colors so the body doesn't band into stripes.
func pixelCatColor(r rune, row, col int) lipgloss.Color {
	switch r {
	case '◉':
		return lipgloss.Color("#FCD34D") // golden eye
	case '▾':
		return lipgloss.Color("#FB7185") // pink nose
	case '╰', '─', '╯':
		return lipgloss.Color("#334155") // faint smile
	default:
		return lipgloss.Color(catMosaic[(row*7+col*13)%len(catMosaic)])
	}
}

// renderPixelCat colors each non-space cell of rows individually (per-cell
// mosaic + special eyes/nose/mouth), the technique needed to approximate the
// reference image. Spaces stay transparent.
func renderPixelCat(rows []string) string {
	out := make([]string, len(rows))
	for row, line := range rows {
		var b strings.Builder
		col := 0
		for _, r := range line {
			if r == ' ' {
				b.WriteRune(' ')
			} else {
				b.WriteString(lipgloss.NewStyle().Foreground(pixelCatColor(r, row, col)).Render(string(r)))
			}
			col++ // tracks the visual column (spaces count) so the mosaic stays stable
		}
		out[row] = b.String()
	}
	return strings.Join(out, "\n")
}

// colorCat is a vibrant SOLID-BLOCK cat replicating the chunky reference image,
// kept compact (6 rows x 9 cols) for the corner: pointy ears, white eyes (w)
// with black pupils (k), a brown nose (n), a pink mouth (m), four legs, and a
// multicolor "炫彩" mosaic body (b). Each cell is a color KEY (rendered as █);
// '.' is transparent.
var colorCat = []string{
	`bb.....bb`,
	`bbbbbbbbb`,
	`bwkbbbkwb`,
	`bbbbnbbbb`,
	`bbbmmmbbb`,
	`.b.b.b.b.`,
}

// colorCatKey maps a colorCat cell key to its color: peach inner ear, white eye,
// black pupil, brown nose, pink mouth, and a position-hashed mosaic for the body.
func colorCatKey(key rune, row, col int) lipgloss.Color {
	switch key {
	case 'i':
		return lipgloss.Color("#FDD9B5") // peach inner ear
	case 'w':
		return lipgloss.Color("#F8FAFC") // eye white
	case 'k':
		return lipgloss.Color("#1F2937") // pupil
	case 'n':
		return lipgloss.Color("#7C3F1D") // brown nose
	case 'm':
		return lipgloss.Color("#F472B6") // pink mouth
	default: // 'b' body → vibrant mosaic
		return lipgloss.Color(catMosaic[(row*7+col*13)%len(catMosaic)])
	}
}

// renderColorCat renders a color-keyed grid as solid █ blocks (each in its key's
// color); '.' / space cells stay transparent.
func renderColorCat(rows []string) string {
	out := make([]string, len(rows))
	for row, line := range rows {
		var b strings.Builder
		col := 0
		for _, key := range line {
			if key == '.' || key == ' ' {
				b.WriteRune(' ')
			} else {
				b.WriteString(lipgloss.NewStyle().Foreground(colorCatKey(key, row, col)).Render("█"))
			}
			col++
		}
		out[row] = b.String()
	}
	return strings.Join(out, "\n")
}

// renderMascotFrame renders frame lines centered to the block's max width. When
// grad is true it applies the vertical multi-stop gradient (the same scheme as
// renderMascot); otherwise it uses a single solid mascotColor — so the preview
// can contrast the multicolor look against a clearer single-color silhouette.
func renderMascotFrame(frame []string, grad bool) string {
	w := 0
	for _, line := range frame {
		if n := lipgloss.Width(line); n > w {
			w = n
		}
	}
	center := lipgloss.NewStyle().Width(w).Align(lipgloss.Center)
	cols, ok := parseStops(mascotStops)
	rows := len(frame)
	lines := make([]string, rows)
	for i, line := range frame {
		fg := mascotColor
		if grad && ok {
			fg = lipgloss.Color(stopColorAt(cols, len(cols)-1, fraction(i, rows)).Hex())
		}
		lines[i] = lipgloss.NewStyle().Foreground(fg).Render(center.Render(line))
	}
	return strings.Join(lines, "\n")
}

// mascotPreviewView renders every candidate twice — once in the multicolor
// gradient, once in a single coral — so the user can judge both the shape and
// whether the rainbow banding is what hurts recognizability.
func mascotPreviewView() string {
	head := lipgloss.NewStyle().Bold(true).Foreground(accent)
	label := lipgloss.NewStyle().Foreground(configGray)

	var b strings.Builder
	b.WriteString(head.Render("Cat mascot candidates — run in a real terminal for color") + "\n\n")

	b.WriteString(head.Render("vibrant block cat (replicates the new image):") + "\n\n")
	b.WriteString(renderColorCat(colorCat) + "\n\n")

	b.WriteString(head.Render("replica attempt (per-cell pixel cat):") + "\n\n")
	b.WriteString(renderPixelCat(catReplica) + "\n\n")

	b.WriteString(head.Render("multicolor gradient:") + "\n\n")
	for _, c := range mascotCandidates {
		b.WriteString(label.Render(c.name) + "\n")
		b.WriteString(renderMascotFrame(c.frame, true) + "\n\n")
	}

	b.WriteString(head.Render("single color (clearer silhouette?):") + "\n\n")
	for _, c := range mascotCandidates {
		b.WriteString(label.Render(c.name) + "\n")
		b.WriteString(renderMascotFrame(c.frame, false) + "\n\n")
	}
	return b.String()
}

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

package main

import "strings"

// iconCandidate pairs a type label with two zero-dependency icon options — a
// color emoji (native in Windows Terminal, but double-width) and a single-width
// Unicode geometric symbol. The --icons render test prints both sets so the user
// can pick whichever displays and aligns best in their own terminal.
type iconCandidate struct {
	label  string
	emoji  string
	symbol string
}

// iconCandidates maps each object type to its emoji and symbol candidate.
var iconCandidates = []iconCandidate{
	{"Skills", "🧩", "◆"},
	{"Agents", "🤖", "●"},
	{"Commands", "⚡", "▸"},
	{"Plugins", "🔌", "✦"},
	{"Marketplaces", "🏪", "■"},
	{"MCP", "🔗", "◇"},
}

// iconsTestView renders the two candidate icon sets as stacked blocks so the user
// can see, in their own terminal, which glyphs display (not tofu boxes) and how
// they align. Printed headlessly by the --icons flag; plain text, never panics.
func iconsTestView() string {
	var b strings.Builder
	b.WriteString("Icon render test — which set displays + aligns best in YOUR terminal?\n")
	b.WriteString("(emoji are colorful but double-width; symbols are single-width, plainer)\n\n")

	b.WriteString("── EMOJI set ──\n")
	for _, ic := range iconCandidates {
		b.WriteString("   " + ic.emoji + "  " + ic.label + "\n")
	}

	b.WriteString("\n── SYMBOL set ──\n")
	for _, ic := range iconCandidates {
		b.WriteString("   " + ic.symbol + "  " + ic.label + "\n")
	}

	b.WriteString("\nTell me: (1) do all 6 emoji show (no boxes)?  (2) which set looks better?\n")
	return b.String()
}

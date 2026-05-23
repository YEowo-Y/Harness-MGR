package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── Section-tab helpers ────────────────────────────────────────────────────────
//
// tabs.go owns the functions specific to the flat-list "section" tabs
// (Conflicts and Orphans). It converts engine data into sectionItems, renders
// the split-pane view, and provides the summary bar that mirrors countsBarView
// on the Inventory tab.

// isSectionView reports whether v is one of the flat-list section tabs.
// Extend this list when new section tabs are added.
func isSectionView(v viewID) bool {
	return v == viewConflicts || v == viewOrphans ||
		v == viewConfig || v == viewHooks || v == viewSelftest
}

// ── Conflicts ────────────────────────────────────────────────────────────────

// conflictItems converts a ConflictCluster slice into sectionItems for the
// Conflicts list. One item per cluster; the title is "kind: key". The color
// follows the per-kind palette used by the tree widget. The detail func is
// called at render time with the live pane width.
func conflictItems(cs []ConflictCluster) []sectionItem {
	items := make([]sectionItem, 0, len(cs))
	for _, c := range cs {
		c := c // shadow for closure capture
		iconStr := glyph(typeIcon(c.Kind), "")
		prefix := ""
		if iconStr != "" {
			prefix = iconStr + " "
		}
		items = append(items, sectionItem{
			title:  prefix + fmt.Sprintf("%s: %s", c.Kind, c.Key),
			color:  conflictColor(c.Kind),
			detail: func(w int) string { return conflictDetail(c, w) },
		})
	}
	return items
}

// conflictColor maps a conflict kind string to a palette color. Unknown kinds
// fall back to labelGray so the UI never shows an uncolored row.
func conflictColor(kind string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "skill":
		return colorSkill
	case "agent":
		return colorAgent
	case "command":
		return colorCommand
	default:
		return labelGray
	}
}

// conflictDetail builds the detail body for a ConflictCluster at the given
// pane width. Uses the same detailTitle / detailField helpers as the inventory
// detail panes so the visual language is consistent.
func conflictDetail(c ConflictCluster, width int) string {
	fg := conflictColor(c.Kind)

	var b strings.Builder
	b.WriteString(detailTitle(c.Key, fg, typeIcon(c.Kind), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Classification", fg, width))
	b.WriteString(detailField("Kind", c.Kind, width))
	b.WriteString(detailField("Confidence", c.Confidence, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Resolution", fg, width))
	winnerDesc := c.LikelyWinner.Name
	if src := sourceSummary(c.LikelyWinner.Source); src != "" && src != "—" {
		winnerDesc += " (" + src + ")"
	}
	b.WriteString(detailField("Likely winner", winnerDesc, width))

	names := make([]string, 0, len(c.PossibleWinners))
	for _, pw := range c.PossibleWinners {
		names = append(names, pw.Name)
	}
	b.WriteString(detailField("Possible winners", strings.Join(names, ", "), width))

	b.WriteString("\n")
	b.WriteString(detailSection("Explanation", fg, width))
	b.WriteString(detailField("Reason", c.Reason, width))
	b.WriteString(detailField("Fix", c.Fix, width))
	return b.String()
}

// ── Orphans ─────────────────────────────────────────────────────────────────

// orphanItems converts an OrphansResult into sectionItems for the Orphans list.
// One item per orphan; hard orphans are red, soft orphans are amber (colorCommand),
// anything else falls back to labelGray.
func orphanItems(r OrphansResult) []sectionItem {
	items := make([]sectionItem, 0, len(r.Orphans))
	for _, o := range r.Orphans {
		o := o // shadow for closure capture
		items = append(items, sectionItem{
			title:  o.Name,
			color:  orphanColor(o.Category),
			detail: func(w int) string { return orphanDetail(o, w) },
		})
	}
	return items
}

// orphanColor maps an orphan category to a palette color.
func orphanColor(category string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(category)) {
	case "hard":
		return colorRed
	case "soft":
		return colorCommand // amber
	default:
		return labelGray
	}
}

// orphanDetail builds the detail body for an Orphan at the given pane width.
func orphanDetail(o Orphan, width int) string {
	fg := orphanColor(o.Category)

	var b strings.Builder
	b.WriteString(detailTitle(o.Name, fg, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Classification", fg, width))
	b.WriteString(detailField("Category", o.Category, width))
	b.WriteString(detailField("Entry type", o.EntryType, width))
	b.WriteString(detailField("Container", o.Container, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Explanation", fg, width))
	b.WriteString(detailField("Reason", o.Reason, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Location", fg, width))
	b.WriteString(detailField("Path", o.Path, width))
	return b.String()
}

// ── Split-pane view ──────────────────────────────────────────────────────────

// sectionSplitView mirrors inventorySplitView for the section tabs. The left
// pane shows the active section's flat list; the right pane shows the detail
// viewport. Focus border follows m.focus exactly as on the Inventory tab.
func sectionSplitView(m model) string {
	listW, detailW, boxH := m.splitDims()

	left := paneBorderStyle(m.focus == focusTree, listW, boxH).
		Render(sectionListBody(m))
	right := paneBorderStyle(m.focus == focusDetail, detailW, boxH).
		Render(sectionDetailBody(m))

	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

// sectionListBody renders the left-pane inner content for a section tab:
// spinner while loading, error text on failure, an empty-state hint when the
// list has no items, or the rendered section list.
func sectionListBody(m model) string {
	st := m.sections[m.currentView]
	if st == nil {
		return detailEmptyStyle.Render("section not initialized")
	}
	switch {
	case st.loading:
		return m.spinner.View() + " " + configStyle.Render("loading…")
	case st.err != nil:
		return lipgloss.NewStyle().Foreground(colorRed).
			Render(glyph("✗", "[x]")+" load failed") + "\n\n" +
			configStyle.Render(truncate(st.err.Error(), m.treeInnerW))
	case len(st.list.items) == 0:
		return detailEmptyStyle.Render(sectionEmptyLabel(m.currentView))
	default:
		return st.list.render(m.treeInnerW, m.treeInnerH)
	}
}

// sectionDetailBody renders the right-pane inner content for a section tab:
// mirrors the empty/loading/error fallbacks of detailPaneBody, then shows the
// viewport.
func sectionDetailBody(m model) string {
	st := m.sections[m.currentView]
	if st == nil {
		return detailEmptyStyle.Render("—")
	}
	switch {
	case st.loading:
		return detailEmptyStyle.Render("…")
	case st.err != nil:
		return detailEmptyStyle.Render("—")
	case len(st.list.items) == 0:
		return detailEmptyStyle.Render("select an item on the left")
	default:
		return m.detail.View()
	}
}

// sectionEmptyLabel returns the empty-state message for each section view.
func sectionEmptyLabel(v viewID) string {
	switch v {
	case viewConflicts:
		return "no conflicts found"
	case viewOrphans:
		return "no orphans found"
	case viewConfig:
		return "no config keys found"
	case viewHooks:
		return "no hooks found"
	case viewSelftest:
		return "no checks found"
	default:
		return "no items found"
	}
}

// ── Config ───────────────────────────────────────────────────────────────────

// configItems converts a ConfigResult into sectionItems for the Config list.
// One item per key, sorted by key name (map order is random). Color reflects
// mergeConfidence: "known"→colorPlugin (green), "unknown"→colorCommand (amber),
// else labelGray. The detail shows merge confidence, strategy, and one row per
// perLayer entry with a compact JSON value.
func configItems(r ConfigResult) []sectionItem {
	keys := make([]string, 0, len(r.Keys))
	for k := range r.Keys {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	items := make([]sectionItem, 0, len(keys))
	for _, k := range keys {
		ck := r.Keys[k] // loop-local; safe to capture in closure (go1.26 per-iteration vars)
		items = append(items, sectionItem{
			title:  k,
			color:  configKeyColor(ck.MergeConfidence),
			detail: func(w int) string { return configDetail(ck, w) },
		})
	}
	return items
}

// configKeyColor maps a mergeConfidence string to a palette color.
func configKeyColor(confidence string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(confidence)) {
	case "known":
		return colorPlugin // green
	case "unknown":
		return colorCommand // amber
	default:
		return labelGray
	}
}

// configDetail builds the detail body for a ConfigKey at the given pane width.
// Per-layer values are compacted to a single JSON line before truncation so
// objects render as {"key":"val"} rather than multi-line indented blocks.
func configDetail(ck ConfigKey, width int) string {
	fg := configKeyColor(ck.MergeConfidence)

	var b strings.Builder
	b.WriteString(detailTitle(ck.Key, fg, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Merge", fg, width))
	b.WriteString(detailField("Merge confidence", ck.MergeConfidence, width))
	b.WriteString(detailField("Strategy", ck.Strategy, width))

	if len(ck.PerLayer) > 0 {
		b.WriteString("\n")
		b.WriteString(detailSection("Layers", fg, width))
		for _, layer := range ck.PerLayer {
			v := strings.TrimSpace(string(layer.Value))
			var buf bytes.Buffer
			if err := json.Compact(&buf, layer.Value); err == nil && buf.Len() > 0 {
				v = buf.String()
			}
			b.WriteString(detailField("Layer "+layer.Name, v, width))
		}
	}
	return b.String()
}

// ── Hooks ────────────────────────────────────────────────────────────────────

// hooksItems converts a HooksResult into sectionItems for the Hooks list.
// One item per event, sorted by event name. The title includes the entry count.
// Color is accent (teal). The detail lists matchers and commands per entry.
func hooksItems(r HooksResult) []sectionItem {
	events := make([]string, 0, len(r.Hooks))
	for e := range r.Hooks {
		events = append(events, e)
	}
	sort.Strings(events)

	items := make([]sectionItem, 0, len(events))
	for _, e := range events {
		e := e // shadow for closure capture
		entries := r.Hooks[e]
		items = append(items, sectionItem{
			title:  fmt.Sprintf("%s (%d)", e, len(entries)),
			color:  accent,
			detail: func(w int) string { return hooksDetail(e, entries, w) },
		})
	}
	return items
}

// hooksDetail builds the detail body for a hook event at the given pane width.
func hooksDetail(event string, entries []HookEntry, width int) string {
	var b strings.Builder
	b.WriteString(detailTitle(event, accent, "", width))
	b.WriteString("\n\n")
	for i, entry := range entries {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(detailSection(fmt.Sprintf("Binding %d", i+1), accent, width))
		if entry.Matcher != "" {
			b.WriteString(detailField("Matcher", entry.Matcher, width))
		}
		for _, cmd := range entry.Hooks {
			b.WriteString(detailField("Command", cmd.Command, width))
		}
	}
	return b.String()
}

// ── Selftest ─────────────────────────────────────────────────────────────────

// selftestItems converts a SelftestResult into sectionItems for the Selftest
// list. One item per check. Passing checks are green (colorPlugin); failing
// checks are red (colorRed). The detail shows the check name and status.
func selftestItems(r SelftestResult) []sectionItem {
	items := make([]sectionItem, 0, len(r.Checks))
	for _, ch := range r.Checks {
		ch := ch // shadow for closure capture
		var title string
		var color lipgloss.Color
		if ch.Ok {
			title = glyph("✓", "[ok]") + " " + ch.Name
			color = colorPlugin // green
		} else {
			title = glyph("✗", "[x]") + " " + ch.Name
			color = colorRed
		}
		items = append(items, sectionItem{
			title:  title,
			color:  color,
			detail: func(w int) string { return selftestDetail(ch, w) },
		})
	}
	return items
}

// selftestDetail builds the detail body for a SelftestCheck at the given pane width.
func selftestDetail(ch SelftestCheck, width int) string {
	color := colorPlugin
	if !ch.Ok {
		color = colorRed
	}
	status := "ok"
	if !ch.Ok {
		status = "failing"
	}

	var b strings.Builder
	b.WriteString(detailTitle(ch.Name, color, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Result", color, width))
	b.WriteString(detailField("Status", status, width))
	return b.String()
}

// sectionSummaryBar renders a one-line header for the active section tab —
// the tab label plus a summary string (e.g. "3 conflicts" or "2 hard · 0 soft"),
// padded to the terminal width. Mirrors the countsBarView style: Padding(0,1)
// with a fixed Width when known.
func sectionSummaryBar(view viewID, st *sectionState, termWidth int) string {
	label := tabLabels[int(view)]
	text := label
	if st != nil && st.summary != "" {
		sep := lipgloss.NewStyle().Foreground(leaderDim).Render("   ")
		text = lipgloss.NewStyle().Bold(true).Foreground(accent).Render(label) +
			sep +
			lipgloss.NewStyle().Foreground(labelGray).Render(st.summary)
	} else {
		text = lipgloss.NewStyle().Bold(true).Foreground(accent).Render(label)
	}

	style := lipgloss.NewStyle().Padding(0, 1)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(text)
}

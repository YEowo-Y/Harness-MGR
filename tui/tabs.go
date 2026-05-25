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
		v == viewConfig || v == viewHooks || v == viewSelftest ||
		v == viewDoctor
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
	if s := strings.TrimSpace(c.Severity); s != "" {
		b.WriteString(detailField("Severity", s, width))
	}

	b.WriteString("\n")
	b.WriteString(detailSection("Resolution", fg, width))
	winnerDesc := c.LikelyWinner.Name
	if src := sourceSummary(c.LikelyWinner.Source); src != "" && src != "—" {
		winnerDesc += " (" + src + ")"
	}
	b.WriteString(detailField("Likely winner", winnerDesc, width))
	if p := strings.TrimSpace(c.LikelyWinner.Path); p != "" {
		b.WriteString(detailField("Winner path", p, width))
	}

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
// One item per orphan; hard orphans are orange, soft orphans are amber (colorCommand),
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
		return colorOrange
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
		return detailEmptyStyle.Render(tr("section.uninitialized"))
	}
	switch {
	case st.loading:
		return m.spinner.View() + " " + configStyle.Render(tr("loading.generic"))
	case st.err != nil:
		return lipgloss.NewStyle().Foreground(colorRed).
			Render(glyph("✗", "[x]")+" "+tr("loading.failed")) + "\n\n" +
			configStyle.Render(truncate(st.err.Error(), m.treeInnerW))
	case len(st.list.filtered()) == 0:
		// Filter-aware: a 0-match filter shows "no matches" (not the data-empty
		// label), and never falls through to render() which would be blank.
		if st.list.filter != "" {
			return detailEmptyStyle.Render(tr("empty.noMatch"))
		}
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
		return detailEmptyStyle.Render(tr("empty.selectItemLeft"))
	default:
		return m.detail.View()
	}
}

// sectionEmptyLabel returns the empty-state message for each section view.
func sectionEmptyLabel(v viewID) string {
	switch v {
	case viewConflicts:
		return tr("empty.conflicts")
	case viewOrphans:
		return tr("empty.orphans")
	case viewConfig:
		return tr("empty.config")
	case viewHooks:
		return tr("empty.hooks")
	case viewSelftest:
		return tr("empty.selftest")
	case viewDoctor:
		return tr("empty.doctor")
	default:
		return tr("empty.items")
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
			if t := strings.TrimSpace(cmd.Type); t != "" {
				b.WriteString(detailField("Type", t, width))
			}
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

// ── Doctor ───────────────────────────────────────────────────────────────────

// doctorSeverity is the resolved health state of a single doctor check, derived
// by joining the check to the diagnostics it produced (by Code). It orders the
// row's color + icon: error (worst) → warn → info/finding → ok → skipped.
type doctorSeverity int

const (
	doctorSkipped doctorSeverity = iota // active check not run in the passive pass
	doctorOk                            // ran, zero findings
	doctorInfo                          // findings present, no error/warn diagnostic
	doctorWarn                          // a warn diagnostic
	doctorError                         // an error diagnostic
)

// doctorCheckDiags returns the diagnostics whose Code matches the check's Code —
// the join that recovers a check's findings (severity + message + fix) from the
// flat top-level diagnostics array.
func doctorCheckDiags(code string, diags []Diagnostic) []Diagnostic {
	out := make([]Diagnostic, 0, len(diags))
	for _, d := range diags {
		if d.Code == code {
			out = append(out, d)
		}
	}
	return out
}

// resolveDoctorSeverity classifies one check. The diagnostic severities (error /
// warn) win over the findings count, which wins over the ran/ok facts: a check
// can report findings>0 whose matching diagnostics are info-level (or carry no
// matching diagnostic at all), so findings alone only reach doctorInfo. An active
// check skipped in the passive run (ran=false) is doctorSkipped, distinct from a
// genuine clean pass (doctorOk).
func resolveDoctorSeverity(ch DoctorCheck, diags []Diagnostic) doctorSeverity {
	hasWarn := false
	for _, d := range doctorCheckDiags(ch.Code, diags) {
		switch strings.ToLower(strings.TrimSpace(d.Severity)) {
		case "error":
			return doctorError
		case "warn", "warning":
			hasWarn = true
		}
	}
	if hasWarn {
		return doctorWarn
	}
	if ch.Findings > 0 {
		return doctorInfo
	}
	if !ch.Ran {
		return doctorSkipped
	}
	return doctorOk
}

// doctorColor maps a resolved severity to a palette color: error→colorRed,
// warn→colorOrange (amber), info→accent (teal), ok→colorPlugin (green),
// skipped→labelGray.
func doctorColor(sev doctorSeverity) lipgloss.Color {
	switch sev {
	case doctorError:
		return colorRed
	case doctorWarn:
		return colorOrange
	case doctorInfo:
		return accent
	case doctorOk:
		return colorPlugin
	default:
		return labelGray
	}
}

// doctorIcon maps a resolved severity to its status glyph (with an ASCII fallback
// for no-Unicode terminals): error ✗, warn ⚠, info •, ok ✓, skipped ○.
func doctorIcon(sev doctorSeverity) string {
	switch sev {
	case doctorError:
		return glyph("✗", "[x]")
	case doctorWarn:
		return glyph("⚠", "[!]")
	case doctorInfo:
		return glyph("•", "*")
	case doctorOk:
		return glyph("✓", "[ok]")
	default:
		return glyph("○", "[ ]")
	}
}

// doctorItems converts a DoctorReport into sectionItems for the Doctor list, one
// row per check in the engine's emitted order. Each row's color + icon reflect the
// check's resolved severity (joined to its diagnostics by Code); the title is
// "<icon> #<id> <code>" plus " · <findings>" when the check produced any.
func doctorItems(report DoctorReport) []sectionItem {
	items := make([]sectionItem, 0, len(report.Checks))
	for _, ch := range report.Checks {
		ch := ch // shadow for closure capture
		sev := resolveDoctorSeverity(ch, report.Diagnostics)
		title := fmt.Sprintf("%s #%d %s", doctorIcon(sev), ch.ID, ch.Code)
		if ch.Findings > 0 {
			title += fmt.Sprintf(" · %d", ch.Findings)
		}
		diags := doctorCheckDiags(ch.Code, report.Diagnostics)
		items = append(items, sectionItem{
			title:  title,
			color:  doctorColor(sev),
			detail: func(w int) string { return doctorDetail(ch, diags, w) },
		})
	}
	return items
}

// doctorDetail builds the detail body for a doctor check at the given pane width.
// It mirrors selftestDetail's shape (title + Result section) then adds a Findings
// section listing each matching diagnostic's severity + message (+ fix when set).
// A clean / skipped check says so in place of the findings list.
func doctorDetail(ch DoctorCheck, diags []Diagnostic, width int) string {
	sev := resolveDoctorSeverity(ch, diags)
	fg := doctorColor(sev)

	status := "ok — no findings"
	switch {
	case sev == doctorSkipped:
		status = "skipped (active probe, not run)"
	case ch.Findings == 1:
		status = "1 finding"
	case ch.Findings > 1:
		status = fmt.Sprintf("%d findings", ch.Findings)
	}

	var b strings.Builder
	b.WriteString(detailTitle(ch.Code, fg, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Result", fg, width))
	b.WriteString(detailField("Status", status, width))
	b.WriteString(detailField("Probe level", ch.ProbeLevel, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Findings", fg, width))
	if len(diags) == 0 {
		if sev == doctorSkipped {
			b.WriteString(detailField("—", "active probe skipped in passive run", width))
		} else {
			b.WriteString(detailField("—", "passed — no findings", width))
		}
		return b.String()
	}
	for i, d := range diags {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(detailField("Severity", d.Severity, width))
		b.WriteString(detailField("Message", d.Message, width))
		if fix := strings.TrimSpace(d.Fix); fix != "" {
			b.WriteString(detailField("Fix", fix, width))
		}
	}
	return b.String()
}

// sectionSummaryBar renders a one-line header for the active section tab —
// the tab label plus a summary string (e.g. "3 conflicts" or "2 hard · 0 soft"),
// padded to the terminal width. Mirrors the countsBarView style: Padding(0,1)
// with a fixed Width when known.
func sectionSummaryBar(view viewID, st *sectionState, termWidth int) string {
	label := tabLabel(view)
	summary := st.summaryText()
	text := label
	if summary != "" {
		sep := lipgloss.NewStyle().Foreground(leaderDim).Render("   ")
		text = lipgloss.NewStyle().Bold(true).Foreground(accent).Render(label) +
			sep +
			lipgloss.NewStyle().Foreground(labelGray).Render(summary)
	} else {
		text = lipgloss.NewStyle().Bold(true).Foreground(accent).Render(label)
	}

	style := lipgloss.NewStyle().Padding(0, 1)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(text)
}

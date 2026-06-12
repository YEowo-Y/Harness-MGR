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
		v == viewDoctor || v == viewPermissions ||
		v == viewDrift || v == viewAudit || v == viewHealth ||
		v == viewDispositions
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
		if m.treeInnerH < 2 || m.treeInnerW < 2 {
			return st.list.render(m.treeInnerW, m.treeInnerH)
		}
		contentH := m.treeInnerH - 1
		s := st.list.render(m.treeInnerW-1, contentH)
		total := len(st.list.filtered())
		return composeListWithScrollbar(s, m.treeInnerW, m.treeInnerH,
			total, contentH, st.list.offset, st.list.cursor)
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
	case viewPermissions:
		return tr("empty.permissions")
	case viewDrift:
		return tr("empty.drift")
	case viewAudit:
		return tr("empty.audit")
	case viewHealth:
		return tr("empty.health")
	case viewDispositions:
		return tr("empty.dispositions")
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
		return colorMcp
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

// ── Permissions ───────────────────────────────────────────────────────────────

// permissionsCategory classifies a rule string into one of three display
// categories used by the Permissions tab: "allow-overbroad" (allow + wildcard),
// "allow", "ask", or "deny". The category drives the row color and icon.
type permissionsCategory int

const (
	permCategoryAllow          permissionsCategory = iota
	permCategoryAllowOverbroad                     // allow + wildcard (*)
	permCategoryAsk
	permCategoryDeny
)

// permissionsColor maps a category to a palette color: overbroad-allow→colorRed,
// normal-allow→colorPlugin (green), ask→colorOrange (amber), deny→labelGray.
func permissionsColor(cat permissionsCategory) lipgloss.Color {
	switch cat {
	case permCategoryAllowOverbroad:
		return colorRed
	case permCategoryAllow:
		return colorPlugin // green
	case permCategoryAsk:
		return colorOrange
	default:
		return labelGray
	}
}

// permissionsIcon maps a category to its status glyph (with ASCII fallback).
// overbroad-allow ⚠, normal-allow ✓, ask •, deny ○.
func permissionsIcon(cat permissionsCategory) string {
	switch cat {
	case permCategoryAllowOverbroad:
		return glyph("⚠", "[!]")
	case permCategoryAllow:
		return glyph("✓", "[ok]")
	case permCategoryAsk:
		return glyph("•", "*")
	default:
		return glyph("○", "[ ]")
	}
}

// permissionsItems converts a PermissionsResult into sectionItems for the
// Permissions list. Rows are grouped: overbroad-allow first (red/⚠), then
// normal-allow (green/✓), then ask (amber/•), then deny (gray/○). Within each
// group rules appear in the order returned by the CLI (already sorted). The
// title is "<icon> <category> · <rule>".
func permissionsItems(r PermissionsResult) []sectionItem {
	// Build an overbroad lookup set for fast membership test.
	overbroadSet := make(map[string]bool, len(r.Overbroad))
	for _, rule := range r.Overbroad {
		overbroadSet[rule] = true
	}

	items := make([]sectionItem, 0, len(r.Allow)+len(r.Ask)+len(r.Deny))

	// Overbroad allow first, then normal allow.
	for _, rule := range r.Allow {
		rule := rule
		var cat permissionsCategory
		if overbroadSet[rule] {
			cat = permCategoryAllowOverbroad
		} else {
			cat = permCategoryAllow
		}
		title := fmt.Sprintf("%s allow · %s", permissionsIcon(cat), rule)
		items = append(items, sectionItem{
			title:  title,
			color:  permissionsColor(cat),
			detail: func(w int) string { return permissionsDetail(rule, cat, r.Diagnostics, w) },
		})
	}
	for _, rule := range r.Ask {
		rule := rule
		title := fmt.Sprintf("%s ask · %s", permissionsIcon(permCategoryAsk), rule)
		items = append(items, sectionItem{
			title: title,
			color: permissionsColor(permCategoryAsk),
			detail: func(w int) string {
				return permissionsDetail(rule, permCategoryAsk, r.Diagnostics, w)
			},
		})
	}
	for _, rule := range r.Deny {
		rule := rule
		title := fmt.Sprintf("%s deny · %s", permissionsIcon(permCategoryDeny), rule)
		items = append(items, sectionItem{
			title: title,
			color: permissionsColor(permCategoryDeny),
			detail: func(w int) string {
				return permissionsDetail(rule, permCategoryDeny, r.Diagnostics, w)
			},
		})
	}
	return items
}

// permissionsDetail builds the detail body for one permission rule at the given
// pane width. The "Permission" section shows the category and whether the rule
// is overbroad. A "Why" section lists any top-level diagnostics whose Message
// contains the rule string (the engine's `permissions-overbroad` diagnostics
// embed the offending rule in their message).
func permissionsDetail(rule string, cat permissionsCategory, diags []Diagnostic, width int) string {
	fg := permissionsColor(cat)

	categoryLabel := "allow"
	switch cat {
	case permCategoryAllowOverbroad:
		categoryLabel = "allow"
	case permCategoryAsk:
		categoryLabel = "ask"
	case permCategoryDeny:
		categoryLabel = "deny"
	}

	overbroad := "no"
	if cat == permCategoryAllowOverbroad {
		overbroad = "yes — contains wildcard (*)"
	}

	var b strings.Builder
	b.WriteString(detailTitle(rule, fg, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Permission", fg, width))
	b.WriteString(detailField("Category", categoryLabel, width))
	b.WriteString(detailField("Overbroad", overbroad, width))

	// Collect diagnostics whose message mentions this rule. The rule is wrapped in
	// double-quotes in the diagnostic message (e.g. `...rule: "Edit(*)"`) so we
	// match the quoted form to prevent a prefix false-match: `Edit(*)` must NOT
	// match the `NotebookEdit(*)` diagnostic because `k"` != `"`.
	needle := `"` + rule + `"`
	var matching []Diagnostic
	for _, d := range diags {
		if strings.Contains(d.Message, needle) {
			matching = append(matching, d)
		}
	}
	if len(matching) > 0 {
		b.WriteString("\n")
		b.WriteString(detailSection("Why", fg, width))
		for i, d := range matching {
			if i > 0 {
				b.WriteString("\n")
			}
			b.WriteString(detailField("Severity", d.Severity, width))
			b.WriteString(detailField("Message", d.Message, width))
			if fix := strings.TrimSpace(d.Fix); fix != "" {
				b.WriteString(detailField("Fix", fix, width))
			}
		}
	}
	return b.String()
}

// ── Drift ──────────────────────────────────────────────────────────────────

// driftChangeColor maps a drift change kind to a palette color: added→green,
// removed→red, modified→orange. Unknown kinds fall back to labelGray.
func driftChangeColor(change string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(change)) {
	case "added":
		return colorPlugin // green
	case "removed":
		return colorRed
	case "modified":
		return colorOrange
	default:
		return labelGray
	}
}

// driftIcon maps a drift change kind to its diff glyph (ASCII fallback):
// added +, removed − (U+2212), modified ~.
func driftIcon(change string) string {
	switch strings.ToLower(strings.TrimSpace(change)) {
	case "added":
		return glyph("+", "+")
	case "removed":
		return glyph("−", "-")
	case "modified":
		return glyph("~", "~")
	default:
		return glyph("•", "*")
	}
}

// driftItems converts a DriftResult into sectionItems for the Drift list, one row
// per changed file in the engine's path-sorted order. The row color + icon reflect
// the change kind; the title is "<icon> <path>". An empty change list (clean /
// no-baseline) yields no rows — the summary bar carries that status instead.
func driftItems(r DriftResult) []sectionItem {
	items := make([]sectionItem, 0, len(r.Changes))
	for _, c := range r.Changes {
		c := c // shadow for closure capture
		items = append(items, sectionItem{
			title:  fmt.Sprintf("%s %s", driftIcon(c.Change), c.Path),
			color:  driftChangeColor(c.Change),
			detail: func(w int) string { return driftDetail(c, w) },
		})
	}
	return items
}

// driftDetail builds the detail body for one DriftChange at the given pane width.
func driftDetail(c DriftChange, width int) string {
	fg := driftChangeColor(c.Change)

	var b strings.Builder
	b.WriteString(detailTitle(c.Path, fg, "", width))
	b.WriteString("\n\n")

	b.WriteString(detailSection("Change", fg, width))
	b.WriteString(detailField("Kind", c.Change, width))

	b.WriteString("\n")
	b.WriteString(detailSection("Location", fg, width))
	b.WriteString(detailField("Path", c.Path, width))
	return b.String()
}

// ── Audit ──────────────────────────────────────────────────────────────────

// auditEntryString reads a string-valued field from an opaque audit entry,
// returning "" when the key is absent. A non-string value falls back to its
// compact raw-JSON text so the field is never silently dropped.
func auditEntryString(e AuditEntry, key string) string {
	raw, ok := e[key]
	if !ok {
		return ""
	}
	// Only a JSON string literal unmarshals to a meaningful Go string. Guard on
	// the leading quote: json.Unmarshal of `null` into a string also succeeds —
	// with "" — which would masquerade as an absent key and silently drop the
	// field. Any non-string value falls through to its raw text instead.
	if len(raw) > 0 && raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	return strings.TrimSpace(string(raw))
}

// auditTitleFields are the keys tried (in order) for the second half of an audit
// row title, after the timestamp. The audit entry schema is not frozen, so the
// first present one wins; if none are present the title is just the timestamp.
var auditTitleFields = []string{"action", "event", "op", "operation", "command", "kind"}

// auditItems converts an AuditResult into sectionItems for the Audit list, one
// row per entry in the engine's newest-first order. Because the entry schema is
// open, the title is the timestamp plus the first present "action-like" field;
// the detail renders every field generically (sorted keys, compact JSON values).
func auditItems(r AuditResult) []sectionItem {
	items := make([]sectionItem, 0, len(r.Entries))
	for i, e := range r.Entries {
		e := e // shadow for closure capture
		ts := auditEntryString(e, "timestamp")
		label := ts
		for _, k := range auditTitleFields {
			if v := auditEntryString(e, k); v != "" {
				if label != "" {
					label += " · " + v
				} else {
					label = v
				}
				break
			}
		}
		if label == "" {
			label = fmt.Sprintf("entry %d", i+1)
		}
		items = append(items, sectionItem{
			title:  glyph("•", "*") + " " + label,
			color:  accent,
			detail: func(w int) string { return auditDetail(e, w) },
		})
	}
	return items
}

// auditDetail builds the detail body for one opaque audit entry: every field
// rendered as a row, keys sorted for deterministic output, values shown as a
// plain string when string-valued else compacted to a single JSON line (mirrors
// configDetail's per-layer rendering).
func auditDetail(e AuditEntry, width int) string {
	title := auditEntryString(e, "timestamp")
	if title == "" {
		title = "audit entry"
	}

	var b strings.Builder
	b.WriteString(detailTitle(title, accent, "", width))
	b.WriteString("\n\n")

	keys := make([]string, 0, len(e))
	for k := range e {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	b.WriteString(detailSection("Fields", accent, width))
	if len(keys) == 0 {
		b.WriteString(detailField("—", "empty entry", width))
		return b.String()
	}
	for _, k := range keys {
		raw := e[k]
		v := strings.TrimSpace(string(raw))
		var buf bytes.Buffer
		if err := json.Compact(&buf, raw); err == nil && buf.Len() > 0 {
			v = buf.String()
		}
		// Unquote a JSON string for readability; guard on the leading quote so a
		// `null` value (which also unmarshals into "") is not turned into an empty
		// field — it stays the compact "null" produced by json.Compact above.
		if len(raw) > 0 && raw[0] == '"' {
			var s string
			if err := json.Unmarshal(raw, &s); err == nil {
				v = s
			}
		}
		b.WriteString(detailField(k, v, width))
	}
	return b.String()
}

// tabActionHint returns the contextual action-key hint for a tab's special
// action, or "" for tabs with none. Stateless (depends only on view) and shown
// regardless of write mode so the action is always discoverable; pressing it
// with writes off surfaces the existing "press W to enable" guidance.
func tabActionHint(view viewID) string {
	sep := lipgloss.NewStyle().Foreground(tabDim).Render(" · ")
	dim := lipgloss.NewStyle().Foreground(labelGray)
	switch {
	case view == viewDoctor:
		return sep + keyStyle.Render("a") + dim.Render(" "+tr("write.activeProbe.hint"))
	default:
		if wa, ok := writeActionFor(view); ok {
			return sep + keyStyle.Render("w") + dim.Render(" "+tr(wa.hintKey))
		}
	}
	return ""
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
	text += tabActionHint(view)

	// MaxHeight(1) keeps this a strict one-line bar — on a very narrow terminal the
	// label+summary+hint can't soft-wrap to a second row (matches filterBarView).
	style := lipgloss.NewStyle().Padding(0, 1).MaxHeight(1)
	if termWidth > 0 {
		style = style.Width(termWidth)
	}
	return style.Render(text)
}

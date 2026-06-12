package main

import (
	"fmt"
	"strings"
)

// dispositionTallies returns [clusters, removableLosers, advisoryLosers] from a
// slice of Disposition records, matching the "summary.dispositions" format args.
func dispositionTallies(disps []Disposition) [3]int {
	var removable, advisory int
	for _, d := range disps {
		for _, s := range d.Shadowed {
			if s.Removable {
				removable++
			} else {
				advisory++
			}
		}
	}
	return [3]int{len(disps), removable, advisory}
}

// dispositionItems converts Disposition records into sectionItems for the list
// pane. Each item's color mirrors the conflict severity so the badge logic works
// identically to the Health tab (healthSevColor is reused from health.go).
func dispositionItems(disps []Disposition) []sectionItem {
	items := make([]sectionItem, 0, len(disps))
	for _, d := range disps {
		d := d // capture for closure
		items = append(items, sectionItem{
			title:  dispositionRowTitle(d),
			color:  healthSevColor(d.Severity),
			detail: func(width int) string { return dispositionDetail(d, width) },
		})
	}
	return items
}

// dispositionRowTitle builds the one-line list entry for a conflict cluster.
// Format: "{icon} {kind}:{key}  ({n} shadowed)"
// Engine data (kind, key) stays English in both languages; only the trailing
// label is translated via the "disposition.shadowedCount" key.
func dispositionRowTitle(d Disposition) string {
	icon := healthSevIcon(d.Severity)
	n := len(d.Shadowed)
	// "disposition.shadowedCount" is the plain noun ("shadowed"/"被遮蔽"); the count
	// is supplied by the %d below, so resolve the label with tr — NOT tf, which would
	// pass n to a verbless format string and leak a "%!(EXTRA int=N)" suffix.
	label := tr("disposition.shadowedCount")
	return fmt.Sprintf("%s %s:%s  (%d %s)", icon, d.Kind, d.Key, n, label)
}

// pluginOrUnknown returns s when non-empty, else a localised "(none)" marker.
func pluginOrUnknown(s string) string {
	if s != "" {
		return s
	}
	return "(" + tr("disposition.none") + ")"
}

// docWithVersion appends " (vVER)" to a URL when ver is non-empty.
func docWithVersion(url, ver string) string {
	if ver == "" || url == "" {
		return url
	}
	return fmt.Sprintf("%s (v%s)", url, ver)
}

// dispositionDetail renders the full detail pane for one conflict cluster.
// Section/field labels go through tr(); engine data (paths, tiers, plugin names,
// suggestion text, ruleId, docUrl) stays English regardless of active language.
func dispositionDetail(d Disposition, width int) string {
	fg := healthSevColor(d.Severity)
	icon := healthSevIcon(d.Severity)

	var b strings.Builder
	b.WriteString(detailTitle(fmt.Sprintf("%s:%s", d.Kind, d.Key), fg, icon, width))
	b.WriteString("\n\n")

	// ── Winner ──────────────────────────────────────────────────────────────────
	b.WriteString(detailSection(tr("disposition.winner"), fg, width))
	b.WriteString(detailField(tr("detail.path"), d.Winner.Path, width))
	b.WriteString(detailField(tr("detail.tier"), d.Winner.Tier, width))
	if d.Winner.Plugin != "" {
		b.WriteString(detailField(tr("detail.plugin"), d.Winner.Plugin, width))
	}

	// ── Shadowed ────────────────────────────────────────────────────────────────
	if len(d.Shadowed) > 0 {
		b.WriteString("\n")
		b.WriteString(detailSection(tr("disposition.shadowed"), fg, width))
		for i, s := range d.Shadowed {
			if i > 0 {
				b.WriteString("\n")
			}
			b.WriteString(detailField(tr("detail.path"), s.Path, width))
			b.WriteString(detailField(tr("detail.tier"), s.Tier, width))
			if s.Plugin != "" {
				b.WriteString(detailField(tr("detail.plugin"), pluginOrUnknown(s.Plugin), width))
			}
			// Action: remove command or plugin advisory
			if s.Removable && s.RemoveCommand != "" {
				b.WriteString(detailField(tr("disposition.action"), s.RemoveCommand, width))
			} else {
				b.WriteString(detailField(tr("disposition.action"), tr("disposition.pluginAdvisory"), width))
			}
		}
	}

	// ── Suggestion ──────────────────────────────────────────────────────────────
	if d.Suggestion != "" {
		b.WriteString("\n")
		b.WriteString(detailSection(tr("disposition.suggestionLabel"), fg, width))
		b.WriteString(detailField("", d.Suggestion, width))
	}

	// ── Reference ───────────────────────────────────────────────────────────────
	if d.RuleID != "" || d.DocURL != "" {
		b.WriteString("\n")
		b.WriteString(detailSection(tr("disposition.reference"), fg, width))
		if d.RuleID != "" {
			b.WriteString(detailField(tr("disposition.rule"), d.RuleID, width))
		}
		if d.DocURL != "" {
			b.WriteString(detailField("", docWithVersion(d.DocURL, d.DocVersion), width))
		}
	}

	return b.String()
}

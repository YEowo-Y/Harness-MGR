package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── Health tab (bilingual) ──────────────────────────────────────────────────
//
// health.go owns the Health section tab — the FIRST detail-pane content to go
// bilingual (TUI-bilingual B2). It converts a HealthReport (the `health
// --format json` aggregate of per-component loadability + offline best-practice
// advice + a compact hook-resolution status) into a single severity-tiered
// flat list, mirroring the CLI's health-render tiers so the TUI and CLI agree.
//
// BILINGUAL DESIGN (a principled extension of i18n.go's chrome-only scope):
// translate the GUIDANCE/MEANING — status & severity labels, the summary, the
// detail-pane section/field labels, and the advice cards (B1's titleZh/adviceZh/
// fixZh, falling back to the English field when a zh string is empty) — but keep
// the DATA LITERAL: component names, file paths, hook command strings, event
// names, codes, reason messages, and the engine's English explanation sentence
// all stay English. This is justified because health/advice is CURATED GUIDANCE
// (chrome-like), not raw engine data; engine data stays English everywhere else
// in the TUI too. The detail closures consult uiLang at RENDER time (via tr/tf),
// so a language switch re-renders bilingually with no re-fetch — the same
// pattern the rest of the section tabs use.
//
// HOOK-SENTENCE SCOPE: the engine emits an English `explanation` sentence. The
// list shows hooks compactly as event + translated status/kind labels; the
// detail pane shows that sentence under a translated label — verbatim in en
// mode, recomposed in Chinese (hookExplainSentenceZh, ~30 event phrases) in zh
// mode, with embedded engine data (event/matcher/target) kept English.
//
// LAYOUT (severity-tiered): not-loaded components (red) → degraded (orange) →
// advice error→warn→info → problem hooks (status missing/indeterminate). A row
// is icon + name/title + a translated status tag. When everything is healthy
// (no problem rows) the list shows the all-clear empty state (empty.health).

// ── Severity → color / icon (shared vocabulary with the Doctor tab) ──────────

// healthSevColor maps an engine severity string ("error"/"warn"/"info") to a
// palette color: error→red, warn→orange, info→cyan. Anything else (incl. "")
// falls back to labelGray so a row is never left uncolored.
func healthSevColor(severity string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(severity)) {
	case "error":
		return colorRed
	case "warn", "warning":
		return colorOrange
	case "info":
		return colorMcp
	default:
		return labelGray
	}
}

// healthSevIcon maps an engine severity to its status glyph (Unicode + ASCII
// fallback), matching the Doctor tab's icon language: error ✗, warn ⚠, info •.
func healthSevIcon(severity string) string {
	switch strings.ToLower(strings.TrimSpace(severity)) {
	case "error":
		return glyph("✗", "[x]")
	case "warn", "warning":
		return glyph("⚠", "[!]")
	case "info":
		return glyph("•", "*")
	default:
		return glyph("○", "[ ]")
	}
}

// healthSevLabel returns the TRANSLATED severity label for an engine severity
// string ("error"→错误, "warn"→警告, "info"→提示). Unknown severities echo back
// the raw engine string (degrades visibly, never blank).
func healthSevLabel(severity string) string {
	switch strings.ToLower(strings.TrimSpace(severity)) {
	case "error":
		return tr("sev.error")
	case "warn", "warning":
		return tr("sev.warn")
	case "info":
		return tr("sev.info")
	default:
		return severity
	}
}

// ── Component status → color / label ─────────────────────────────────────────

// healthStatusColor maps a component load status ("not-loaded"/"degraded"/
// "loadable") to a palette color: not-loaded→red, degraded→orange,
// loadable→green. Unknown → labelGray.
func healthStatusColor(status string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "not-loaded":
		return colorRed
	case "degraded":
		return colorOrange
	case "loadable":
		return colorPlugin
	default:
		return labelGray
	}
}

// healthStatusIcon maps a component load status to its glyph: not-loaded ✗,
// degraded ⚠, loadable ✓.
func healthStatusIcon(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "not-loaded":
		return glyph("✗", "[x]")
	case "degraded":
		return glyph("⚠", "[!]")
	case "loadable":
		return glyph("✓", "[ok]")
	default:
		return glyph("○", "[ ]")
	}
}

// healthStatusLabel returns the TRANSLATED component-status label
// ("not-loaded"→未加载, "degraded"→降级, "loadable"→可加载). Unknown statuses echo
// the raw string.
func healthStatusLabel(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "not-loaded":
		return tr("health.notLoaded")
	case "degraded":
		return tr("health.degraded")
	case "loadable":
		return tr("health.loadable")
	default:
		return status
	}
}

// ── Hook status → color / label ──────────────────────────────────────────────

// hookExplainColor maps a hook resolution status to a palette color: missing→red,
// indeterminate→orange, found→green, unprobed→gray.
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainColor(status string) lipgloss.Color {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "missing":
		return colorRed
	case "indeterminate":
		return colorOrange
	case "found":
		return colorPlugin
	default:
		return labelGray
	}
}

// hookExplainIcon maps a hook status to its glyph: missing ✗, indeterminate ⚠,
// found ✓, unprobed ○.
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainIcon(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "missing":
		return glyph("✗", "[x]")
	case "indeterminate":
		return glyph("⚠", "[!]")
	case "found":
		return glyph("✓", "[ok]")
	default:
		return glyph("○", "[ ]")
	}
}

// hookExplainStatusLabel returns the TRANSLATED hook-status label
// (found→存在, missing→缺失, indeterminate→不确定, unprobed→未探测). Unknown echoes.
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainStatusLabel(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "found":
		return tr("hookstatus.found")
	case "missing":
		return tr("hookstatus.missing")
	case "indeterminate":
		return tr("hookstatus.indeterminate")
	case "unprobed":
		return tr("hookstatus.unprobed")
	default:
		return status
	}
}

// hookExplainKindLabel returns the TRANSLATED hook-kind label
// (file→文件, external→外部命令, opaque→未解析). Unknown echoes.
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainKindLabel(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "file":
		return tr("hookkind.file")
	case "external":
		return tr("hookkind.external")
	case "opaque":
		return tr("hookkind.opaque")
	default:
		return kind
	}
}

// ── Advice bilingual field selection ─────────────────────────────────────────

// adviceTitle / adviceText / adviceFix return the active-language field for an
// advice item: under langZH they return the zh field, FALLING BACK to the
// English field when the zh string is empty (a custom rule may lack a
// translation). Under langEN they always return the English field. This is the
// headline bilingual payoff of B2.
func adviceTitle(a AdviceItem) string {
	if uiLang == langZH && strings.TrimSpace(a.TitleZh) != "" {
		return a.TitleZh
	}
	return a.Title
}

func adviceText(a AdviceItem) string {
	if uiLang == langZH && strings.TrimSpace(a.AdviceZh) != "" {
		return a.AdviceZh
	}
	return a.Advice
}

func adviceFix(a AdviceItem) string {
	if uiLang == langZH && strings.TrimSpace(a.FixZh) != "" {
		return a.FixZh
	}
	return a.Fix
}

// ── List items (severity-tiered) ─────────────────────────────────────────────

// healthItems converts a HealthReport into a single severity-tiered sectionItem
// list, mirroring the CLI health-render tiers so the TUI and CLI agree:
//
//  1. not-loaded components (red)
//  2. degraded components (orange)
//  3. advice cards, ordered error → warn → info
//  4. problem hooks (status missing or indeterminate)
//
// Loadable components and found/unprobed hooks are NOT listed — the list surfaces
// only what needs attention; an all-healthy report yields zero items and the tab
// shows the all-clear empty state. Each row's title carries a translated status
// tag; engine data (names/codes/messages) stays English. Detail closures are
// built per row and read uiLang at render time, so a language toggle re-renders
// bilingually without re-fetching.
func healthItems(report HealthReport) []sectionItem {
	var items []sectionItem

	// Tiers 1 & 2: not-loaded then degraded components, each in engine order.
	for _, want := range []string{"not-loaded", "degraded"} {
		for _, c := range report.Health.Components {
			if strings.ToLower(strings.TrimSpace(c.Status)) != want {
				continue
			}
			c := c // shadow for closure capture
			items = append(items, sectionItem{
				title:  healthComponentRowTitle(c),
				color:  healthStatusColor(c.Status),
				detail: func(w int) string { return healthComponentDetail(c, w) },
			})
		}
	}

	// Tier 3: advice cards, error → warn → info.
	for _, want := range []string{"error", "warn", "info"} {
		for _, a := range report.Advice.Advice {
			if strings.ToLower(strings.TrimSpace(a.Severity)) != want {
				continue
			}
			a := a // shadow for closure capture
			items = append(items, sectionItem{
				title:  healthAdviceRowTitle(a),
				color:  healthSevColor(a.Severity),
				detail: func(w int) string { return healthAdviceDetail(a, w) },
			})
		}
	}

	// Tier 4: problem hooks (missing / indeterminate), in engine order.
	for _, h := range report.Hooks.Explanations {
		st := strings.ToLower(strings.TrimSpace(h.Status))
		if st != "missing" && st != "indeterminate" {
			continue
		}
		h := h // shadow for closure capture
		items = append(items, sectionItem{
			title:  hookExplainRowTitle(h),
			color:  hookExplainColor(h.Status),
			detail: func(w int) string { return hookExplainDetail(h, w) },
		})
	}

	return items
}

// healthComponentRowTitle builds a component row label: "<icon> <kind>:<name> ·
// <translated status>". Name/kind are engine DATA (English); the status tag is
// translated.
func healthComponentRowTitle(c HealthComponent) string {
	return fmt.Sprintf("%s %s:%s · %s",
		healthStatusIcon(c.Status), c.Kind, c.Name, healthStatusLabel(c.Status))
}

// healthAdviceRowTitle builds an advice row label: "<icon> <active-lang title> ·
// <translated severity>". The title is bilingual (B1 zh field w/ English
// fallback); the severity tag is translated.
func healthAdviceRowTitle(a AdviceItem) string {
	return fmt.Sprintf("%s %s · %s",
		healthSevIcon(a.Severity), adviceTitle(a), healthSevLabel(a.Severity))
}

// hookExplainRowTitle builds a problem-hook row label: "<icon> <event> ·
// <translated status>". Event is engine DATA (English); the status tag is
// translated.
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainRowTitle(h HookExplanation) string {
	return fmt.Sprintf("%s %s · %s",
		hookExplainIcon(h.Status), h.Event, hookExplainStatusLabel(h.Status))
}

// ── Detail panes ─────────────────────────────────────────────────────────────

// healthComponentDetail builds the detail body for a component row: a translated
// Status section (status + kind + scope + path) and a translated Reasons section
// listing each reason's translated severity + ENGLISH message (engine data). All
// SECTION/FIELD labels are translated; the values that are engine data (name,
// path, kind, scope, messages) stay English.
func healthComponentDetail(c HealthComponent, width int) string {
	fg := healthStatusColor(c.Status)

	var b strings.Builder
	b.WriteString(detailTitle(fmt.Sprintf("%s:%s", c.Kind, c.Name), fg, healthStatusIcon(c.Status), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection(tr("detail.status"), fg, width))
	b.WriteString(detailField(tr("detail.status"), healthStatusLabel(c.Status), width))
	b.WriteString(detailField(tr("detail.kind"), c.Kind, width))
	b.WriteString(detailField(tr("detail.scope"), c.Scope, width))
	b.WriteString(detailField(tr("detail.path"), c.Path, width))

	b.WriteString("\n")
	b.WriteString(detailSection(tr("detail.reasons"), fg, width))
	if len(c.Reasons) == 0 {
		b.WriteString(detailField("—", tr("health.allHealthy"), width))
		return b.String()
	}
	for i, r := range c.Reasons {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(detailField(tr("detail.severity"), healthSevLabel(r.Severity), width))
		b.WriteString(detailField(tr("detail.message"), r.Message, width))
	}
	return b.String()
}

// healthAdviceDetail builds the detail body for an advice card: the active-
// language title, a translated Advice section (advice text), a translated Fix
// section (fix text), and a docs reference. Title/advice/fix are bilingual (B1
// zh w/ English fallback); affectedPaths + docUrl are engine DATA (English).
func healthAdviceDetail(a AdviceItem, width int) string {
	fg := healthSevColor(a.Severity)

	var b strings.Builder
	b.WriteString(detailTitle(adviceTitle(a), fg, healthSevIcon(a.Severity), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection(tr("detail.advice"), fg, width))
	b.WriteString(detailField(tr("detail.severity"), healthSevLabel(a.Severity), width))
	b.WriteString(detailField(tr("detail.advice"), adviceText(a), width))

	b.WriteString("\n")
	b.WriteString(detailSection(tr("detail.fix"), fg, width))
	b.WriteString(detailField(tr("detail.fix"), adviceFix(a), width))
	if len(a.AffectedPaths) > 0 {
		b.WriteString(detailField(tr("detail.path"), strings.Join(a.AffectedPaths, ", "), width))
	}
	if strings.TrimSpace(a.DocURL) != "" {
		b.WriteString(detailField(tr("detail.docs"), a.DocURL, width))
	}
	return b.String()
}

// hookExplainDetail builds the detail body for a hook explanation: a translated
// Hook section (event + matcher + kind + target + status) and an explanation
// sentence under a translated label. In en mode the sentence is the engine's
// English `explanation` verbatim; in zh mode it is recomposed in Chinese via
// hookExplainSentenceZh (prose translated, embedded engine data kept English).
// All field VALUES except the labels are engine DATA (English).
// Shared by both the Hooks tab and the Health tab's problem-hook tier.
func hookExplainDetail(h HookExplanation, width int) string {
	fg := hookExplainColor(h.Status)

	var b strings.Builder
	b.WriteString(detailTitle(h.Event, fg, hookExplainIcon(h.Status), width))
	b.WriteString("\n\n")

	b.WriteString(detailSection(tr("detail.hook"), fg, width))
	b.WriteString(detailField(tr("detail.event"), h.Event, width))
	if strings.TrimSpace(h.Matcher) != "" {
		b.WriteString(detailField(tr("detail.matcher"), h.Matcher, width))
	}
	b.WriteString(detailField(tr("detail.kind"), hookExplainKindLabel(h.Kind), width))
	if strings.TrimSpace(h.Target) != "" {
		b.WriteString(detailField(tr("detail.path"), h.Target, width))
	}
	b.WriteString(detailField(tr("detail.status"), hookExplainStatusLabel(h.Status), width))

	if strings.TrimSpace(h.Explanation) != "" {
		b.WriteString("\n")
		b.WriteString(detailSection(tr("detail.hook"), fg, width))
		// In zh mode, compose a Chinese explanation sentence instead of passing
		// through the engine's English sentence verbatim. Embedded engine DATA
		// (event key, matcher value, target path) stays English inside the
		// Chinese sentence — this is a deliberate scoped exception to the
		// "engine data stays English" convention because the sentence is prose
		// meant to be read, not a data value.
		sentence := h.Explanation
		if uiLang == langZH {
			sentence = hookExplainSentenceZh(h)
		}
		b.WriteString(detailField("—", sentence, width))
	}
	return b.String()
}

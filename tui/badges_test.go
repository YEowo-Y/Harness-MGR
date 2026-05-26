package main

import (
	"strings"
	"testing"
)

// ── sectionReady / sectionItemCount / sectionHasColor helpers ─────────────────

// TestSectionReadyReturnsFalseWhileLoading asserts that a section which is still
// loading is not considered ready — the badge must never reflect stale/no data.
func TestSectionReadyReturnsFalseWhileLoading(t *testing.T) {
	m := initialModel("x")
	// All sections start as loading=true in a fresh initialModel.
	if _, ok := sectionReady(m, viewDoctor); ok {
		t.Fatal("sectionReady should be false while loading")
	}
}

// TestSectionReadyReturnsFalseOnError asserts an errored section is not ready.
func TestSectionReadyReturnsFalseOnError(t *testing.T) {
	m := loadedModel(120, 30)
	mm, _ := m.Update(doctorMsg{err: errFmt("boom")})
	m = mm.(model)
	if _, ok := sectionReady(m, viewDoctor); ok {
		t.Fatal("sectionReady should be false when section has an error")
	}
}

// TestSectionItemCountZeroWhenNotReady asserts the helper returns 0 for an
// unready section rather than panicking or returning a stale count.
func TestSectionItemCountZeroWhenNotReady(t *testing.T) {
	m := initialModel("x")
	if n := sectionItemCount(m, viewDoctor); n != 0 {
		t.Fatalf("sectionItemCount want 0 while loading, got %d", n)
	}
}

// ── tabBadge ──────────────────────────────────────────────────────────────────

// TestTabBadgeDoctorRedOnError asserts that when the Doctor tab has an error
// check (colorRed item), tabBadge returns (colorRed, true).
func TestTabBadgeDoctorRedOnError(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())
	// sampleDoctorReport has check #6 settings-json-valid with an error diag →
	// doctorItems maps it to colorRed.
	sev, ok := tabBadge(m, viewDoctor)
	if !ok {
		t.Fatal("tabBadge(viewDoctor) ok=false, want true (has error check)")
	}
	if sev != colorRed {
		t.Fatalf("tabBadge(viewDoctor) color=%v, want colorRed", sev)
	}
}

// TestTabBadgePermissionsRedOnOverbroad asserts that when the Permissions tab
// has an overbroad allow rule (colorRed item), tabBadge returns (colorRed, true).
func TestTabBadgePermissionsRedOnOverbroad(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectPermissions(m, samplePermissionsResult())
	// samplePermissionsResult has "Edit(*)" as overbroad → colorRed item.
	sev, ok := tabBadge(m, viewPermissions)
	if !ok {
		t.Fatal("tabBadge(viewPermissions) ok=false, want true (has overbroad rule)")
	}
	if sev != colorRed {
		t.Fatalf("tabBadge(viewPermissions) color=%v, want colorRed", sev)
	}
}

// TestTabBadgeDriftOrangeWhenChanges asserts that when the Drift tab has items
// (drifted, 2 changes), tabBadge returns (colorOrange, true).
func TestTabBadgeDriftOrangeWhenChanges(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDrift(m, sampleDriftResult())
	// sampleDriftResult has 2 changes → sectionItemCount > 0.
	sev, ok := tabBadge(m, viewDrift)
	if !ok {
		t.Fatal("tabBadge(viewDrift) ok=false, want true (drifted, 2 changes)")
	}
	if sev != colorOrange {
		t.Fatalf("tabBadge(viewDrift) color=%v, want colorOrange", sev)
	}
}

// TestTabBadgeNoneForInformationalTabs asserts that Config, Hooks, and Audit
// tabs never produce a badge (they are informational, not health-indicative).
func TestTabBadgeNoneForInformationalTabs(t *testing.T) {
	m := loadedModel(120, 30)
	for _, v := range []viewID{viewConfig, viewHooks, viewAudit} {
		if _, ok := tabBadge(m, v); ok {
			t.Errorf("tabBadge(%v) ok=true, want false (informational tab)", v)
		}
	}
}

// TestTabBadgeNoneWhileLoading asserts that a fresh initialModel (sections are
// loading=true) never produces a badge — not-ready sections must not badge.
func TestTabBadgeNoneWhileLoading(t *testing.T) {
	m := initialModel("x")
	if _, ok := tabBadge(m, viewDoctor); ok {
		t.Fatal("tabBadge(viewDoctor) ok=true while loading, want false")
	}
}

// TestTabBadgeCleanDoctorNoBadge asserts that a Doctor report with only a
// passing check (no error or warn item) produces ok=false from tabBadge.
func TestTabBadgeCleanDoctorNoBadge(t *testing.T) {
	m := loadedModel(120, 30)
	// A minimal report with one ok check (no diagnostics → colorPlugin green).
	clean := DoctorReport{
		ProbeLevel:  "passive",
		Checks:      []DoctorCheck{{ID: 1, Code: "x", ProbeLevel: "passive", Ran: true, Findings: 0}},
		Diagnostics: nil,
	}
	m = injectDoctor(m, clean)
	if _, ok := tabBadge(m, viewDoctor); ok {
		t.Fatal("tabBadge(viewDoctor) ok=true for a clean report, want false")
	}
}

// TestTabBadgeInventoryOrangeOnDiagnostics covers the only badge path that does
// not flow through sectionReady: the Inventory tab badges orange when the counts
// fetch has landed (not loading, no error) with diagnostics present.
func TestTabBadgeInventoryOrangeOnDiagnostics(t *testing.T) {
	m := loadedModel(120, 30)
	m.loading = false
	m.err = nil
	m.inv.Diagnostics = []Diagnostic{{Severity: "warn", Code: "x", Message: "y"}}
	sev, ok := tabBadge(m, viewInventory)
	if !ok {
		t.Fatal("tabBadge(viewInventory) ok=false, want true (has diagnostics)")
	}
	if sev != colorOrange {
		t.Fatalf("tabBadge(viewInventory) color=%v, want colorOrange", sev)
	}
	// And it must NOT badge while the counts fetch is still in flight.
	m.loading = true
	if _, ok := tabBadge(m, viewInventory); ok {
		t.Fatal("tabBadge(viewInventory) ok=true while loading, want false")
	}
}

// TestTabBarViewRendersWithoutPanic asserts that tabBarView returns a non-empty
// string that contains the "Doctor" tab label, regardless of badge rendering.
func TestTabBarViewRendersWithoutPanic(t *testing.T) {
	m := loadedModel(120, 30)
	m = injectDoctor(m, sampleDoctorReport())
	out := tabBarView(m)
	if out == "" {
		t.Fatal("tabBarView returned empty string")
	}
	if !strings.Contains(stripANSI(out), "Doctor") {
		t.Fatalf("tabBarView missing 'Doctor' tab label:\n%s", stripANSI(out))
	}
	// sampleDoctorReport has an error check, so a badge glyph must render — proving
	// tabBarView actually wires tabBadge in (the glyph is ● with color, "*" under
	// the Ascii test profile).
	clean := stripANSI(out)
	if !strings.Contains(clean, "*") && !strings.Contains(clean, "●") {
		t.Fatalf("tabBarView should render a badge glyph for a tab with findings:\n%s", clean)
	}
}

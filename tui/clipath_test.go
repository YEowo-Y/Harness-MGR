package main

import (
	"os"
	"path/filepath"
	"testing"
)

// makeRepoTree builds a temp dir with src/cli.mjs at root + a nested subdir,
// returning (root, nestedDir). t.TempDir auto-cleans.
func makeRepoTree(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "cli.mjs"), []byte("// stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "tui", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	return root, nested
}

func TestFindCLIUpwardsFromNested(t *testing.T) {
	root, nested := makeRepoTree(t)
	got, ok := findCLIUpwards(nested)
	if !ok {
		t.Fatalf("findCLIUpwards(%q) = not found, want the root src/cli.mjs", nested)
	}
	want := filepath.Join(root, "src", "cli.mjs")
	if got != want {
		t.Fatalf("findCLIUpwards = %q, want %q", got, want)
	}
}

func TestFindCLIUpwardsFromRoot(t *testing.T) {
	root, _ := makeRepoTree(t)
	got, ok := findCLIUpwards(root)
	if !ok || got != filepath.Join(root, "src", "cli.mjs") {
		t.Fatalf("findCLIUpwards(root) = (%q,%v), want the root src/cli.mjs", got, ok)
	}
}

func TestFindCLIUpwardsNotFound(t *testing.T) {
	// A bare temp dir with no src/cli.mjs anywhere up the (temp) chain.
	dir := t.TempDir()
	if got, ok := findCLIUpwards(dir); ok {
		t.Fatalf("findCLIUpwards(%q) = (%q,true), want not found", dir, got)
	}
}

func TestFindCLIUpwardsIgnoresDirectory(t *testing.T) {
	// A src/cli.mjs that is a DIRECTORY must NOT be accepted.
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src", "cli.mjs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := findCLIUpwards(root); ok {
		t.Fatalf("findCLIUpwards matched a directory: (%q,true), want not found", got)
	}
}

func TestResolveCLIPathFromFlagWins(t *testing.T) {
	_, nested := makeRepoTree(t)
	// Even with a discoverable tree + an env value, the explicit flag wins.
	got := resolveCLIPathFrom("/explicit/cli.mjs", "/env/cli.mjs", nested, "")
	if got != "/explicit/cli.mjs" {
		t.Fatalf("flag should win, got %q", got)
	}
}

func TestResolveCLIPathFromEnvBeatsWalk(t *testing.T) {
	_, nested := makeRepoTree(t)
	got := resolveCLIPathFrom("", "/env/cli.mjs", nested, "")
	if got != "/env/cli.mjs" {
		t.Fatalf("env should beat the upward walk, got %q", got)
	}
}

func TestResolveCLIPathFromCwdWalk(t *testing.T) {
	root, nested := makeRepoTree(t)
	got := resolveCLIPathFrom("", "", nested, "")
	if got != filepath.Join(root, "src", "cli.mjs") {
		t.Fatalf("cwd walk should find the root cli, got %q", got)
	}
}

func TestResolveCLIPathFromExeWalkFallback(t *testing.T) {
	root, _ := makeRepoTree(t)
	// cwd has no tree (a bare temp dir) → fall through to the exe-dir walk.
	bareCwd := t.TempDir()
	exe := filepath.Join(root, "tui", "harness-mgr-tui.exe")
	got := resolveCLIPathFrom("", "", bareCwd, exe)
	if got != filepath.Join(root, "src", "cli.mjs") {
		t.Fatalf("exe-dir walk should find the root cli, got %q", got)
	}
}

func TestResolveCLIPathFromBareFallback(t *testing.T) {
	// Nothing resolvable anywhere → the historical default, unchanged.
	bareCwd := t.TempDir()
	got := resolveCLIPathFrom("", "", bareCwd, "")
	if got != "src/cli.mjs" {
		t.Fatalf("want the bare fallback \"src/cli.mjs\", got %q", got)
	}
}

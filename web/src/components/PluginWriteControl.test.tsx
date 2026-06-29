import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithLang } from "@/test/utils";
import { PluginWriteControl } from "@/components/PluginWriteControl";
import type { InventoryItem, WriteEnvelope, WriteResult, Diagnostic } from "@/lib/api";

/*
 * The control only DRIVES /api/write and renders what the engine returns, so the
 * test seam is writeCommand: mock it, feed back each engine outcome (real diff /
 * no-op / error diagnostic / thrown transport error / failed apply), and assert the
 * idle→preview→done/error state machine renders the right thing and re-sends the
 * right args. No real network, no engine.
 */
vi.mock("@/lib/api", () => ({ writeCommand: vi.fn() }));
import { writeCommand } from "@/lib/api";
const writeMock = vi.mocked(writeCommand);

/** A WriteEnvelope with sane dry-run defaults; pass result overrides per case. */
function env(result: Partial<WriteResult>, diagnostics: Diagnostic[] = []): WriteEnvelope {
  return {
    command: "enable",
    apply: false,
    code: 0,
    diagnostics,
    result: {
      status: "dry-run",
      ok: true,
      dryRun: true,
      kind: "plugin",
      name: "claude-mem@thedotmack",
      target: "claude",
      diff: null,
      alreadyInState: false,
      applied: false,
      snapshotId: null,
      ...result,
    },
  };
}

const DISABLED_PLUGIN: InventoryItem = {
  kind: "plugin",
  name: "claude-mem",
  key: "claude-mem@thedotmack",
  enabled: false,
};
const REAL_DIFF = { line: 152, before: "", after: '"claude-mem@thedotmack": true' };

beforeEach(() => {
  writeMock.mockReset();
});

describe("PluginWriteControl", () => {
  it("idle: a disabled plugin offers Enable (verb is the opposite of current state)", () => {
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);
    expect(screen.getByRole("button", { name: "Enable plugin" })).toBeInTheDocument();
  });

  it("idle: an enabled plugin offers Disable", () => {
    renderWithLang(
      <PluginWriteControl item={{ ...DISABLED_PLUGIN, enabled: true }} target="claude" onRefresh={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Disable plugin" })).toBeInTheDocument();
  });

  it("preview: a real diff renders the change + a Confirm button, and dry-runs with the right args", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));

    expect(await screen.findByText(/"claude-mem@thedotmack": true/)).toBeInTheDocument();
    expect(screen.getByText(/settings\.json · line 152/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & apply" })).toBeInTheDocument();
    expect(writeMock).toHaveBeenCalledWith("enable", {
      target: "claude",
      type: "plugin",
      name: "claude-mem@thedotmack",
      apply: false,
    });
  });

  it("preview: a no-op (alreadyInState) shows 'nothing to write' and NO Confirm button", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ alreadyInState: true, diff: null }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));

    expect(await screen.findByText(/nothing to write/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("apply: confirm sends apply:true, shows Applied + snapshot, and calls onRefresh", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    writeMock
      .mockResolvedValueOnce(env({ diff: REAL_DIFF }))
      .mockResolvedValueOnce(env({ diff: REAL_DIFF, applied: true, snapshotId: "snap-42", status: "applied" }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & apply" }));

    expect(await screen.findByText("Applied.")).toBeInTheDocument();
    expect(screen.getByText(/Snapshot snap-42/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenLastCalledWith("enable", {
      target: "claude",
      type: "plugin",
      name: "claude-mem@thedotmack",
      apply: true,
    });
  });

  it("error: an engine error diagnostic on preview surfaces the message, no Confirm", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({}, [{ severity: "error", code: "boom", message: "settings.json is locked" }]),
    );
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));

    expect(await screen.findByText("settings.json is locked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
  });

  it("error: a thrown transport error is shown verbatim", async () => {
    const user = userEvent.setup();
    writeMock.mockRejectedValueOnce(new Error("network down"));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));

    expect(await screen.findByText("network down")).toBeInTheDocument();
  });

  it("error: a non-applied apply result falls back to the generic failure message", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    writeMock
      .mockResolvedValueOnce(env({ diff: REAL_DIFF }))
      .mockResolvedValueOnce(env({ diff: REAL_DIFF, applied: false }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & apply" }));

    // stable substring (drop the trailing period) so a copy tweak won't break it
    expect(await screen.findByText(/Could not complete the change/)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("cancel returns to idle (re-shows the toggle button)", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="claude" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Enable plugin" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
  });

  it("codex target labels the diff with config.toml, not settings.json", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: { line: 9, before: "", after: "enabled = true" } }));
    renderWithLang(<PluginWriteControl item={DISABLED_PLUGIN} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable plugin" }));

    expect(await screen.findByText(/config\.toml · line 9/)).toBeInTheDocument();
    expect(screen.queryByText(/settings\.json/)).not.toBeInTheDocument();
  });
});

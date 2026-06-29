import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithLang } from "@/test/utils";
import { SkillVisibilityControl } from "@/components/SkillVisibilityControl";
import type { InventoryItem, WriteEnvelope, WriteResult, Diagnostic } from "@/lib/api";

/*
 * The control only DRIVES /api/write/skill:visibility and renders what the engine
 * returns. Test seam: mock writeCommand, feed back each engine outcome (real diff /
 * no-op / error diagnostic / thrown transport error / failed apply), and assert the
 * idle→preview→done/error state machine renders the right thing and re-sends the right
 * args. No real network, no engine.
 */
vi.mock("@/lib/api", () => ({ writeCommand: vi.fn() }));
import { writeCommand } from "@/lib/api";
const writeMock = vi.mocked(writeCommand);

/** A WriteEnvelope with sane dry-run defaults; pass result overrides per case. */
function env(result: Partial<WriteResult>, diagnostics: Diagnostic[] = []): WriteEnvelope {
  return {
    command: "skill:visibility",
    apply: false,
    code: 0,
    diagnostics,
    result: {
      status: "dry-run",
      ok: true,
      dryRun: true,
      kind: "skill",
      name: "agent-eval",
      target: "claude",
      diff: null,
      alreadyInState: false,
      applied: false,
      snapshotId: null,
      ...result,
    },
  };
}

const ITEM_DEFAULT: InventoryItem = {
  kind: "skill",
  name: "agent-eval",
  visibility: "default",
};

const REAL_DIFF = {
  line: 2,
  before: "",
  after: '"skillOverrides": { "agent-eval": "off" }',
};

beforeEach(() => {
  writeMock.mockReset();
});

describe("SkillVisibilityControl", () => {
  it('idle: shows "Current visibility" label with current value "default"', () => {
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );
    // EN["write.vis.current"] = "Current visibility"
    expect(screen.getByText(/Current visibility/)).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it('idle: shows the "Set to" label', () => {
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );
    // EN["write.vis.set"] = "Set to"
    expect(screen.getByText("Set to")).toBeInTheDocument();
  });

  it("idle: shows exactly 4 state buttons named on / name-only / user-invocable-only / off", () => {
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "name-only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "user-invocable-only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "off" })).toBeInTheDocument();
  });

  it('idle: with visibility "default" none of the 4 state buttons are disabled', () => {
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "on" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "name-only" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "user-invocable-only" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "off" })).not.toBeDisabled();
  });

  it('current state disabled: with visibility "on" the "on" button is disabled and aria-pressed="true"', () => {
    renderWithLang(
      <SkillVisibilityControl
        item={{ ...ITEM_DEFAULT, visibility: "on" }}
        target="claude"
        onRefresh={() => {}}
      />,
    );
    const onBtn = screen.getByRole("button", { name: "on" });
    expect(onBtn).toBeDisabled();
    expect(onBtn).toHaveAttribute("aria-pressed", "true");
    // another button is enabled
    expect(screen.getByRole("button", { name: "off" })).not.toBeDisabled();
  });

  it("preview: clicking a state button calls writeCommand with apply:false and right args", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));

    expect(writeMock).toHaveBeenCalledWith("skill:visibility", {
      target: "claude",
      type: "skill",
      name: "agent-eval",
      state: "off",
      apply: false,
    });
  });

  it("preview: a real diff shows the file+line label and after text", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));

    // EN["write.line"] = "{file} · line {line}"
    expect(await screen.findByText(/settings\.json · line 2/)).toBeInTheDocument();
    expect(screen.getByText(/"skillOverrides": \{ "agent-eval": "off" \}/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & apply" })).toBeInTheDocument();
  });

  it("apply: Confirm re-sends with apply:true, shows Applied. and snapshot, calls onRefresh", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    writeMock
      .mockResolvedValueOnce(env({ diff: REAL_DIFF }))
      .mockResolvedValueOnce(
        env({ diff: REAL_DIFF, applied: true, snapshotId: "snap-99", status: "applied" }),
      );
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & apply" }));

    // EN["write.done"] = "Applied."
    expect(await screen.findByText("Applied.")).toBeInTheDocument();
    // EN["write.snapshot"] = "Snapshot {id} — roll back with: rollback {id}"
    expect(screen.getByText(/Snapshot snap-99/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenLastCalledWith("skill:visibility", {
      target: "claude",
      type: "skill",
      name: "agent-eval",
      state: "off",
      apply: true,
    });
  });

  it("no-op (alreadyInState): shows nothing-to-write message and no Confirm button", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ alreadyInState: true, diff: null }));
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));

    // EN["write.noChange"] = "Already in the target state — nothing to write."
    expect(await screen.findByText(/nothing to write/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("error: an engine error diagnostic on preview surfaces the message, no Confirm", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({}, [{ severity: "error", code: "e-lock", message: "settings.json is locked" }]),
    );
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));

    expect(await screen.findByText("settings.json is locked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
  });

  it("error: a thrown transport error is shown verbatim", async () => {
    const user = userEvent.setup();
    writeMock.mockRejectedValueOnce(new Error("network down"));
    renderWithLang(
      <SkillVisibilityControl item={ITEM_DEFAULT} target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "off" }));

    expect(await screen.findByText("network down")).toBeInTheDocument();
  });
});

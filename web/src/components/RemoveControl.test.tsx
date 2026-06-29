import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithLang } from "@/test/utils";
import { RemoveControl } from "@/components/RemoveControl";
import type { InventoryItem, WriteEnvelope, WriteResult, Diagnostic } from "@/lib/api";

/*
 * The control only DRIVES /api/write and renders what the engine returns, so the
 * test seam is writeCommand: mock it, feed back each engine outcome (resolved path /
 * prune count / error diagnostic / thrown transport error), and assert the
 * idle→preview→done/error state machine renders correctly and sends the right args.
 * No real network, no engine.
 *
 * Key remove-specific differences from PluginWriteControl:
 *   - dry-run result has NO diff (it's a delete)
 *   - result.target is the engine-resolved ABSOLUTE PATH, not a target id
 *   - a skill (codex) preview carries result.prunedCount
 *   - a danger button is gated behind an "I understand" checkbox
 */
vi.mock("@/lib/api", () => ({ writeCommand: vi.fn() }));
import { writeCommand } from "@/lib/api";
const writeMock = vi.mocked(writeCommand);

/** Build a WriteEnvelope for the remove command. */
function env(result: Partial<WriteResult>, diagnostics: Diagnostic[] = []): WriteEnvelope {
  return {
    command: "remove",
    apply: false,
    code: 0,
    diagnostics,
    result: {
      status: "dry-run",
      ok: true,
      dryRun: true,
      kind: "agent",
      name: "analyst",
      target: "/abs/agents/analyst.md",
      diff: null,
      alreadyInState: false,
      applied: false,
      snapshotId: null,
      ...result,
    },
  };
}

const AGENT_ITEM: InventoryItem = {
  kind: "agent",
  name: "analyst",
  path: "/abs/agents/analyst.md",
};

const SKILL_ITEM: InventoryItem = {
  kind: "skill",
  name: "my-skill",
  path: "/abs/skills/my-skill",
};

beforeEach(() => {
  writeMock.mockReset();
});

describe("RemoveControl", () => {
  // ── 1. idle ──────────────────────────────────────────────────────────────────
  it("idle: shows the Remove… button", () => {
    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /Remove…/ })).toBeInTheDocument();
  });

  // ── 2. preview (agent) ────────────────────────────────────────────────────────
  it("preview (agent): dry-runs with the right args and renders path label, reversible note, ack checkbox, and disabled danger button", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ target: "/abs/agents/analyst.md" }));

    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    // writeCommand called with correct args
    expect(writeMock).toHaveBeenCalledWith("remove", {
      target: "claude",
      type: "agent",
      name: "analyst",
      apply: false,
    });

    // "Will delete" label (remove.pathLabel) must appear
    expect(await screen.findByText("Will delete")).toBeInTheDocument();

    // the resolved path must be shown
    expect(screen.getByText("/abs/agents/analyst.md")).toBeInTheDocument();

    // reversible note (remove.reversible) — match stable substring
    expect(screen.getByText(/auto-snapshot is taken first/)).toBeInTheDocument();

    // "I understand" checkbox (remove.ack)
    expect(screen.getByRole("checkbox")).toBeInTheDocument();

    // danger button "Delete analyst" (remove.confirm interpolated with name)
    const deleteBtn = screen.getByRole("button", { name: "Delete analyst" });
    expect(deleteBtn).toBeInTheDocument();

    // danger button must be DISABLED until checkbox is checked
    expect(deleteBtn).toBeDisabled();
  });

  // ── 3. ack gates apply ────────────────────────────────────────────────────────
  it("ack gates apply: danger button disabled until checkbox checked, then apply sends apply:true and shows Removed.", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    writeMock
      .mockResolvedValueOnce(env({ target: "/abs/agents/analyst.md" }))
      .mockResolvedValueOnce(
        env({ target: "/abs/agents/analyst.md", applied: true, snapshotId: "snap-7", status: "applied" }),
      );

    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole("button", { name: /Remove…/ }));
    const deleteBtn = await screen.findByRole("button", { name: "Delete analyst" });

    // initially disabled
    expect(deleteBtn).toBeDisabled();

    // check the "I understand" checkbox
    await user.click(screen.getByRole("checkbox"));

    // now enabled
    expect(deleteBtn).toBeEnabled();

    // click the danger button
    await user.click(deleteBtn);

    // apply call sent with apply:true
    expect(writeMock).toHaveBeenLastCalledWith("remove", {
      target: "claude",
      type: "agent",
      name: "analyst",
      apply: true,
    });

    // done phase shows "Removed." (remove.done)
    expect(await screen.findByText("Removed.")).toBeInTheDocument();

    // snapshot id surfaced
    expect(screen.getByText(/snap-7/)).toBeInTheDocument();

    // onRefresh called once
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  // ── 4. skill folder warning ───────────────────────────────────────────────────
  it("skill preview shows warnFolder; agent preview does NOT", async () => {
    const user = userEvent.setup();

    // ---- skill: warning should appear
    writeMock.mockResolvedValueOnce(
      env({ kind: "skill", name: "my-skill", target: "/abs/skills/my-skill" }),
    );
    const { unmount } = renderWithLang(
      <RemoveControl item={SKILL_ITEM} kind="skill" target="claude" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));
    // remove.warnFolder — match stable substring
    expect(await screen.findByText(/deletes the entire skill folder/)).toBeInTheDocument();
    unmount();

    // ---- agent: warning must be absent
    writeMock.mockResolvedValueOnce(env({ target: "/abs/agents/analyst.md" }));
    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));
    await screen.findByText("Will delete");
    expect(screen.queryByText(/deletes the entire skill folder/)).not.toBeInTheDocument();
  });

  // ── 5. prune count ────────────────────────────────────────────────────────────
  it("prune count > 0: shows 'Also prunes N …'", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({ kind: "skill", name: "my-skill", target: "/abs/skills/my-skill", prunedCount: 2 }),
    );

    renderWithLang(
      <RemoveControl item={SKILL_ITEM} kind="skill" target="codex" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    // remove.prune interpolated: "Also prunes 2 orphaned …"
    expect(await screen.findByText(/Also prunes 2/)).toBeInTheDocument();
  });

  it("prune count 0: shows 'No config entries reference it …'", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({ kind: "skill", name: "my-skill", target: "/abs/skills/my-skill", prunedCount: 0 }),
    );

    renderWithLang(
      <RemoveControl item={SKILL_ITEM} kind="skill" target="codex" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    // remove.pruneNone — match stable substring
    expect(await screen.findByText(/No config entries reference it/)).toBeInTheDocument();
  });

  it("prune count absent (null): neither prune line appears", async () => {
    const user = userEvent.setup();
    // prunedCount not set → undefined → prunedCount != null is false
    writeMock.mockResolvedValueOnce(
      env({ kind: "skill", name: "my-skill", target: "/abs/skills/my-skill" }),
    );

    renderWithLang(
      <RemoveControl item={SKILL_ITEM} kind="skill" target="codex" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));
    await screen.findByText("Will delete");

    expect(screen.queryByText(/Also prunes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No config entries reference it/)).not.toBeInTheDocument();
  });

  // ── 6. path fallback ──────────────────────────────────────────────────────────
  it("path fallback: when result.target is null, shows item.path instead", async () => {
    const user = userEvent.setup();
    // engine returns target:null (shouldn't happen in practice, but the component handles it)
    writeMock.mockResolvedValueOnce(env({ target: null }));

    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    // should fall back to item.path
    expect(await screen.findByText("/abs/agents/analyst.md")).toBeInTheDocument();
  });

  // ── 7. error: diagnostic + thrown error ──────────────────────────────────────
  it("error: an engine error diagnostic surfaces the message", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({}, [{ severity: "error", code: "not-found", message: "analyst.md does not exist" }]),
    );

    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    expect(await screen.findByText("analyst.md does not exist")).toBeInTheDocument();
    // no danger button in error state
    expect(screen.queryByRole("button", { name: "Delete analyst" })).not.toBeInTheDocument();
  });

  it("error: a thrown transport error is shown verbatim", async () => {
    const user = userEvent.setup();
    writeMock.mockRejectedValueOnce(new Error("network timeout"));

    renderWithLang(
      <RemoveControl item={AGENT_ITEM} kind="agent" target="claude" onRefresh={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Remove…/ }));

    expect(await screen.findByText("network timeout")).toBeInTheDocument();
  });
});

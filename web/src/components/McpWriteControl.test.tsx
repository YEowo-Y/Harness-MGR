import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithLang } from "@/test/utils";
import { McpWriteControl } from "@/components/McpWriteControl";
import type { InventoryItem, WriteEnvelope, WriteResult, Diagnostic } from "@/lib/api";

/*
 * McpWriteControl drives /api/write and renders the engine's response. The test
 * seam is writeCommand: mock it, feed back each engine outcome (real diff / no-op /
 * error diagnostic / thrown transport error / loader-unverified caveat), and assert
 * the idle→loading→preview→done/error state machine. MCP items carry NO enabled
 * field — the UI offers BOTH enable AND disable, letting the engine's dry-run probe
 * determine which is a no-op.
 */
vi.mock("@/lib/api", () => ({ writeCommand: vi.fn() }));
import { writeCommand } from "@/lib/api";
const writeMock = vi.mocked(writeCommand);

/** A WriteEnvelope with sane dry-run defaults; pass result overrides per case. */
function env(result: Partial<WriteResult>, diagnostics: Diagnostic[] = []): WriteEnvelope {
  return {
    command: "disable",
    apply: false,
    code: 0,
    diagnostics,
    result: {
      status: "dry-run",
      ok: true,
      dryRun: true,
      kind: "mcp",
      name: "context7",
      target: "codex",
      diff: null,
      alreadyInState: false,
      applied: false,
      snapshotId: null,
      ...result,
    },
  };
}

const MCP_ITEM: InventoryItem = {
  kind: "mcp",
  name: "context7",
  scope: "user",
  transport: "stdio",
};

const REAL_DIFF = { line: 2122, before: "", after: "enabled = false" };

beforeEach(() => {
  writeMock.mockReset();
});

describe("McpWriteControl", () => {
  it("idle: shows the MCP hint text and both Enable and Disable buttons", () => {
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);
    expect(screen.getByText(/An MCP server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable server" })).toBeInTheDocument();
  });

  it("preview (disable): dry-runs with correct args and renders the diff location and content", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText(/config\.toml · line 2122/)).toBeInTheDocument();
    expect(screen.getByText(/enabled = false/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & apply" })).toBeInTheDocument();
    expect(writeMock).toHaveBeenCalledWith("disable", {
      target: "codex",
      type: "mcp",
      name: "context7",
      apply: false,
    });
  });

  it("apply: confirm re-sends the PENDING verb (disable) with apply:true, shows Applied, calls onRefresh", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    writeMock
      .mockResolvedValueOnce(env({ diff: REAL_DIFF }))
      .mockResolvedValueOnce(
        env({ diff: REAL_DIFF, applied: true, snapshotId: "snap-99", status: "applied" }),
      );
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & apply" }));

    expect(await screen.findByText("Applied.")).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // The last writeCommand call must be the DISABLE verb, not enable
    expect(writeMock).toHaveBeenLastCalledWith("disable", {
      target: "codex",
      type: "mcp",
      name: "context7",
      apply: true,
    });
  });

  it("apply: the verb sent on confirm is disable (not accidentally flipped to enable)", async () => {
    const user = userEvent.setup();
    writeMock
      .mockResolvedValueOnce(env({ diff: REAL_DIFF }))
      .mockResolvedValueOnce(
        env({ diff: REAL_DIFF, applied: true, snapshotId: null, status: "applied" }),
      );
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & apply" }));

    await screen.findByText("Applied.");
    const lastCall = writeMock.mock.calls[writeMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe("disable");
    expect((lastCall[1] as { apply: boolean }).apply).toBe(true);
  });

  it("enable direction: clicking Enable server dry-runs with verb 'enable'", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: { line: 10, before: "enabled = false", after: "" } }));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Enable server" }));

    await screen.findByRole("button", { name: "Confirm & apply" });
    expect(writeMock).toHaveBeenCalledWith("enable", {
      target: "codex",
      type: "mcp",
      name: "context7",
      apply: false,
    });
  });

  it("loader-unverified caveat: shown when disable dry-run carries the warn diagnostic", async () => {
    const user = userEvent.setup();
    const unverifiedDiag: Diagnostic = {
      severity: "warn",
      code: "config-edit-mcp-loader-unverified",
      message: "Cannot confirm disabled",
    };
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }, [unverifiedDiag]));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText(/can't be verified live/)).toBeInTheDocument();
    // The Confirm button is still present (warn does NOT abort the preview)
    expect(screen.getByRole("button", { name: "Confirm & apply" })).toBeInTheDocument();
  });

  it("loader-unverified caveat: NOT shown when the diagnostic is absent", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ diff: REAL_DIFF }));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    await screen.findByRole("button", { name: "Confirm & apply" });
    expect(screen.queryByText(/can't be verified live/)).not.toBeInTheDocument();
  });

  it("loader-unverified caveat: NOT shown on a no-op even if the diagnostic is present", async () => {
    const user = userEvent.setup();
    const unverifiedDiag: Diagnostic = {
      severity: "warn",
      code: "config-edit-mcp-loader-unverified",
      message: "Cannot confirm disabled",
    };
    // alreadyInState:true means no real diff branch — caveat lives only in the diff branch
    writeMock.mockResolvedValueOnce(env({ alreadyInState: true, diff: null }, [unverifiedDiag]));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText(/nothing to write/)).toBeInTheDocument();
    expect(screen.queryByText(/can't be verified live/)).not.toBeInTheDocument();
  });

  it("no-op (alreadyInState): shows 'nothing to write', no Confirm button, shows Dismiss button", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(env({ alreadyInState: true, diff: null }));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText(/nothing to write/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("error: an error-severity diagnostic on preview surfaces the message and no Confirm", async () => {
    const user = userEvent.setup();
    writeMock.mockResolvedValueOnce(
      env({}, [{ severity: "error", code: "lock-fail", message: "config.toml is locked" }]),
    );
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText("config.toml is locked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & apply" })).not.toBeInTheDocument();
  });

  it("error: a thrown transport error shows its message verbatim", async () => {
    const user = userEvent.setup();
    writeMock.mockRejectedValueOnce(new Error("connection refused"));
    renderWithLang(<McpWriteControl item={MCP_ITEM} target="codex" onRefresh={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Disable server" }));

    expect(await screen.findByText("connection refused")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithLang } from "@/test/utils";
import { ItemInspector, type ShadowInfo } from "@/components/ItemInspector";
import { KIND_CONFIG } from "@/lib/kinds";
import type { KindConfig } from "@/lib/kinds";
import type { InventoryItem, TargetId } from "@/lib/api";

/*
 * Mount the inspector with mocked child controls so we can assert the
 * control-mounting matrix (which toggle/remove slot gets rendered) without
 * depending on the write/remove FSMs or the network.
 */

vi.mock("@/components/PluginWriteControl", () => ({
  PluginWriteControl: () => <div data-testid="plugin-control" />,
}));
vi.mock("@/components/SkillVisibilityControl", () => ({
  SkillVisibilityControl: () => <div data-testid="skill-control" />,
}));
vi.mock("@/components/McpWriteControl", () => ({
  McpWriteControl: () => <div data-testid="mcp-control" />,
}));
vi.mock("@/components/RemoveControl", () => ({
  RemoveControl: () => <div data-testid="remove-control" />,
}));
vi.mock("@/lib/motion", async () => {
  const React = await import("react");
  return { useGsap: () => React.useRef(null) };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cfg = (type: string): KindConfig => {
  const found = KIND_CONFIG.find((c) => c.type === type);
  if (!found) throw new Error(`No KindConfig for type "${type}"`);
  return found;
};

const PLUGIN_ITEM: InventoryItem = {
  kind: "plugin",
  name: "p",
  key: "p@m",
  enabled: true,
};
const SKILL_ITEM: InventoryItem = {
  kind: "skill",
  name: "s",
  path: "/s",
  visibility: "default",
};
const MCP_ITEM: InventoryItem = {
  kind: "mcp",
  name: "m",
  scope: "user",
  transport: "stdio",
};
const AGENT_ITEM: InventoryItem = {
  kind: "agent",
  name: "a",
  path: "/a",
};
const MARKETPLACE_ITEM: InventoryItem = {
  kind: "marketplace",
  name: "mk",
  sourceRepo: "r",
  onDisk: true,
};

interface MountArgs {
  item: InventoryItem;
  type: string;
  target?: TargetId;
  writeKinds: string[];
  removeKinds: string[];
  onClose?: () => void;
  /** shadowing facts for the selected item; null = no collision (the default). */
  shadow?: ShadowInfo | null;
}

function mount({
  item,
  type,
  target = "claude",
  writeKinds,
  removeKinds,
  onClose = vi.fn(),
  shadow = null,
}: MountArgs) {
  return renderWithLang(
    <ItemInspector
      item={item}
      config={cfg(type)}
      shadow={shadow}
      target={target}
      writeKinds={writeKinds}
      removeKinds={removeKinds}
      onRefresh={() => {}}
      onClose={onClose}
    />,
  );
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("ItemInspector — control-mounting matrix", () => {
  it("plugin + writeKinds ['plugin'] + removeKinds [] → plugin-control present; skill/mcp/remove absent; no read-only note", () => {
    mount({
      item: PLUGIN_ITEM,
      type: "plugin",
      writeKinds: ["plugin"],
      removeKinds: [],
    });

    expect(screen.getByTestId("plugin-control")).toBeInTheDocument();
    expect(screen.queryByTestId("skill-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remove-control")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No web write actions for this item/),
    ).not.toBeInTheDocument();
  });

  it("skill (claude) + writeKinds ['plugin','skill'] + removeKinds ['skill','agent','command'] → skill-control AND remove-control present; no read-only note", () => {
    mount({
      item: SKILL_ITEM,
      type: "skill",
      writeKinds: ["plugin", "skill"],
      removeKinds: ["skill", "agent", "command"],
    });

    expect(screen.getByTestId("skill-control")).toBeInTheDocument();
    expect(screen.getByTestId("remove-control")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-control")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No web write actions for this item/),
    ).not.toBeInTheDocument();
  });

  it("mcp + writeKinds ['plugin','mcp'] + removeKinds [] → mcp-control present; remove absent", () => {
    mount({
      item: MCP_ITEM,
      type: "mcp",
      writeKinds: ["plugin", "mcp"],
      removeKinds: [],
    });

    expect(screen.getByTestId("mcp-control")).toBeInTheDocument();
    expect(screen.queryByTestId("remove-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plugin-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skill-control")).not.toBeInTheDocument();
  });

  it("agent + writeKinds ['plugin','skill'] + removeKinds ['skill','agent','command'] → remove-control present; no toggle control (plugin/skill/mcp absent); no read-only note", () => {
    mount({
      item: AGENT_ITEM,
      type: "agent",
      writeKinds: ["plugin", "skill"],
      removeKinds: ["skill", "agent", "command"],
    });

    expect(screen.getByTestId("remove-control")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skill-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-control")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No web write actions for this item/),
    ).not.toBeInTheDocument();
  });

  it("marketplace + writeKinds [] + removeKinds [] → no control testids; read-only note present", () => {
    mount({
      item: MARKETPLACE_ITEM,
      type: "marketplace",
      writeKinds: [],
      removeKinds: [],
    });

    expect(screen.queryByTestId("plugin-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skill-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remove-control")).not.toBeInTheDocument();
    expect(
      screen.getByText(/No web write actions for this item/),
    ).toBeInTheDocument();
  });

  it("per-target gate: mcp + writeKinds ['plugin','skill'] (mcp NOT in writeKinds) + removeKinds [] → mcp-control absent; read-only note present", () => {
    mount({
      item: MCP_ITEM,
      type: "mcp",
      writeKinds: ["plugin", "skill"],
      removeKinds: [],
    });

    expect(screen.queryByTestId("mcp-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remove-control")).not.toBeInTheDocument();
    expect(
      screen.getByText(/No web write actions for this item/),
    ).toBeInTheDocument();
  });

  it("header shows config.type and item.name; Close button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mount({
      item: PLUGIN_ITEM,
      type: "plugin",
      writeKinds: [],
      removeKinds: [],
      onClose,
    });

    // config.type label (uppercased in CSS, but text content is lowercase "plugin")
    expect(screen.getByText("plugin")).toBeInTheDocument();
    // item.name
    expect(screen.getByText("p")).toBeInTheDocument();
    // close button
    const closeBtn = screen.getByRole("button", { name: "Close" });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/*
 * The "Loadability & shadowing" card (only for kinds that can shadow:
 * skill/agent/command). Three mutually exclusive body branches — a real
 * collision (winner vs loser tone), the codex "coexist" note, and the claude
 * "not shadowed" note — plus the whole card being absent for a kind that can't
 * shadow (plugin). The mounting-matrix block above always passes shadow=null, so
 * the collision branch is unique to this block.
 */
describe("ItemInspector — shadowing card", () => {
  const SHADOW = (over: Partial<ShadowInfo> = {}): ShadowInfo => ({
    winnerName: "winner-skill",
    isWinner: true,
    count: 3,
    kind: "skill",
    ...over,
  });

  it("winner: collision badge (kind+count), winner name with ✓, OK-tone badge", () => {
    mount({
      item: SKILL_ITEM,
      type: "skill",
      writeKinds: [],
      removeKinds: [],
      shadow: SHADOW({ isWinner: true }),
    });

    const badge = screen.getByText(/name collision \(3 share this name\)/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("text-ok"); // a confirmed winner reads green
    expect(screen.getByText(/winner-skill ✓/)).toBeInTheDocument();
  });

  it("loser: WARN-tone badge and the winner name WITHOUT the ✓ mark", () => {
    mount({
      item: SKILL_ITEM,
      type: "skill",
      writeKinds: [],
      removeKinds: [],
      shadow: SHADOW({ isWinner: false }),
    });

    expect(screen.getByText(/name collision \(3 share this name\)/)).toHaveClass("text-warn");
    expect(screen.getByText("winner-skill")).toBeInTheDocument(); // names the winner
    expect(screen.queryByText(/✓/)).not.toBeInTheDocument(); // …but THIS item lost
  });

  it("no collision (claude): shows the 'not shadowed' note", () => {
    mount({ item: SKILL_ITEM, type: "skill", writeKinds: [], removeKinds: [], shadow: null });
    expect(screen.getByText(/Not shadowed/)).toBeInTheDocument();
  });

  it("no collision (codex): shows the codex-coexist note instead of 'not shadowed'", () => {
    mount({
      item: SKILL_ITEM,
      type: "skill",
      target: "codex",
      writeKinds: [],
      removeKinds: [],
      shadow: null,
    });
    expect(screen.getByText(/coexist — codex does not shadow/)).toBeInTheDocument();
    expect(screen.queryByText(/Not shadowed/)).not.toBeInTheDocument();
  });

  it("plugin (cannot shadow): no shadowing section at all", () => {
    mount({ item: PLUGIN_ITEM, type: "plugin", writeKinds: [], removeKinds: [], shadow: null });
    expect(screen.queryByText(/Loadability & shadowing/)).not.toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithLang } from "@/test/utils";
import { useLang } from "@/lib/i18n";
import { KIND_CONFIG } from "@/lib/kinds";
import type { ColumnDef } from "@/lib/kinds";
import type { InventoryItem } from "@/lib/api";

// ---------------------------------------------------------------------------
// Probe component — renders a single column cell inside a LangProvider so
// renderers that call ctx.t() or return JSX work correctly.
// ---------------------------------------------------------------------------
function Cell({ col, it: item, target = "claude" }: { col: ColumnDef; it: InventoryItem; target?: "claude" | "codex" }) {
  const { t } = useLang();
  return <>{col.render(item, { t, target })}</>;
}

/** Locate a KindConfig by type. */
function kindByType(type: string) {
  const cfg = KIND_CONFIG.find((c) => c.type === type);
  if (!cfg) throw new Error(`no KindConfig with type="${type}"`);
  return cfg;
}

/** Locate a ColumnDef by headerKey within a KindConfig identified by type. */
function col(type: string, headerKey: string): ColumnDef {
  const cfg = kindByType(type);
  const column = cfg.columns.find((c) => c.headerKey === headerKey);
  if (!column) throw new Error(`no column headerKey="${headerKey}" on type="${type}"`);
  return column;
}

// ---------------------------------------------------------------------------
// 1) Structure checks
// ---------------------------------------------------------------------------
describe("KIND_CONFIG structure", () => {
  it("has exactly 6 entries", () => {
    expect(KIND_CONFIG).toHaveLength(6);
  });

  it("covers the full set of plural keys", () => {
    const keys = new Set(KIND_CONFIG.map((c) => c.key));
    expect(keys).toEqual(
      new Set(["skills", "agents", "commands", "plugins", "marketplaces", "mcpServers"]),
    );
  });

  it("covers the full set of singular types", () => {
    const types = new Set(KIND_CONFIG.map((c) => c.type));
    expect(types).toEqual(
      new Set(["skill", "agent", "command", "plugin", "marketplace", "mcp"]),
    );
  });
});

// ---------------------------------------------------------------------------
// 2) Plural key → singular type mapping
// ---------------------------------------------------------------------------
describe("KIND_CONFIG key→type mapping", () => {
  it('key "skills" maps to type "skill"', () => {
    const entry = KIND_CONFIG.find((c) => c.key === "skills");
    expect(entry?.type).toBe("skill");
  });

  it('key "mcpServers" maps to type "mcp"', () => {
    const entry = KIND_CONFIG.find((c) => c.key === "mcpServers");
    expect(entry?.type).toBe("mcp");
  });

  it('key "marketplaces" maps to type "marketplace"', () => {
    const entry = KIND_CONFIG.find((c) => c.key === "marketplaces");
    expect(entry?.type).toBe("marketplace");
  });
});

// ---------------------------------------------------------------------------
// 3) rowKey behaviour
// ---------------------------------------------------------------------------
describe("rowKey — skill entry", () => {
  const cfg = KIND_CONFIG.find((c) => c.type === "skill")!;

  it("returns path when present", () => {
    expect(cfg.rowKey({ name: "n", path: "/p" } as InventoryItem)).toBe("/p");
  });

  it("falls back to name when path is absent", () => {
    expect(cfg.rowKey({ name: "n" } as InventoryItem)).toBe("n");
  });
});

describe("rowKey — plugin entry", () => {
  const cfg = KIND_CONFIG.find((c) => c.type === "plugin")!;

  it("returns key when present", () => {
    expect(cfg.rowKey({ name: "n", key: "k@m" } as InventoryItem)).toBe("k@m");
  });

  it("falls back to name when key is absent", () => {
    expect(cfg.rowKey({ name: "n" } as InventoryItem)).toBe("n");
  });
});

describe("rowKey — mcp entry", () => {
  const cfg = KIND_CONFIG.find((c) => c.type === "mcp")!;

  it("returns name", () => {
    expect(cfg.rowKey({ name: "n" } as InventoryItem)).toBe("n");
  });
});

describe("rowKey — marketplace entry", () => {
  const cfg = KIND_CONFIG.find((c) => c.type === "marketplace")!;

  it("returns name", () => {
    expect(cfg.rowKey({ name: "n" } as InventoryItem)).toBe("n");
  });
});

// ---------------------------------------------------------------------------
// 4) shadowKind
// ---------------------------------------------------------------------------
describe("shadowKind", () => {
  it("skill entry has shadowKind === 'skill'", () => {
    expect(kindByType("skill").shadowKind).toBe("skill");
  });

  it("agent entry has shadowKind === 'agent'", () => {
    expect(kindByType("agent").shadowKind).toBe("agent");
  });

  it("command entry has shadowKind === 'command'", () => {
    expect(kindByType("command").shadowKind).toBe("command");
  });

  it("plugin entry has shadowKind === undefined", () => {
    expect(kindByType("plugin").shadowKind).toBeUndefined();
  });

  it("marketplace entry has shadowKind === undefined", () => {
    expect(kindByType("marketplace").shadowKind).toBeUndefined();
  });

  it("mcp entry has shadowKind === undefined", () => {
    expect(kindByType("mcp").shadowKind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5) Column renderers
// ---------------------------------------------------------------------------

describe("plugin col.enabled renderer", () => {
  const enabledCol = col("plugin", "col.enabled");

  it("renders 'enabled' badge when enabled:true", () => {
    renderWithLang(
      <Cell col={enabledCol} it={{ name: "p", enabled: true } as InventoryItem} />,
    );
    expect(screen.getByText("enabled")).toBeInTheDocument();
  });

  it("renders 'disabled' badge when enabled:false", () => {
    renderWithLang(
      <Cell col={enabledCol} it={{ name: "p", enabled: false } as InventoryItem} />,
    );
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });
});

describe("skill col.source renderer", () => {
  const sourceCol = col("skill", "col.source");

  it("renders 'plugin:foo' when source.plugin is set", () => {
    renderWithLang(
      <Cell col={sourceCol} it={{ name: "s", source: { plugin: "foo" } } as InventoryItem} />,
    );
    expect(screen.getByText("plugin:foo")).toBeInTheDocument();
  });

  it("renders the tier string when source.tier is set and no plugin", () => {
    renderWithLang(
      <Cell col={sourceCol} it={{ name: "s", source: { tier: "user" } } as InventoryItem} />,
    );
    expect(screen.getByText("user")).toBeInTheDocument();
  });

  it("renders em-dash when source is absent", () => {
    renderWithLang(
      <Cell col={sourceCol} it={{ name: "s" } as InventoryItem} />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("skill col.visibility renderer", () => {
  const visCol = col("skill", "col.visibility");

  it("renders a badge with 'off' when visibility is 'off'", () => {
    renderWithLang(
      <Cell col={visCol} it={{ name: "s", visibility: "off" } as InventoryItem} />,
    );
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("renders the translated 'default' label when visibility is 'default'", () => {
    renderWithLang(
      <Cell col={visCol} it={{ name: "s", visibility: "default" } as InventoryItem} />,
    );
    // EN["dash.visDefault"] === "default"
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("renders em-dash when visibility is undefined", () => {
    renderWithLang(
      <Cell col={visCol} it={{ name: "s" } as InventoryItem} />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("marketplace col.onDisk renderer", () => {
  const onDiskCol = col("marketplace", "col.onDisk");

  it("renders 'on disk' badge when onDisk:true", () => {
    renderWithLang(
      <Cell col={onDiskCol} it={{ name: "m", onDisk: true } as InventoryItem} />,
    );
    expect(screen.getByText("on disk")).toBeInTheDocument();
  });

  it("renders 'not on disk' badge when onDisk:false", () => {
    renderWithLang(
      <Cell col={onDiskCol} it={{ name: "m", onDisk: false } as InventoryItem} />,
    );
    expect(screen.getByText("not on disk")).toBeInTheDocument();
  });
});

describe("skill col.name renderer", () => {
  const nameCol = col("skill", "col.name");

  it("returns the item name", () => {
    renderWithLang(
      <Cell col={nameCol} it={{ name: "myskill" } as InventoryItem} />,
    );
    expect(screen.getByText("myskill")).toBeInTheDocument();
  });
});

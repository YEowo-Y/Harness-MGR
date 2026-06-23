/*
 * KIND configuration — the single source that drives the kind-switchable Dashboard.
 *
 * Each entry maps a KPI/inventory kind to: its `inventory --type` value, its KPI
 * icon + category color, the TABLE columns to show, and the INSPECTOR detail
 * sections. Adding a column or detail field is a one-line edit here — the Dashboard
 * table and the inspector both render straight from this config, so there is exactly
 * one place per kind instead of six bespoke table/detail implementations.
 *
 * Field availability differs by kind (see InventoryItem): skill/agent/command carry
 * frontmatter+source+path; plugin carries key/marketplace/version/enabled/cache; mcp
 * carries scope/transport/command/args/envKeys; marketplace carries
 * sourceRepo/onDisk/installLocation. Renderers that reference a missing field return
 * a dash or null so the row/field simply degrades.
 */
import type { ReactNode } from "react";
import {
  Sparkles,
  Bot,
  SquareTerminal,
  Blocks,
  Store,
  Plug,
  type LucideIcon,
} from "lucide-react";
import { Badge, type Tone } from "@/components/ui";
import type { StringKey, TFn } from "@/lib/i18n";
import type { InventoryItem, InventoryCounts, TargetId } from "@/lib/api";

export interface RenderCtx {
  t: TFn;
  target: TargetId;
}

export interface ColumnDef {
  headerKey: StringKey;
  /** extra classes for the <td> (e.g. font-mono, text-ink, truncate max-w-…) */
  cellClass?: string;
  render: (it: InventoryItem, ctx: RenderCtx) => ReactNode;
}

export interface DetailField {
  labelKey: StringKey;
  /** return null to hide the field entirely for this item */
  render: (it: InventoryItem, ctx: RenderCtx) => ReactNode | null;
}

export interface DetailSection {
  titleKey: StringKey;
  fields: DetailField[];
}

export interface KindConfig {
  /** matches an InventoryCounts key + the KPI card */
  key: keyof InventoryCounts;
  /** the `inventory --type` value (singular) */
  type: string;
  labelKey: StringKey;
  icon: LucideIcon;
  color: string;
  /** stable React key + selection identity */
  rowKey: (it: InventoryItem) => string;
  /** conflict kind for the shadowing card, or undefined when the kind cannot shadow */
  shadowKind?: string;
  columns: ColumnDef[];
  sections: DetailSection[];
}

const VIS_TONE: Record<string, Tone> = {
  default: "neutral",
  on: "ok",
  off: "danger",
  "name-only": "warn",
  "user-invocable-only": "info",
};

const tierOf = (it: InventoryItem): string =>
  it.source?.plugin ? `plugin:${it.source.plugin}` : (it.source?.tier ?? "—");

const dash = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "—" : String(v);

/** A plain text value field for the inspector, or null when empty. */
function textField(labelKey: StringKey, get: (it: InventoryItem) => unknown): DetailField {
  return {
    labelKey,
    render: (it) => {
      const v = get(it);
      return v === undefined || v === null || v === "" ? null : String(v);
    },
  };
}

function monoField(labelKey: StringKey, get: (it: InventoryItem) => unknown): DetailField {
  return {
    labelKey,
    render: (it) => {
      const v = get(it);
      if (v === undefined || v === null || v === "") return null;
      return <span className="break-all font-mono text-[12.5px]">{String(v)}</span>;
    },
  };
}

export const KIND_CONFIG: KindConfig[] = [
  {
    key: "skills",
    type: "skill",
    labelKey: "dash.kpi.skills",
    icon: Sparkles,
    color: "var(--cat-skill)",
    rowKey: (it) => it.path ?? it.name,
    shadowKind: "skill",
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      { headerKey: "col.source", cellClass: "text-i60", render: (it) => tierOf(it) },
      {
        headerKey: "col.visibility",
        render: (it, { t }) => {
          const vis = it.visibility;
          if (vis && vis !== "default")
            return <Badge tone={VIS_TONE[vis] ?? "neutral"}>{vis}</Badge>;
          return (
            <span className="text-[13px] text-i42">
              {vis === "default" ? t("dash.visDefault") : "—"}
            </span>
          );
        },
      },
      {
        headerKey: "col.description",
        cellClass: "max-w-[560px] truncate text-i60",
        render: (it) => it.frontmatter?.description || "—",
      },
    ],
    sections: [
      {
        titleKey: "inspector.governance",
        fields: [
          textField("inspector.tier", (it) => tierOf(it)),
          textField("inspector.marketplace", (it) => it.source?.marketplace),
          monoField("inspector.version", (it) => it.source?.version),
          {
            labelKey: "inspector.visibility",
            render: (it) =>
              it.visibility === undefined ? null : (
                <Badge tone={VIS_TONE[it.visibility] ?? "neutral"}>{it.visibility}</Badge>
              ),
          },
          {
            labelKey: "inspector.controlledBy",
            render: (it, { t }) =>
              it.visibility === undefined
                ? null
                : it.visibility !== "default"
                  ? t("inspector.controlledBy.settings")
                  : t("inspector.controlledBy.default"),
          },
        ],
      },
      {
        titleKey: "inspector.frontmatter",
        fields: [
          textField("inspector.description", (it) => it.frontmatter?.description),
          textField("inspector.origin", (it) => it.frontmatter?.origin),
          monoField("inspector.tools", (it) => it.frontmatter?.tools),
        ],
      },
    ],
  },
  {
    key: "agents",
    type: "agent",
    labelKey: "dash.kpi.agents",
    icon: Bot,
    color: "var(--cat-agent)",
    rowKey: (it) => it.path ?? it.name,
    shadowKind: "agent",
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      { headerKey: "col.source", cellClass: "text-i60", render: (it) => tierOf(it) },
      {
        headerKey: "col.model",
        cellClass: "text-i60",
        render: (it) => dash(it.frontmatter?.model),
      },
      {
        headerKey: "col.description",
        cellClass: "max-w-[520px] truncate text-i60",
        render: (it) => it.frontmatter?.description || "—",
      },
    ],
    sections: [
      {
        titleKey: "inspector.governance",
        fields: [textField("inspector.tier", (it) => tierOf(it))],
      },
      {
        titleKey: "inspector.frontmatter",
        fields: [
          textField("inspector.description", (it) => it.frontmatter?.description),
          textField("inspector.model", (it) => it.frontmatter?.model),
          monoField("inspector.disallowedTools", (it) => it.frontmatter?.disallowedTools),
          monoField("inspector.tools", (it) => it.frontmatter?.tools),
        ],
      },
    ],
  },
  {
    key: "commands",
    type: "command",
    labelKey: "dash.kpi.commands",
    icon: SquareTerminal,
    color: "var(--cat-command)",
    rowKey: (it) => it.path ?? it.name,
    shadowKind: "command",
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      { headerKey: "col.source", cellClass: "text-i60", render: (it) => tierOf(it) },
      {
        headerKey: "col.description",
        cellClass: "max-w-[640px] truncate text-i60",
        render: (it) => it.frontmatter?.description || "—",
      },
    ],
    sections: [
      {
        titleKey: "inspector.governance",
        fields: [textField("inspector.tier", (it) => tierOf(it))],
      },
      {
        titleKey: "inspector.frontmatter",
        fields: [textField("inspector.description", (it) => it.frontmatter?.description)],
      },
    ],
  },
  {
    key: "plugins",
    type: "plugin",
    labelKey: "dash.kpi.plugins",
    icon: Blocks,
    color: "var(--cat-plugin)",
    rowKey: (it) => it.key ?? it.name,
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      {
        headerKey: "col.marketplace",
        cellClass: "text-i60",
        render: (it) => dash(it.marketplace),
      },
      {
        headerKey: "col.version",
        cellClass: "font-mono text-i60",
        render: (it) => dash(it.version),
      },
      {
        headerKey: "col.enabled",
        render: (it, { t }) =>
          it.enabled ? (
            <Badge tone="ok">{t("badge.enabled")}</Badge>
          ) : (
            <Badge tone="neutral">{t("badge.disabled")}</Badge>
          ),
      },
    ],
    sections: [
      {
        titleKey: "inspector.details",
        fields: [
          monoField("inspector.key", (it) => it.key),
          textField("inspector.marketplace", (it) => it.marketplace),
          monoField("inspector.version", (it) => it.version),
          {
            labelKey: "inspector.enabled",
            render: (it, { t }) =>
              it.enabled ? (
                <Badge tone="ok">{t("badge.enabled")}</Badge>
              ) : (
                <Badge tone="neutral">{t("badge.disabled")}</Badge>
              ),
          },
          {
            labelKey: "inspector.cachePresent",
            render: (it, { t }) =>
              it.cachePresent === undefined ? null : it.cachePresent ? (
                <Badge tone="ok">{t("badge.cached")}</Badge>
              ) : (
                <Badge tone="warn">{t("badge.missing")}</Badge>
              ),
          },
        ],
      },
    ],
  },
  {
    key: "marketplaces",
    type: "marketplace",
    labelKey: "dash.kpi.marketplaces",
    icon: Store,
    color: "var(--cat-market)",
    rowKey: (it) => it.name,
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      {
        headerKey: "col.sourceRepo",
        cellClass: "font-mono text-i60",
        render: (it) => dash(it.sourceRepo),
      },
      {
        headerKey: "col.onDisk",
        render: (it, { t }) =>
          it.onDisk ? (
            <Badge tone="ok">{t("badge.onDisk")}</Badge>
          ) : (
            <Badge tone="warn">{t("badge.notOnDisk")}</Badge>
          ),
      },
    ],
    sections: [
      {
        titleKey: "inspector.details",
        fields: [
          monoField("inspector.sourceRepo", (it) => it.sourceRepo),
          {
            labelKey: "inspector.onDisk",
            render: (it, { t }) =>
              it.onDisk ? (
                <Badge tone="ok">{t("badge.onDisk")}</Badge>
              ) : (
                <Badge tone="warn">{t("badge.notOnDisk")}</Badge>
              ),
          },
          monoField("inspector.installLocation", (it) => it.installLocation),
        ],
      },
    ],
  },
  {
    key: "mcpServers",
    type: "mcp",
    labelKey: "dash.kpi.mcpServers",
    icon: Plug,
    color: "var(--cat-mcp)",
    rowKey: (it) => it.name,
    columns: [
      { headerKey: "col.name", cellClass: "font-mono text-ink", render: (it) => it.name },
      { headerKey: "col.scope", cellClass: "text-i60", render: (it) => dash(it.scope) },
      {
        headerKey: "col.transport",
        cellClass: "text-i60",
        render: (it) => dash(it.transport),
      },
      {
        headerKey: "col.command",
        cellClass: "font-mono text-i60 max-w-[360px] truncate",
        render: (it) => dash(it.command),
      },
    ],
    sections: [
      {
        titleKey: "inspector.config",
        fields: [
          textField("inspector.scope", (it) => it.scope),
          textField("inspector.transport", (it) => it.transport),
          monoField("inspector.command", (it) => it.command),
          monoField("inspector.args", (it) => it.args?.join(" ")),
          monoField("inspector.envKeys", (it) => it.envKeys?.join(", ")),
        ],
      },
    ],
  },
];

export type KindKey = (typeof KIND_CONFIG)[number]["key"];

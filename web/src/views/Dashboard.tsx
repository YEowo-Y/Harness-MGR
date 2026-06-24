import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import gsap from "gsap";
import {
  fetchCommand,
  type InventoryListResult,
  type InventoryItem,
  type ConflictResult,
  type TargetId,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { useLang } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";
import { Panel, Loading, ErrorBox, Empty } from "@/components/ui";
import { ItemInspector, type ShadowInfo } from "@/components/ItemInspector";
import {
  KIND_CONFIG,
  type KindConfig,
  type KindKey,
  type RenderCtx,
} from "@/lib/kinds";

export function Dashboard({
  target,
  activeKind,
  reloadKey,
  writeKinds,
  onRefresh,
}: {
  target: TargetId;
  /** which inventory kind to show — driven by the sidebar selection */
  activeKind: KindKey;
  reloadKey: number;
  writeKinds: string[];
  onRefresh: () => void;
}) {
  const { t } = useLang();
  const config = KIND_CONFIG.find((k) => k.key === activeKind) ?? KIND_CONFIG[0];

  const list = useApi(
    () =>
      fetchCommand<InventoryListResult>("inventory", {
        target,
        type: config.type,
      }),
    [target, reloadKey, config.type],
  );
  // Name collisions, for the inspector's shadowing card. Engine is the source of
  // truth — we never recompute resolution order client-side.
  const conflicts = useApi(
    () => fetchCommand<ConflictResult>("conflicts", { target }),
    [target, reloadKey],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  // list.data lags one render behind config.type on a kind switch, so only treat the
  // list as the active kind's once the refetch for THIS kind has landed — this gates
  // out the one-frame flash of new columns over old rows.
  const dataMatches = list.data?.result.type === config.type;
  const items = dataMatches ? (list.data?.result.items ?? []) : [];

  // Reset selection + filter when the kind / target / data changes, so each kind
  // starts from a clean, unfiltered table.
  useEffect(() => {
    setSelected(null);
    setQuery("");
  }, [activeKind, target, reloadKey]);

  // path → shadowing facts, from EVERY conflict cluster (skill/agent/command).
  const shadowByPath = useMemo(() => {
    const map = new Map<string, ShadowInfo>();
    for (const c of conflicts.data?.result.conflicts ?? []) {
      const winnerName = c.likelyWinner?.name ?? "";
      const count = c.possibleWinners?.length ?? 0;
      for (const member of c.possibleWinners ?? []) {
        map.set(member.path, {
          winnerName,
          isWinner: member.path === c.likelyWinner?.path,
          count,
          kind: c.kind,
        });
      }
    }
    return map;
  }, [conflicts.data]);

  const shadow =
    selected?.path !== undefined ? (shadowByPath.get(selected.path) ?? null) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => searchText(it).includes(q));
  }, [items, query]);

  // Re-stagger the rows whenever the kind switches or the data reloads (amount-capped
  // so hundreds of rows stay snappy).
  const tableRef = useGsap<HTMLDivElement>(
    () =>
      gsap.from("tbody tr", {
        opacity: 0,
        y: 6,
        duration: 0.3,
        ease: "power3.out",
        stagger: { amount: 0.4 },
      }),
    [activeKind, target, reloadKey, items.length],
  );

  const ctx: RenderCtx = { t, target };

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:flex-row lg:items-stretch lg:gap-6">
      <Panel
        className="flex min-h-0 flex-1 flex-col"
        title={t("dash.kindTitle", { kind: t(config.labelKey), target })}
        action={
          <div className="flex items-center gap-1.5 rounded-md border border-hair2 bg-bg px-2.5 py-1.5 normal-case">
            <Search size={13} className="text-i42" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("common.filter")}
              className="w-40 bg-transparent text-[13px] text-ink outline-none placeholder:text-i42"
            />
          </div>
        }
      >
        {list.error ? (
          <ErrorBox message={list.error} />
        ) : list.loading || !dataMatches ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <Empty label={query ? t("dash.noMatchItems") : t("dash.noItems")} />
        ) : (
          <div ref={tableRef} className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-tint text-xs font-semibold uppercase tracking-wider text-i42">
                  {config.columns.map((col) => (
                    <th key={col.headerKey} className="px-4 py-2.5 font-semibold">
                      {t(col.headerKey)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <ItemRow
                    key={config.rowKey(it)}
                    item={it}
                    config={config}
                    ctx={ctx}
                    selected={
                      selected ? config.rowKey(selected) === config.rowKey(it) : false
                    }
                    onSelect={() => setSelected(it)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-hair px-4 py-2.5 text-xs text-i42">
          {t("dash.itemCount", { shown: filtered.length, total: items.length })}
        </div>
      </Panel>

      {selected &&
        items.some((it) => config.rowKey(it) === config.rowKey(selected)) && (
          <ItemInspector
            item={selected}
            config={config}
            shadow={shadow}
            target={target}
            writeKinds={writeKinds}
            onRefresh={onRefresh}
            onClose={() => setSelected(null)}
          />
        )}
    </div>
  );
}

/** Concatenate an item's searchable text across whichever fields the kind carries. */
function searchText(it: InventoryItem): string {
  return [
    it.name,
    it.frontmatter?.description,
    it.frontmatter?.model,
    it.marketplace,
    it.sourceRepo,
    it.scope,
    it.transport,
    it.command,
    it.key,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function ItemRow({
  item,
  config,
  ctx,
  selected,
  onSelect,
}: {
  item: InventoryItem;
  config: KindConfig;
  ctx: RenderCtx;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "cursor-pointer border-t border-hair align-middle transition-colors",
        selected ? "bg-sel" : "even:bg-zebra hover:bg-tint",
      )}
    >
      {config.columns.map((col) => (
        <td
          key={col.headerKey}
          className={cn("px-4 py-2.5 text-[13.5px]", col.cellClass)}
        >
          {col.render(item, ctx)}
        </td>
      ))}
    </tr>
  );
}

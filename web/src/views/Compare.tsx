import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import gsap from "gsap";
import {
  fetchCommand,
  type CompareResult,
  type CompareCategory,
  type Presence,
  type TargetId,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useLang, type StringKey, type TFn } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";
import {
  Panel,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  type Tone,
} from "@/components/ui";

const PRESENCE_FILTERS: { id: Presence | "all"; labelKey: StringKey }[] = [
  { id: "all", labelKey: "compare.filter.all" },
  { id: "both", labelKey: "compare.filter.both" },
  { id: "claude-only", labelKey: "compare.filter.claudeOnly" },
  { id: "codex-only", labelKey: "compare.filter.codexOnly" },
];

const PRESENCE_TONE: Record<Presence, Tone> = {
  both: "neutral",
  "claude-only": "accent",
  "codex-only": "info",
};

const PRESENCE_KEY: Record<Presence, StringKey> = {
  both: "compare.presence.both",
  "claude-only": "compare.presence.claude-only",
  "codex-only": "compare.presence.codex-only",
};

export function Compare({ reloadKey }: { target: TargetId; reloadKey: number }) {
  const { t } = useLang();
  // Compare is inherently cross-target — it always diffs claude vs codex
  // regardless of the active target, so it does not depend on `target`.
  const cmp = useApi(
    () => fetchCommand<CompareResult>("compare", { detail: "1" }),
    [reloadKey],
  );

  const [presence, setPresence] = useState<Presence | "all">("all");
  const [query, setQuery] = useState("");

  const result = cmp.data?.result;
  const items = result?.items ?? [];
  const maxTotal = useMemo(
    () =>
      Math.max(
        1,
        ...(result?.categories ?? []).map(
          (c) => c.both + (c.only.claude ?? 0) + (c.only.codex ?? 0),
        ),
      ),
    [result],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (it) =>
        (presence === "all" || it.presence === presence) &&
        (!q || it.name.toLowerCase().includes(q)),
    );
  }, [items, presence, query]);

  // Grow each stacked bar from the left once the comparison lands (design §3:
  // bar scaleX grow). Scoped to the per-kind panel; reverts cleanly on reload.
  const barsRef = useGsap<HTMLDivElement>(
    () =>
      gsap.from(".cmp-bar", {
        scaleX: 0,
        transformOrigin: "left center",
        duration: 0.5,
        ease: "power2.out",
        stagger: { amount: 0.3 },
      }),
    [result?.categories.length ?? 0, reloadKey],
  );

  if (cmp.loading) return <Loading label={t("compare.comparing")} />;
  if (cmp.error) return <ErrorBox message={cmp.error} />;
  if (!result) return <Empty label={t("compare.noData")} />;

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* Wide two-column split: the summary (totals + per-kind bars) stays put on
          the left while the long divergent list scrolls in its own region on the
          right. Pinning everything stacked vertically starved the list (the bars
          panel alone is ~400px tall), so the overview lives beside the list. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,440px)_1fr] gap-6">
        {/* summary column — scrolls internally if it ever outgrows the height */}
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pr-1">
          {/* totals */}
          <section className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-hair bg-hair">
            {result.targets.map((tt) => (
              <div key={tt.id} className="bg-surface px-6 py-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-i42">
                  {tt.label}
                </div>
                <div className="tnum mt-1.5 font-sans text-[38px] font-semibold leading-none text-ink">
                  {tt.total}
                </div>
                <div className="mt-1 text-xs text-i42">
                  {t("compare.componentsUnit")}
                </div>
              </div>
            ))}
          </section>

          {/* per-kind composition */}
          <Panel className="shrink-0" title={t("compare.byKindTitle")}>
            <div ref={barsRef} className="flex flex-col">
              {result.categories.map((c) => (
                <CategoryRow key={c.category} cat={c} maxTotal={maxTotal} t={t} />
              ))}
            </div>
            <Legend t={t} />
          </Panel>
        </div>

        {/* divergent list — fills the column height; only this list scrolls */}
        <Panel
          className="flex min-h-0 flex-col"
          title={t("compare.componentsTitle", { n: filtered.length })}
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
          <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-hair px-4 py-3">
            {PRESENCE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setPresence(f.id)}
                className={
                  "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                  (presence === f.id
                    ? "bg-sel text-ink"
                    : "text-i60 hover:bg-tint hover:text-ink")
                }
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <Empty label={t("compare.noMatch")} />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-tint text-xs font-semibold uppercase tracking-wider text-i42">
                    <th className="px-4 py-2.5 font-semibold">{t("col.name")}</th>
                    <th className="px-4 py-2.5 font-semibold">{t("compare.col.kind")}</th>
                    <th className="px-4 py-2.5 font-semibold">
                      {t("compare.col.presence")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <tr
                      key={`${it.category}:${it.key}`}
                      className="border-t border-hair even:bg-zebra hover:bg-tint"
                    >
                      <td className="px-4 py-2 font-mono text-[13.5px] text-ink">
                        {it.name}
                      </td>
                      <td className="px-4 py-2 text-[13.5px] text-i60">
                        {it.category}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={PRESENCE_TONE[it.presence]}>
                          {t(PRESENCE_KEY[it.presence])}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <p className="shrink-0 px-1 text-xs leading-relaxed text-i42">
        {t("compare.caveatBefore")}{" "}
        <span className="text-i60">{t("compare.caveatKey")}</span>
        {t("compare.caveatAfter")}
      </p>
    </div>
  );
}

function CategoryRow({
  cat,
  maxTotal,
  t,
}: {
  cat: CompareCategory;
  maxTotal: number;
  t: TFn;
}) {
  const onlyClaude = cat.only.claude ?? 0;
  const onlyCodex = cat.only.codex ?? 0;
  const total = cat.both + onlyClaude + onlyCodex;
  const barPct = (total / maxTotal) * 100;
  const seg = (n: number) => (total ? (n / total) * 100 : 0);

  return (
    <div className="border-b border-hair px-4 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize text-ink">
          {cat.category}
        </span>
        <span className="flex items-center gap-2 font-mono text-xs text-i60">
          <span className="text-i42">
            {cat.both} {t("compare.presence.both")}
          </span>
          <span className="text-accent-text">{onlyClaude} claude</span>
          <span className="text-info">{onlyCodex} codex</span>
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-tint">
        <div className="cmp-bar flex h-full" style={{ width: `${barPct}%` }}>
          <span
            className="h-full bg-i42/40"
            style={{ width: `${seg(cat.both)}%` }}
            title={`${cat.both} ${t("compare.presence.both")}`}
          />
          <span
            className="h-full bg-accent"
            style={{ width: `${seg(onlyClaude)}%` }}
            title={`${onlyClaude} ${t("compare.presence.claude-only")}`}
          />
          <span
            className="h-full bg-info"
            style={{ width: `${seg(onlyCodex)}%` }}
            title={`${onlyCodex} ${t("compare.presence.codex-only")}`}
          />
        </div>
      </div>
    </div>
  );
}

function Legend({ t }: { t: TFn }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-hair px-4 py-2.5 text-[11px] text-i60">
      <Swatch className="bg-i42/40" label={t("compare.legend.both")} />
      <Swatch className="bg-accent" label={t("compare.legend.claudeOnly")} />
      <Swatch className="bg-info" label={t("compare.legend.codexOnly")} />
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

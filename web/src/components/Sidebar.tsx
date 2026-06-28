import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  GitCompareArrows,
  Stethoscope,
  Moon,
  Sun,
  RefreshCw,
  ShieldCheck,
  FilePen,
  AlertTriangle,
  Radio,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";
import { useLang, type StringKey } from "@/lib/i18n";
import { prefersReducedMotion } from "@/lib/motion";
import type { StatusInfo, TargetId, InventoryCounts } from "@/lib/api";
import type { LiveStatus } from "@/lib/useLiveReload";
import { KIND_CONFIG, type KindKey } from "@/lib/kinds";

/** A left-rail selection: one inventory kind, or an analysis view. */
export type Section = KindKey | "compare" | "doctor";

/** Live-indicator dot colour + label per connection state. */
/** Live-indicator icon colour per connection state (icon-only status chip). */
const LIVE_ICON: Record<LiveStatus, string> = {
  live: "text-ok",
  connecting: "text-i42",
  offline: "text-danger",
};
const LIVE_LABEL: Record<LiveStatus, StringKey> = {
  live: "sidebar.live",
  connecting: "sidebar.connecting",
  offline: "sidebar.offline",
};

/** The analysis group — cross-cutting views that are not a single kind. */
const ANALYSIS: { id: Section; labelKey: StringKey; icon: LucideIcon }[] = [
  { id: "compare", labelKey: "nav.compare", icon: GitCompareArrows },
  { id: "doctor", labelKey: "nav.doctor", icon: Stethoscope },
];

export function Sidebar(props: {
  section: Section;
  onSection: (s: Section) => void;
  counts: InventoryCounts | undefined;
  target: TargetId;
  onTarget: (t: TargetId) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  lang: "zh" | "en";
  onToggleLang: () => void;
  loading: boolean;
  onReload: () => void;
  status: StatusInfo | null;
  statusError: string | null;
  live: LiveStatus;
}) {
  const { t } = useLang();
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // Capability chip: honest per-target write state. Both axes count (a state
  // toggle OR a destructive remove). status is null before load / on error →
  // treat as read-only (never claim a capability we haven't confirmed).
  const canWrite =
    (props.status?.writeKinds.length ?? 0) +
      (props.status?.removeKinds.length ?? 0) >
    0;

  // Slide a coral marker to the active nav item (design §3: sliding nav indicator).
  // It ALWAYS lands on the right item — under reduced-motion duration collapses to
  // 0 (snap, no slide) rather than skipping, so the marker is never left behind.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    gsap.to(indicator, {
      y: active.offsetTop,
      height: active.offsetHeight,
      autoAlpha: 1,
      duration: prefersReducedMotion() ? 0 : 0.3,
      ease: "power2.out",
    });
  }, [props.section]);

  return (
    <aside className="flex h-full w-[240px] flex-col border-r border-hair bg-panel px-3 py-4">
      {/* brand */}
      <div className="mb-5 flex shrink-0 items-center gap-2 px-2">
        <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="font-sans text-[17px] font-semibold tracking-tight text-ink">
          claude-mgr
        </span>
      </div>

      {/* nav — inventory kinds + analysis views, scrolls if the rail is short */}
      <nav
        ref={navRef}
        className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
      >
        <span
          ref={indicatorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 w-[3px] rounded-full bg-accent"
          style={{ opacity: 0 }}
        />

        <GroupLabel>{t("sidebar.inventory")}</GroupLabel>
        {KIND_CONFIG.map(({ key, labelKey, icon: Icon, color }) => {
          const active = props.section === key;
          const count = props.counts?.[key];
          return (
            <button
              key={key}
              onClick={() => props.onSection(key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors",
                active ? "bg-sel text-ink" : "text-i60 hover:bg-tint hover:text-ink",
              )}
            >
              <Icon
                size={16}
                className="shrink-0"
                style={{ color: active ? color : "var(--i42)" }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
              <span className="tnum text-xs text-i42">
                {count === undefined ? "" : count}
              </span>
            </button>
          );
        })}

        <GroupLabel className="mt-3">{t("sidebar.analysis")}</GroupLabel>
        {ANALYSIS.map(({ id, labelKey, icon: Icon }) => {
          const active = props.section === id;
          return (
            <button
              key={id}
              onClick={() => props.onSection(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors",
                active ? "bg-sel text-ink" : "text-i60 hover:bg-tint hover:text-ink",
              )}
            >
              <Icon
                size={16}
                className={cn("shrink-0", active ? "text-accent" : "text-i42")}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* pinned bottom block — target, controls, status */}
      <div className="shrink-0">
        {/* target switch */}
        <div className="mt-4 px-1">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-i42">
            {t("sidebar.target")}
          </div>
          <div className="inline-flex w-full overflow-hidden rounded-md border border-hair2">
            {(["claude", "codex"] as TargetId[]).map((tg) => (
              <button
                key={tg}
                onClick={() => props.onTarget(tg)}
                className={cn(
                  "flex-1 px-2 py-2 text-[13px] font-medium capitalize transition-colors",
                  props.target === tg
                    ? "bg-surface text-ink"
                    : "text-i60 hover:bg-tint hover:text-ink",
                )}
              >
                {tg}
              </button>
            ))}
          </div>
        </div>

        {/* controls — icon-only chips so the narrow rail never wraps a status label */}
        <div className="mb-3 mt-4 flex items-center gap-1.5 px-1">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-okbg text-ok"
            title={t(canWrite ? "sidebar.writeEnabled" : "sidebar.readonly")}
            aria-label={t(canWrite ? "sidebar.writeEnabled" : "sidebar.readonly")}
          >
            {canWrite ? (
              <FilePen size={14} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
          </span>
          <span
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md border border-hair2",
              LIVE_ICON[props.live],
            )}
            title={t(LIVE_LABEL[props.live])}
            aria-label={t(LIVE_LABEL[props.live])}
          >
            <Radio
              size={14}
              aria-hidden="true"
              className={
                props.live === "live"
                  ? "animate-pulse motion-reduce:animate-none"
                  : ""
              }
            />
          </span>
          <button
            onClick={props.onToggleLang}
            className="ml-auto inline-flex h-7 min-w-[28px] items-center justify-center rounded-md border border-hair2 px-1.5 text-[11px] font-semibold text-i60 transition-colors hover:bg-tint hover:text-ink"
            aria-label={t("sidebar.toggleLang")}
            title={t("sidebar.toggleLang")}
          >
            {props.lang === "zh" ? "EN" : "中"}
          </button>
          <button
            onClick={props.onReload}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-hair2 text-i60 transition-colors hover:bg-tint hover:text-ink"
            aria-label={t("sidebar.reload")}
            title={t("sidebar.reload")}
          >
            <RefreshCw size={14} className={props.loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={props.onToggleTheme}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-hair2 text-i60 transition-colors hover:bg-tint hover:text-ink"
            aria-label={t("sidebar.toggleTheme")}
            title={t("sidebar.toggleTheme")}
          >
            {props.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>

        {/* footer status */}
        <div className="border-t border-hair px-1 pt-3 font-mono text-[10px] leading-relaxed text-i42">
          {props.statusError ? (
            <div
              className="flex items-center gap-1 text-danger"
              title={props.statusError}
            >
              <AlertTriangle size={11} className="shrink-0" />
              {t("sidebar.engineUnreachable")}
            </div>
          ) : (
            <>
              <div>v{props.status?.version ?? "…"}</div>
              <div className="truncate" title={props.status?.configDir}>
                {props.status?.configDir ?? "…"}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function GroupLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-i42",
        className,
      )}
    >
      {children}
    </div>
  );
}

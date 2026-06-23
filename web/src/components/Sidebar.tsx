import { useLayoutEffect, useRef } from "react";
import {
  LayoutDashboard,
  GitCompareArrows,
  Stethoscope,
  Moon,
  Sun,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Languages,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";
import { useLang, type StringKey } from "@/lib/i18n";
import { prefersReducedMotion } from "@/lib/motion";
import type { StatusInfo, TargetId } from "@/lib/api";
import type { LiveStatus } from "@/lib/useLiveReload";

export type View = "dashboard" | "compare" | "doctor";

/** Live-indicator dot colour + label per connection state. */
const LIVE_DOT: Record<LiveStatus, string> = {
  live: "bg-ok",
  connecting: "bg-i42",
  offline: "bg-danger",
};
const LIVE_LABEL: Record<LiveStatus, StringKey> = {
  live: "sidebar.live",
  connecting: "sidebar.connecting",
  offline: "sidebar.offline",
};

const NAV: { id: View; labelKey: StringKey; icon: LucideIcon }[] = [
  { id: "dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { id: "compare", labelKey: "nav.compare", icon: GitCompareArrows },
  { id: "doctor", labelKey: "nav.doctor", icon: Stethoscope },
];

export function Sidebar(props: {
  view: View;
  onView: (v: View) => void;
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
  }, [props.view]);

  return (
    <aside className="flex h-screen w-[220px] flex-col border-r border-hair bg-panel px-3 py-4">
      {/* brand */}
      <div className="mb-5 flex items-center gap-2 px-2">
        <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="font-sans text-[17px] font-semibold tracking-tight text-ink">
          claude-mgr
        </span>
      </div>

      {/* nav */}
      <nav ref={navRef} className="relative flex flex-col gap-0.5">
        <span
          ref={indicatorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 w-[3px] rounded-full bg-accent"
          style={{ opacity: 0 }}
        />
        {NAV.map(({ id, labelKey, icon: Icon }) => {
          const active = props.view === id;
          return (
            <button
              key={id}
              onClick={() => props.onView(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-sm font-medium transition-colors",
                active
                  ? "bg-sel text-ink"
                  : "text-i60 hover:bg-tint hover:text-ink",
              )}
            >
              <Icon
                size={17}
                className={active ? "text-accent" : "text-i42"}
                aria-hidden="true"
              />
              {t(labelKey)}
            </button>
          );
        })}
      </nav>

      {/* target switch */}
      <div className="mt-6 px-1">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-i42">
          {t("sidebar.target")}
        </div>
        <div className="inline-flex w-full overflow-hidden rounded-md border border-hair2">
          {(["claude", "codex"] as TargetId[]).map((t) => (
            <button
              key={t}
              onClick={() => props.onTarget(t)}
              className={cn(
                "flex-1 px-2 py-2 text-[13px] font-medium capitalize transition-colors",
                props.target === t
                  ? "bg-surface text-ink"
                  : "text-i60 hover:bg-tint hover:text-ink",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* spacer */}
      <div className="flex-1" />

      {/* controls */}
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-okbg px-2.5 py-1 text-[11px] font-medium text-ok">
          <ShieldCheck size={13} aria-hidden="true" />
          {t("sidebar.readonly")}
        </span>
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-i60"
          title={t(LIVE_LABEL[props.live])}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              LIVE_DOT[props.live],
              props.live === "live" && "animate-pulse motion-reduce:animate-none",
            )}
            aria-hidden="true"
          />
          {t(LIVE_LABEL[props.live])}
        </span>
        <button
          onClick={props.onToggleLang}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-hair2 px-1.5 py-1.5 text-[11px] font-semibold text-i60 transition-colors hover:bg-tint hover:text-ink"
          aria-label={t("sidebar.toggleLang")}
          title={t("sidebar.toggleLang")}
        >
          <Languages size={13} aria-hidden="true" />
          {props.lang === "zh" ? "EN" : "中"}
        </button>
        <button
          onClick={props.onReload}
          className="rounded-md border border-hair2 p-1.5 text-i60 transition-colors hover:bg-tint hover:text-ink"
          aria-label={t("sidebar.reload")}
        >
          <RefreshCw size={14} className={props.loading ? "animate-spin" : ""} />
        </button>
        <button
          onClick={props.onToggleTheme}
          className="rounded-md border border-hair2 p-1.5 text-i60 transition-colors hover:bg-tint hover:text-ink"
          aria-label={t("sidebar.toggleTheme")}
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
    </aside>
  );
}

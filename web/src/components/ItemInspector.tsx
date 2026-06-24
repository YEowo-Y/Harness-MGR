/*
 * Item detail — the governance-first right-rail inspector, generalised across all
 * kinds (design §4 "Item detail … generalises to agent/command/mcp/plugin").
 *
 * It is config-driven: the per-kind sections/fields come from KIND_CONFIG, so this
 * component holds only the chrome (header, path, the built-in shadowing card, the
 * read-only notes) and renders whatever fields the active kind declares. READ-ONLY
 * (P0) — surfaces what governs the item, never mutates. All facts come from the
 * engine (inventory + conflicts); no resolution logic is reimplemented here.
 */
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import gsap from "gsap";
import { useLang } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";
import { PluginWriteControl } from "@/components/PluginWriteControl";
import type { KindConfig, RenderCtx } from "@/lib/kinds";
import type { InventoryItem, TargetId } from "@/lib/api";

/** Shadowing facts for the selected item, derived from the conflicts command. */
export interface ShadowInfo {
  /** name of the load-order winner for this item's resolution key */
  winnerName: string;
  /** true when THIS item is the likely winner of its collision */
  isWinner: boolean;
  /** total components sharing the resolution key (incl. this one) */
  count: number;
  kind: string;
}

export function ItemInspector({
  item,
  config,
  shadow,
  target,
  writeKinds,
  onRefresh,
  onClose,
}: {
  item: InventoryItem;
  config: KindConfig;
  shadow: ShadowInfo | null;
  target: TargetId;
  /** item kinds the server will let us write on this target */
  writeKinds: string[];
  /** bump the data after a successful write so the inventory reflects it */
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const ctx: RenderCtx = { t, target };

  // Slide + fade in on open and whenever the selected item changes.
  const ref = useGsap<HTMLElement>(
    (self) => gsap.from(self, { autoAlpha: 0, x: 12, duration: 0.3 }),
    [config.key, config.rowKey(item)],
  );

  // Keyboard story: focus the panel on open, return focus to the triggering row on
  // close. Non-modal complementary <aside> → no focus trap; Escape closes it. On
  // unmount, only restore focus if the trigger is STILL in the DOM — on a kind switch
  // the originating row is unmounted, so restoring to it would drop focus to <body>;
  // skipping leaves focus on the control the user just used (e.g. the KPI button).
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus?.();
    };
  }, [ref]);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={item.name}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="mt-6 flex max-h-[calc(100vh-3.5rem)] flex-col overflow-hidden rounded-lg border border-hair bg-surface outline-none lg:mt-0 lg:h-full lg:max-h-none lg:w-[var(--rail)] lg:shrink-0"
    >
      {/* header */}
      <div className="flex items-start justify-between gap-2 border-b border-hair px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-i42">
            {config.type}
          </div>
          <div className="mt-0.5 break-words font-mono text-[15px] font-medium text-ink">
            {item.name}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t("inspector.close")}
          className="shrink-0 rounded-md border border-hair2 p-1 text-i60 transition-colors hover:bg-tint hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {/* path (skill/agent/command have one; plugin/mcp/marketplace don't) */}
        {item.path && (
          <Field label={t("inspector.path")}>
            <span className="break-all font-mono text-[12.5px] text-i60">
              {item.path}
            </span>
          </Field>
        )}

        {/* per-kind sections (hide a field whose value is null, and a now-empty section) */}
        {config.sections.map((section) => {
          const visible = section.fields
            .map((f) => ({ labelKey: f.labelKey, node: f.render(item, ctx) }))
            .filter((f) => f.node !== null && f.node !== undefined);
          if (visible.length === 0) return null;
          return (
            <Section key={section.titleKey} title={t(section.titleKey)}>
              {visible.map((f) => (
                <Field key={f.labelKey} label={t(f.labelKey)}>
                  <span className="text-[13.5px] leading-relaxed text-i80">
                    {f.node}
                  </span>
                </Field>
              ))}
            </Section>
          );
        })}

        {/* loadability & shadowing — only for kinds that can shadow (skill/agent/command) */}
        {config.shadowKind && (
          <Section title={t("inspector.shadowing")}>
            {shadow ? (
              <div className="flex flex-col gap-1.5">
                <Badge tone={shadow.isWinner}>
                  {t("inspector.shadowed", {
                    kind: shadow.kind,
                    count: shadow.count,
                  })}
                </Badge>
                <div className="text-[12.5px] leading-relaxed text-i60">
                  {shadow.winnerName}
                  {shadow.isWinner ? " ✓" : ""}
                </div>
              </div>
            ) : target === "codex" ? (
              // Codex models same-name components as COEXISTING, not shadowing, so the
              // conflicts array is empty for codex — say so honestly.
              <div className="text-[13.5px] leading-relaxed text-i60">
                {t("inspector.codexCoexist")}
              </div>
            ) : (
              <div className="text-[13.5px] leading-relaxed text-i60">
                {t("inspector.noShadow")}
              </div>
            )}
          </Section>
        )}

      </div>

      {/* action footer — docked actions (industry-standard); the body scrolls above it */}
      <div className="shrink-0 border-t border-hair px-4 py-3">
        {config.type === "plugin" && writeKinds.includes("plugin") ? (
          <PluginWriteControl item={item} target={target} onRefresh={onRefresh} />
        ) : (
          <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-i42">
            <p>{t("inspector.actionsP2")}</p>
            {config.shadowKind === "skill" && <p>{t("inspector.contentDeferred")}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i42">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[12px] font-medium text-i42">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** Local tone wrapper — a confirmed winner reads OK (green), a shadowed loser WARN. */
function Badge({ tone, children }: { tone: boolean; children: ReactNode }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium " +
        (tone ? "bg-okbg text-ok" : "bg-warn/15 text-warn")
      }
    >
      {children}
    </span>
  );
}

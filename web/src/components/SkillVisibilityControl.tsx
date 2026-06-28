/*
 * Skill visibility control — sets a Claude skill's 4-state `skillOverrides` value.
 *
 * Mirrors PluginWriteControl's safety contract: pick a target state → a DRY-RUN preview
 * (no write) shows the exact byte change → the user confirms → an apply routes through the
 * gated, auto-snapshot, reversible write. Nothing here reimplements write logic; it only
 * drives /api/write/skill:visibility and renders what the engine returns. Claude-only (the
 * inspector only mounts it when writeKinds includes "skill"). The four state values are the
 * engine's enum and stay verbatim (governance values are not translated, like the read side).
 */
import { useState, useRef, useEffect } from "react";
import { Check, AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { useLang } from "@/lib/i18n";
import {
  writeCommand,
  type InventoryItem,
  type TargetId,
  type WriteResult,
  type Diagnostic,
} from "@/lib/api";

type Phase = "idle" | "loading" | "preview" | "done" | "error";

/** The four settable visibility states (engine enum; "default" = no override, not settable). */
const STATES = ["on", "name-only", "user-invocable-only", "off"] as const;

/** First error-severity diagnostic message, if any. */
function firstError(diags: Diagnostic[]): string | null {
  const d = diags.find((x) => x.severity === "error");
  return d ? d.message : null;
}

export function SkillVisibilityControl({
  item,
  target,
  onRefresh,
}: {
  item: InventoryItem;
  target: TargetId;
  onRefresh: () => void;
}) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>("idle");
  // While the async write runs, move focus to the live-region status node so keyboard/SR focus
  // is not dropped to <body> when the clicked button unmounts; the region (role=status +
  // aria-live) announces "Working…". Mirrors the inspector's tabIndex=-1 + outline-none pattern.
  const loadingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === "loading") loadingRef.current?.focus();
  }, [phase]);
  const [pending, setPending] = useState<string | null>(null);
  const [preview, setPreview] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Current effective visibility from the read side ("default" when no override).
  const current = item.visibility ?? "default";

  async function runPreview(state: string) {
    setPending(state);
    setPhase("loading");
    setError(null);
    try {
      const env = await writeCommand("skill:visibility", {
        target,
        type: "skill",
        name: item.name,
        state,
        apply: false,
      });
      const err = firstError(env.diagnostics);
      if (err) {
        setError(err);
        setPhase("error");
        return;
      }
      setPreview(env.result);
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function runApply() {
    if (!pending) return;
    setPhase("loading");
    try {
      const env = await writeCommand("skill:visibility", {
        target,
        type: "skill",
        name: item.name,
        state: pending,
        apply: true,
      });
      const err = firstError(env.diagnostics);
      if (err || !env.result.applied) {
        setError(err ?? t("write.failed"));
        setPhase("error");
        return;
      }
      setPreview(env.result);
      setPhase("done");
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function reset() {
    setPhase("idle");
    setPending(null);
    setPreview(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-hair pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i42">
        {t("write.title")}
      </h3>

      {phase === "idle" && (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-i42">
            {t("write.vis.current")}:{" "}
            <span className="font-mono text-[12.5px] text-i80">{current}</span>
          </div>
          <div className="text-[11px] font-medium text-i42">{t("write.vis.set")}</div>
          <div className="flex flex-wrap gap-1.5">
            {STATES.map((s) => (
              <button
                key={s}
                onClick={() => runPreview(s)}
                disabled={s === current}
                aria-pressed={s === current}
                className={
                  "rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] transition-colors " +
                  (s === current
                    ? "cursor-default border-hair bg-tint text-i42"
                    : "border-hair2 text-ink hover:bg-tint")
                }
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "loading" && (
        <div ref={loadingRef} tabIndex={-1} role="status" aria-live="polite" className="inline-flex items-center gap-2 px-1 py-2 text-[13px] text-i60 outline-none">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t("write.working")}
        </div>
      )}

      {phase === "preview" && preview && (
        <div className="flex flex-col gap-2.5">
          {preview.alreadyInState || !preview.diff ? (
            <p className="text-[13px] leading-relaxed text-i60">{t("write.noChange")}</p>
          ) : (
            <>
              <div className="rounded-md border border-hair bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed">
                <div className="mb-1 text-[11px] text-i42">
                  {/* skill visibility is Claude-only → always settings.json (skillOverrides) */}
                  {t("write.line", { line: preview.diff.line, file: "settings.json" })}
                </div>
                {preview.diff.before && <div className="text-danger">- {preview.diff.before}</div>}
                <div className="text-ok">+ {preview.diff.after}</div>
              </div>
              <p className="text-[12px] leading-relaxed text-i42">{t("write.reversible", { file: "settings.json" })}</p>
            </>
          )}
          <div className="flex items-center gap-2">
            {!preview.alreadyInState && preview.diff && (
              <button
                onClick={runApply}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-accent-text transition-colors hover:bg-accent-d"
              >
                <Check size={14} aria-hidden="true" />
                {t("write.confirm")}
              </button>
            )}
            <button
              onClick={reset}
              className="rounded-md border border-hair2 px-3 py-2 text-[13px] font-medium text-i60 transition-colors hover:bg-tint hover:text-ink"
            >
              {preview.alreadyInState ? t("write.dismiss") : t("write.cancel")}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && preview && (
        <div className="flex flex-col gap-2">
          <div className="inline-flex items-center gap-1.5 rounded bg-okbg px-2 py-1 text-[12.5px] font-medium text-ok">
            <Check size={13} aria-hidden="true" />
            {t("write.done")}
          </div>
          {preview.snapshotId && (
            <div className="inline-flex items-center gap-1.5 text-[12px] text-i60">
              <RotateCcw size={12} aria-hidden="true" />
              {t("write.snapshot", { id: preview.snapshotId })}
            </div>
          )}
          <button
            onClick={reset}
            className="self-start rounded-md border border-hair2 px-3 py-1.5 text-[12.5px] font-medium text-i60 transition-colors hover:bg-tint hover:text-ink"
          >
            {t("write.dismiss")}
          </button>
        </div>
      )}

      {phase === "error" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-1.5 rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-[12.5px] leading-relaxed text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error ?? t("write.failed")}</span>
          </div>
          <button
            onClick={reset}
            className="self-start rounded-md border border-hair2 px-3 py-1.5 text-[12.5px] font-medium text-i60 transition-colors hover:bg-tint hover:text-ink"
          >
            {t("write.dismiss")}
          </button>
        </div>
      )}
    </div>
  );
}

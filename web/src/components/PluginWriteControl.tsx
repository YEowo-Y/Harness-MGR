/*
 * Plugin enable/disable control (P2 pilot — the FIRST write surface in the web UI).
 *
 * Flow mirrors the engine's own safety contract: click the toggle → a DRY-RUN preview
 * (no write) shows the exact byte change → the user confirms → an apply routes through
 * the gated, auto-snapshot, reversible write. Nothing here reimplements write logic; it
 * only drives /api/write and renders what the engine returns. After a successful apply
 * it calls onRefresh so the inventory reflects the new state (the P1 watcher also fires).
 */
import { useState } from "react";
import { Power, Check, AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { writeCommand, type InventoryItem, type TargetId, type WriteResult, type Diagnostic } from "@/lib/api";

type Phase = "idle" | "loading" | "preview" | "done" | "error";

/** First error-severity diagnostic message, if any. */
function firstError(diags: Diagnostic[]): string | null {
  const d = diags.find((x) => x.severity === "error");
  return d ? d.message : null;
}

export function PluginWriteControl({
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
  const [preview, setPreview] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = item.key ?? item.name;
  // Toggle verb is the OPPOSITE of the current state; the dry-run corrects us if the
  // displayed state is stale (it reports alreadyInState from the authoritative file).
  const verb: "enable" | "disable" = item.enabled ? "disable" : "enable";
  // The plugin toggle writes settings.json on Claude but config.toml on Codex (the engine
  // flips plugins.*.enabled there) — label the preview diff + reversible note with the real
  // target file, not a hardcoded settings.json.
  const file = target === "codex" ? "config.toml" : "settings.json";

  async function runPreview() {
    setPhase("loading");
    setError(null);
    try {
      const env = await writeCommand(verb, { target, type: "plugin", name, apply: false });
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
    setPhase("loading");
    try {
      const env = await writeCommand(verb, { target, type: "plugin", name, apply: true });
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
    setPreview(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-hair pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i42">
        {t("write.title")}
      </h3>

      {phase === "idle" && (
        <button
          onClick={runPreview}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-hair2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-tint"
        >
          <Power size={14} className="text-i60" aria-hidden="true" />
          {t(verb === "enable" ? "write.action.enable" : "write.action.disable")}
        </button>
      )}

      {phase === "loading" && (
        <div className="inline-flex items-center gap-2 px-1 py-2 text-[13px] text-i60">
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
                <div className="mb-1 text-[11px] text-i42">{t("write.line", { line: preview.diff.line, file })}</div>
                {preview.diff.before && <div className="text-danger">- {preview.diff.before}</div>}
                <div className="text-ok">+ {preview.diff.after}</div>
              </div>
              <p className="text-[12px] leading-relaxed text-i42">{t("write.reversible", { file })}</p>
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

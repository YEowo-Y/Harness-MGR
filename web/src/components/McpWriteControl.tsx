/*
 * MCP server enable/disable control (Codex only — the THIRD web write surface).
 *
 * Unlike the plugin control, the mcp inventory carries NO `enabled` field: codex models a
 * disabled server as an explicit `enabled = false` in config.toml, and an absent key means
 * enabled. The UI therefore cannot guess the current direction, so it offers BOTH actions and
 * lets the engine's DRY-RUN probe report the truth — the no-op action comes back
 * `alreadyInState`, the real one returns a byte diff. That is the "probe decides direction"
 * principle taken to its honest conclusion: no stale-flag guessing.
 *
 * Codex-only by design: codex's mcp toggle is a pure in-place config.toml splice (diff +
 * auto-snapshot + reversible rollback), which is exactly what this control renders. Claude's
 * mcp toggle delegates to the `claude` CLI plus a stash (no diff, no snapshot) — a different
 * mechanism the server's writeKindsFor() does not advertise for the Claude target, so the
 * inspector never mounts this control there.
 *
 * Like the sibling write controls, it only drives /api/write and renders what the engine
 * returns — no write logic is reimplemented here. After a successful apply it calls onRefresh
 * (the P1 watcher also fires on the config.toml write).
 */
import { useState } from "react";
import { Power, Check, AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { useLang } from "@/lib/i18n";
import {
  writeCommand,
  type InventoryItem,
  type TargetId,
  type WriteResult,
  type Diagnostic,
} from "@/lib/api";

type Phase = "idle" | "loading" | "preview" | "done" | "error";
type Verb = "enable" | "disable";

/** First error-severity diagnostic message, if any. */
function firstError(diags: Diagnostic[]): string | null {
  const d = diags.find((x) => x.severity === "error");
  return d ? d.message : null;
}

export function McpWriteControl({
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
  // The action the user picked — also the verb runApply must re-send (so the applied write
  // is exactly the previewed one, never a direction recomputed at apply time).
  const [pending, setPending] = useState<Verb | null>(null);
  const [preview, setPreview] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview(verb: Verb) {
    setPending(verb);
    setPhase("loading");
    setError(null);
    try {
      const env = await writeCommand(verb, { target, type: "mcp", name: item.name, apply: false });
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
      const env = await writeCommand(pending, { target, type: "mcp", name: item.name, apply: true });
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
          <p className="text-[12px] leading-relaxed text-i42">{t("write.mcp.hint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => runPreview("enable")}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-hair2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-tint"
            >
              <Power size={14} className="text-i60" aria-hidden="true" />
              {t("write.mcp.enable")}
            </button>
            <button
              onClick={() => runPreview("disable")}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-hair2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-tint"
            >
              <Power size={14} className="text-i60" aria-hidden="true" />
              {t("write.mcp.disable")}
            </button>
          </div>
        </div>
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
                <div className="mb-1 text-[11px] text-i42">{t("write.mcp.line", { line: preview.diff.line })}</div>
                {preview.diff.before && <div className="text-danger">- {preview.diff.before}</div>}
                <div className="text-ok">+ {preview.diff.after}</div>
              </div>
              <p className="text-[12px] leading-relaxed text-i42">{t("write.mcp.reversible")}</p>
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

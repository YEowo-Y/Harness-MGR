/*
 * Remove-component control (the FOURTH web write surface — DESTRUCTIVE, Claude only).
 *
 * Deletes a user-level skill / agent / command. Unlike the three toggle controls (plugin /
 * skill-visibility / codex-mcp), which are idempotent state flips, this DELETES a file
 * (agent/command → one .md) or a whole DIRECTORY (skill → skills/<name>/). It is still
 * reversible: the engine auto-snapshots BEFORE the delete, so one `rollback` restores it —
 * the UX is "serious but not terrifying": show the exact engine-resolved path, warn that a
 * skill is the whole folder, reassure it's reversible, and gate the danger button behind an
 * explicit "I understand" checkbox.
 *
 * Like the sibling controls it only drives /api/write and renders what the engine returns —
 * no delete logic is reimplemented here. The engine command is `remove <kind>:<name>`
 * (dry-run by default; apply routes through the gate → auto-snapshot → governed delete). The
 * dry-run preview carries NO byte diff (it's a delete) — it returns the resolved target path
 * and confirms it exists; a refusal (not-found / symlink / wrong-type) comes back as an error
 * diagnostic. After a successful apply onRefresh fires (the item then vanishes from the list,
 * which closes the inspector — the natural feedback that the delete worked).
 */
import { useState } from "react";
import { Trash2, AlertTriangle, Loader2, RotateCcw, Check } from "lucide-react";
import { useLang } from "@/lib/i18n";
import {
  writeCommand,
  type InventoryItem,
  type TargetId,
  type WriteResult,
  type Diagnostic,
} from "@/lib/api";

type Phase = "idle" | "loading" | "preview" | "done" | "error";

/** First error-severity diagnostic message, if any. */
function firstError(diags: Diagnostic[]): string | null {
  const d = diags.find((x) => x.severity === "error");
  return d ? d.message : null;
}

export function RemoveControl({
  item,
  kind,
  target,
  onRefresh,
}: {
  item: InventoryItem;
  /** the active inventory kind (agent | command | skill) — drives the `<kind>:<name>` spec */
  kind: string;
  target: TargetId;
  onRefresh: () => void;
}) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<WriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The "I understand" gate — the danger button stays disabled until it is checked.
  const [ack, setAck] = useState(false);

  async function runPreview() {
    setPhase("loading");
    setError(null);
    try {
      const env = await writeCommand("remove", { target, type: kind, name: item.name, apply: false });
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
      const env = await writeCommand("remove", { target, type: kind, name: item.name, apply: true });
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
    setAck(false);
  }

  // The path the engine resolved + validated (authoritative); fall back to the inventory path.
  const path = preview?.target ?? item.path ?? item.name;

  return (
    <div className="flex flex-col gap-2.5 border-t border-hair pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i42">
        {t("remove.title")}
      </h3>

      {phase === "idle" && (
        <button
          onClick={runPreview}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-danger/40 px-3 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10"
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("remove.action")}
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
          <div className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
            <div className="text-[11px] text-i42">{t("remove.pathLabel")}</div>
            <span className="break-all font-mono text-[12px] leading-relaxed text-danger">{path}</span>
          </div>
          {kind === "skill" && (
            <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-warn">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t("remove.warnFolder")}</span>
            </p>
          )}
          <p className="text-[12px] leading-relaxed text-i42">{t("remove.reversible")}</p>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] leading-relaxed text-i80">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="h-3.5 w-3.5 shrink-0 accent-[var(--danger)]"
            />
            {t("remove.ack")}
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={runApply}
              disabled={!ack}
              className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={14} aria-hidden="true" />
              {t("remove.confirm", { name: item.name })}
            </button>
            <button
              onClick={reset}
              className="rounded-md border border-hair2 px-3 py-2 text-[13px] font-medium text-i60 transition-colors hover:bg-tint hover:text-ink"
            >
              {t("write.cancel")}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && preview && (
        <div className="flex flex-col gap-2">
          <div className="inline-flex items-center gap-1.5 rounded bg-okbg px-2 py-1 text-[12.5px] font-medium text-ok">
            <Check size={13} aria-hidden="true" />
            {t("remove.done")}
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

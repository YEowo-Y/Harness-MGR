import type { ReactNode } from "react";
import { Loader2, AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLang } from "@/lib/i18n";

/** A bordered surface card with an optional uppercase title bar + right-aligned action. */
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-hair bg-surface",
        className,
      )}
    >
      {title !== undefined && (
        <div className="flex items-center justify-between gap-2 border-b border-hair px-4 py-3 text-xs font-semibold uppercase tracking-wider text-i42">
          <span>{title}</span>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = "neutral" | "ok" | "info" | "warn" | "danger" | "accent";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-tint text-i60",
  ok: "bg-okbg text-ok",
  info: "bg-infobg text-info",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/10 text-danger",
  accent: "bg-accent/15 text-accent-text",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Centered loading spinner. Falls back to the localized "Loading…" string. */
export function Loading({ label }: { label?: string }) {
  const { t } = useLang();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-i60"
    >
      <Loader2 size={16} className="animate-spin" />
      {label ?? t("common.loading")}
    </div>
  );
}

/** Inline error block — used when an engine call fails. */
export function ErrorBox({ message }: { message: string }) {
  const { t } = useLang();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div>
        <div className="font-medium">{t("common.errorTitle")}</div>
        <div className="mt-0.5 text-i60">{message}</div>
        <div className="mt-1 text-i42">
          {t("common.errorHintBefore")}{" "}
          <code className="font-mono">npm run dev</code>.
        </div>
      </div>
    </div>
  );
}

/** Empty-state placeholder. */
export function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-sm text-i42">
      <Inbox size={22} className="text-idec" />
      {label}
    </div>
  );
}

import { useMemo, type ReactNode } from "react";
import { CircleCheck, CircleAlert, Info, Wrench } from "lucide-react";
import gsap from "gsap";
import {
  fetchCommand,
  type DoctorResult,
  type HealthResult,
  type Diagnostic,
  type Severity,
  type TargetId,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useLang } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";
import { Panel, Loading, ErrorBox, Empty } from "@/components/ui";

const SEV_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function Doctor({
  target,
  reloadKey,
}: {
  target: TargetId;
  reloadKey: number;
}) {
  const { t } = useLang();
  const health = useApi(
    () => fetchCommand<HealthResult>("health", { target }),
    [target, reloadKey],
  );
  const doctor = useApi(
    () => fetchCommand<DoctorResult>("doctor", { target }),
    [target, reloadKey],
  );

  const findings = useMemo<Diagnostic[]>(() => {
    const ds = doctor.data?.diagnostics ?? [];
    return [...ds].sort(
      (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
    );
  }, [doctor.data]);

  if (health.error) return <ErrorBox message={health.error} />;
  if (doctor.error) return <ErrorBox message={doctor.error} />;

  const summary = health.data?.result.health.summary;
  const checks = doctor.data?.result.checks ?? [];
  const counts = {
    error: findings.filter((d) => d.severity === "error").length,
    warn: findings.filter((d) => d.severity === "warn").length,
    info: findings.filter((d) => d.severity === "info").length,
  };

  return (
    <div className="flex flex-col gap-6">
      {/* loadability + severity */}
      <section className="grid gap-6 md:grid-cols-[300px_1fr]">
        <Panel title={t("doctor.loadabilityTitle", { target })}>
          {health.loading || !summary ? (
            <Loading />
          ) : (
            <div className="flex items-center gap-5 px-5 py-6">
              <Gauge value={summary.loadable} total={summary.total} />
              <dl className="flex flex-col gap-2 text-[13.5px]">
                <Stat
                  label={t("doctor.loadable")}
                  value={summary.loadable}
                  tone="text-ok"
                />
                <Stat
                  label={t("doctor.degraded")}
                  value={summary.degraded}
                  tone="text-warn"
                />
                <Stat
                  label={t("doctor.notLoaded")}
                  value={summary.notLoaded}
                  tone="text-danger"
                />
              </dl>
            </div>
          )}
        </Panel>

        <Panel title={t("doctor.findingsBySeverity")}>
          {doctor.loading ? (
            <Loading />
          ) : (
            <div className="grid grid-cols-3 gap-px overflow-hidden bg-hair">
              <SevCard
                icon={<CircleAlert size={16} />}
                label={t("doctor.errors")}
                value={counts.error}
                tone={counts.error ? "text-danger" : "text-i42"}
              />
              <SevCard
                icon={<CircleAlert size={16} />}
                label={t("doctor.warnings")}
                value={counts.warn}
                tone={counts.warn ? "text-warn" : "text-i42"}
              />
              <SevCard
                icon={<Info size={16} />}
                label={t("doctor.info")}
                value={counts.info}
                tone={counts.info ? "text-info" : "text-i42"}
              />
            </div>
          )}
          <div className="border-t border-hair px-4 py-2.5 text-xs text-i42">
            {t("doctor.probeMeta", {
              level: doctor.data?.result.probeLevel ?? "…",
              total: checks.length,
              ran: checks.filter((c) => c.ran).length,
            })}
          </div>
        </Panel>
      </section>

      {/* findings list */}
      <Panel title={t("doctor.findingsTitle", { n: findings.length })}>
        {doctor.loading ? (
          <Loading />
        ) : findings.length === 0 ? (
          <Empty label={t("doctor.healthy")} />
        ) : (
          <div className="max-h-[460px] overflow-auto">
            {findings.map((d, i) => (
              <FindingRow key={`${d.code}:${i}`} d={d} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Gauge({ value, total }: { value: number; total: number }) {
  const pct = total ? value / total : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const tone = pct >= 0.999 ? "var(--ok)" : pct >= 0.9 ? "var(--warn)" : "var(--danger)";

  // Draw the arc from empty → its value (design §3: SVG arc draw on the gauge).
  // from() starts fully offset (empty ring) and animates to the natural offset, so
  // under reduced-motion the ring just renders filled to the right amount.
  const ref = useGsap<HTMLDivElement>(
    () =>
      gsap.from(".gauge-arc", {
        strokeDashoffset: c,
        duration: 1,
        ease: "power2.out",
      }),
    [value, total],
  );

  return (
    <div ref={ref} className="relative shrink-0">
      <svg viewBox="0 0 80 80" width="92" height="92" aria-hidden="true">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--tint)" strokeWidth="8" />
        <circle
          className="gauge-arc"
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c.toFixed(1)}
          strokeDashoffset={offset.toFixed(1)}
          transform="rotate(-90 40 40)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum text-[18px] font-semibold text-ink">
          {Math.round(pct * 100)}%
        </span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-i60">{label}</dt>
      <dd className={`tnum font-semibold ${tone}`}>{value}</dd>
    </div>
  );
}

function SevCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="bg-surface px-5 py-5">
      <div className={`flex items-center gap-1.5 ${tone}`}>{icon}</div>
      <div className="tnum mt-2 font-sans text-[30px] font-semibold leading-none text-ink">
        {value}
      </div>
      <div className="mt-1.5 text-xs font-medium uppercase tracking-wider text-i42">
        {label}
      </div>
    </div>
  );
}

const SEV_ICON: Record<Severity, ReactNode> = {
  error: <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />,
  warn: <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" />,
  info: <Info size={15} className="mt-0.5 shrink-0 text-info" />,
};

function FindingRow({ d }: { d: Diagnostic }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-hair px-4 py-3 last:border-b-0 even:bg-zebra">
      {SEV_ICON[d.severity] ?? <CircleCheck size={16} className="mt-0.5 text-ok" />}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-i42">{d.code}</code>
        </div>
        <div className="mt-0.5 text-[13.5px] text-ink">{d.message}</div>
        {typeof d.fix === "string" && d.fix && (
          <div className="mt-1.5 flex items-start gap-1.5 text-[13px] text-i60">
            <Wrench size={13} className="mt-0.5 shrink-0 text-i42" />
            {d.fix}
          </div>
        )}
      </div>
    </div>
  );
}

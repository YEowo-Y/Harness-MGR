import { useEffect, useState } from "react";
import { Sidebar, type Section } from "@/components/Sidebar";
import { Dashboard } from "@/views/Dashboard";
import { Compare } from "@/views/Compare";
import { Doctor } from "@/views/Doctor";
import gsap from "gsap";
import {
  fetchStatus,
  fetchCommand,
  type InventoryResult,
  type TargetId,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useLiveReload } from "@/lib/useLiveReload";
import { useLang } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";
import { KIND_CONFIG, type KindKey } from "@/lib/kinds";

type Theme = "light" | "dark";

/** A section is an inventory kind unless it is one of the two analysis views. */
const isKind = (s: Section): s is KindKey => s !== "compare" && s !== "doctor";

export default function App() {
  const { t, lang, setLang } = useLang();
  const [theme, setTheme] = useState<Theme>("light");
  const [target, setTarget] = useState<TargetId>("claude");
  const [section, setSection] = useState<Section>("skills");
  const [reloadKey, setReloadKey] = useState(0);

  // P1 realtime: a config change on disk bumps the SAME reloadKey the manual
  // refresh button uses, so every mounted view (and status) re-fetches.
  const live = useLiveReload(() => setReloadKey((k) => k + 1));

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  const status = useApi(() => fetchStatus(target), [target, reloadKey]);
  // Inventory counts power the sidebar kind badges — one shared fetch.
  const inv = useApi(
    () => fetchCommand<InventoryResult>("inventory", { target }),
    [target, reloadKey],
  );

  // Header title/subtitle derive from the active section.
  const kindConfig = isKind(section)
    ? KIND_CONFIG.find((k) => k.key === section)
    : undefined;
  const title = kindConfig
    ? t(kindConfig.labelKey)
    : t(section === "compare" ? "nav.compare" : "nav.doctor");
  const subtitle = kindConfig
    ? t("view.dashboard.subtitle", { target })
    : t(
        section === "compare" ? "view.compare.subtitle" : "view.doctor.subtitle",
        { target },
      );

  // Fade + lift the content area on every section switch (design §3).
  const stage = useGsap<HTMLDivElement>(
    (self) => gsap.from(self, { autoAlpha: 0, y: 10, duration: 0.3 }),
    [section],
  );

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        section={section}
        onSection={setSection}
        counts={inv.data?.result.counts}
        target={target}
        onTarget={setTarget}
        theme={theme}
        onToggleTheme={() => setTheme((th) => (th === "light" ? "dark" : "light"))}
        lang={lang}
        onToggleLang={() => setLang(lang === "zh" ? "en" : "zh")}
        loading={status.loading}
        onReload={() => setReloadKey((k) => k + 1)}
        status={status.data}
        statusError={status.error}
        live={live}
      />

      <main className="flex h-full flex-1 flex-col overflow-hidden bg-bg">
        <div className="flex h-full min-h-0 w-full flex-col px-9 py-7">
          <header className="mb-5 shrink-0">
            <h1 className="font-sans text-[24px] font-semibold tracking-tight text-ink">
              {title}
            </h1>
            <p className="mt-1 text-[14px] text-i60">{subtitle}</p>
          </header>

          <div ref={stage} className="min-h-0 flex-1 overflow-hidden">
            {isKind(section) && (
              <Dashboard
                key={section}
                target={target}
                activeKind={section}
                reloadKey={reloadKey}
                writeKinds={status.data?.writeKinds ?? []}
                onRefresh={() => setReloadKey((k) => k + 1)}
              />
            )}
            {section === "compare" && (
              <Compare target={target} reloadKey={reloadKey} />
            )}
            {section === "doctor" && (
              <Doctor target={target} reloadKey={reloadKey} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

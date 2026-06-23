import { useEffect, useState } from "react";
import { Sidebar, type View } from "@/components/Sidebar";
import { Dashboard } from "@/views/Dashboard";
import { Compare } from "@/views/Compare";
import { Doctor } from "@/views/Doctor";
import gsap from "gsap";
import { fetchStatus, type TargetId } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useLiveReload } from "@/lib/useLiveReload";
import { useLang, type StringKey } from "@/lib/i18n";
import { useGsap } from "@/lib/motion";

type Theme = "light" | "dark";

const VIEW_META: Record<View, { titleKey: StringKey; subtitleKey: StringKey }> = {
  dashboard: {
    titleKey: "nav.dashboard",
    subtitleKey: "view.dashboard.subtitle",
  },
  compare: {
    titleKey: "nav.compare",
    subtitleKey: "view.compare.subtitle",
  },
  doctor: {
    titleKey: "nav.doctor",
    subtitleKey: "view.doctor.subtitle",
  },
};

export default function App() {
  const { t, lang, setLang } = useLang();
  const [theme, setTheme] = useState<Theme>("light");
  const [target, setTarget] = useState<TargetId>("claude");
  const [view, setView] = useState<View>("dashboard");
  const [reloadKey, setReloadKey] = useState(0);

  // P1 realtime: a config change on disk bumps the SAME reloadKey the manual
  // refresh button uses, so every mounted view (and status) re-fetches.
  const live = useLiveReload(() => setReloadKey((k) => k + 1));

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  const status = useApi(() => fetchStatus(target), [target, reloadKey]);
  const meta = VIEW_META[view];

  // Fade + lift the content area on every view switch (design §3: view transition).
  const stage = useGsap<HTMLDivElement>(
    (self) => gsap.from(self, { autoAlpha: 0, y: 10, duration: 0.3 }),
    [view],
  );

  return (
    <div className="flex">
      <Sidebar
        view={view}
        onView={setView}
        target={target}
        onTarget={setTarget}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        lang={lang}
        onToggleLang={() => setLang(lang === "zh" ? "en" : "zh")}
        loading={status.loading}
        onReload={() => setReloadKey((k) => k + 1)}
        status={status.data}
        statusError={status.error}
        live={live}
      />

      <main className="h-screen flex-1 overflow-auto bg-bg">
        <div className="mx-auto px-9 py-8" style={{ maxWidth: "var(--measure)" }}>
          <header className="mb-7">
            <h1 className="font-sans text-[30px] font-semibold tracking-tight text-ink">
              {t(meta.titleKey)}
            </h1>
            <p className="mt-1 text-[15px] text-i60">
              {t(meta.subtitleKey, { target })}
            </p>
          </header>

          <div ref={stage}>
            {view === "dashboard" && (
              <Dashboard target={target} reloadKey={reloadKey} />
            )}
            {view === "compare" && (
              <Compare target={target} reloadKey={reloadKey} />
            )}
            {view === "doctor" && (
              <Doctor target={target} reloadKey={reloadKey} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

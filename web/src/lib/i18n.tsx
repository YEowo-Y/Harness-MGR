/*
 * Lightweight bilingual (中 / EN) layer for the read-only web UI.
 *
 * Scope: this translates the UI CHROME only — nav, headings, table headers,
 * captions, button/aria labels. Engine DATA (skill names, diagnostic codes &
 * messages, source tiers, visibility enum values) is English and is deliberately
 * NOT translated: those strings are the tool's own vocabulary and must match what
 * the CLI prints / accepts so a governance reader can cross-reference 1:1.
 *
 * Default language is Chinese (the maintainer's first language); the choice is
 * persisted to localStorage so it survives reloads. No i18n framework — a flat,
 * fully-typed dictionary keyed off the English table, with {token} interpolation.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "claude-mgr-lang";

/**
 * The English table is the source of truth: its keys define the valid string IDs,
 * and the Chinese table must supply exactly the same keys (enforced by the typed
 * STRINGS record below). `{token}` placeholders are filled by t()'s second arg.
 */
const EN = {
  // nav + view titles (shared between the sidebar nav and the page header)
  "nav.dashboard": "Dashboard",
  "nav.compare": "Compare",
  "nav.doctor": "Doctor",
  "view.dashboard.subtitle": "Live inventory of your {target} harness",
  "view.compare.subtitle": "Claude vs Codex — presence by name × kind",
  "view.doctor.subtitle": "Loadability + health checks for {target}",

  // sidebar
  "sidebar.target": "Target",
  "sidebar.readonly": "read-only",
  "sidebar.reload": "Reload",
  "sidebar.toggleTheme": "Toggle theme",
  "sidebar.toggleLang": "Switch language",
  "sidebar.engineUnreachable": "engine unreachable",
  "sidebar.live": "live",
  "sidebar.connecting": "connecting…",
  "sidebar.offline": "offline",
  "sidebar.inventory": "Inventory",
  "sidebar.analysis": "Analysis",

  // write channel (P2 — plugin enable/disable)
  "write.title": "Governance action",
  "write.action.enable": "Enable plugin",
  "write.action.disable": "Disable plugin",
  "write.working": "Working…",
  "write.noChange": "Already in the target state — nothing to write.",
  "write.line": "settings.json · line {line}",
  "write.reversible": "Edits settings.json. Reversible — an auto-snapshot is taken first.",
  "write.confirm": "Confirm & apply",
  "write.cancel": "Cancel",
  "write.dismiss": "Dismiss",
  "write.done": "Applied.",
  "write.snapshot": "Snapshot {id} — roll back with: rollback {id}",
  "write.failed": "Could not complete the change.",
  "write.vis.current": "Current visibility",
  "write.vis.set": "Set to",
  // write channel — codex mcp server enable/disable (config.toml, not settings.json)
  "write.mcp.hint":
    "An MCP server's on/off state lives in config.toml and isn't shown here — pick an action to preview the exact change first.",
  "write.mcp.enable": "Enable server",
  "write.mcp.disable": "Disable server",
  "write.mcp.line": "config.toml · line {line}",
  "write.mcp.reversible": "Edits config.toml. Reversible — an auto-snapshot is taken first.",

  // shared
  "common.loading": "Loading…",
  "common.filter": "filter…",
  "common.errorTitle": "Could not reach the engine",
  "common.errorHintBefore": "Is the API server running? Start it with",
  "col.name": "Name",

  // dashboard
  "dash.kpi.skills": "Skills",
  "dash.kpi.agents": "Agents",
  "dash.kpi.commands": "Commands",
  "dash.kpi.plugins": "Plugins",
  "dash.kpi.marketplaces": "Marketplaces",
  "dash.kpi.mcpServers": "MCP servers",
  "dash.visDefault": "default",

  // compare
  "compare.filter.all": "All",
  "compare.filter.both": "Both",
  "compare.filter.claudeOnly": "Claude only",
  "compare.filter.codexOnly": "Codex only",
  "compare.comparing": "Comparing targets…",
  "compare.noData": "No comparison data.",
  "compare.componentsUnit": "components",
  "compare.byKindTitle": "By kind — shared vs target-only",
  "compare.componentsTitle": "Components · {n} shown",
  "compare.noMatch": "No components match.",
  "compare.col.kind": "Kind",
  "compare.col.presence": "Presence",
  "compare.legend.both": "Both",
  "compare.legend.claudeOnly": "Claude only",
  "compare.legend.codexOnly": "Codex only",
  "compare.presence.both": "both",
  "compare.presence.claude-only": "claude-only",
  "compare.presence.codex-only": "codex-only",
  "compare.caveatBefore": "Presence is matched by",
  "compare.caveatKey": "name × kind",
  "compare.caveatAfter":
    ". A name appearing in both targets is not guaranteed to be the same content.",

  // doctor
  "doctor.loadabilityTitle": "Loadability · {target}",
  "doctor.loadable": "Loadable",
  "doctor.degraded": "Degraded",
  "doctor.notLoaded": "Not loaded",
  "doctor.findingsBySeverity": "Findings by severity",
  "doctor.errors": "Errors",
  "doctor.warnings": "Warnings",
  "doctor.info": "Info",
  "doctor.probeMeta": "probe level: {level} · {total} checks · {ran} ran",
  "doctor.findingsTitle": "Findings · {n}",
  "doctor.healthy": "No findings — the harness looks healthy.",

  // skill inspector (detail rail)
  "inspector.close": "Close",
  "inspector.governance": "Governance",
  "inspector.frontmatter": "Frontmatter",
  "inspector.shadowing": "Loadability & shadowing",
  "inspector.path": "Path",
  "inspector.tier": "Tier",
  "inspector.marketplace": "Marketplace",
  "inspector.version": "Version",
  "inspector.visibility": "Visibility",
  "inspector.controlledBy": "Controlled by",
  "inspector.controlledBy.settings": "settings.json skillOverrides",
  "inspector.controlledBy.default": "default (frontmatter)",
  "inspector.description": "Description",
  "inspector.tools": "Tools",
  "inspector.origin": "Origin",
  "inspector.noShadow": "Not shadowed — this component resolves cleanly.",
  "inspector.shadowed":
    "Part of a {kind} name collision ({count} share this name) — load order decides the winner.",
  "inspector.codexCoexist":
    "Codex components with the same name coexist — codex does not shadow (unverified).",
  "inspector.actionsP2":
    "Write actions (disable / visibility / remove) arrive in P2 — this view is read-only.",
  "inspector.contentDeferred":
    "Full SKILL.md preview is deferred (it needs a dedicated file-read endpoint outside the frozen read allowlist).",

  // generic table (kind-switchable dashboard)
  "dash.kindTitle": "{kind} · {target}",
  "dash.itemCount": "{shown} / {total}",
  "dash.noItems": "Nothing found.",
  "dash.noMatchItems": "No matches for your filter.",
  "col.source": "Source",
  "col.description": "Description",
  "col.visibility": "Visibility",
  "col.model": "Model",
  "col.version": "Version",
  "col.enabled": "Enabled",
  "col.marketplace": "Marketplace",
  "col.scope": "Scope",
  "col.transport": "Transport",
  "col.command": "Command",
  "col.sourceRepo": "Source repo",
  "col.onDisk": "On disk",
  // per-kind inspector fields + sections
  "inspector.model": "Model",
  "inspector.disallowedTools": "Disallowed tools",
  "inspector.enabled": "Enabled",
  "inspector.cachePresent": "Cache",
  "inspector.scope": "Scope",
  "inspector.transport": "Transport",
  "inspector.command": "Command",
  "inspector.args": "Args",
  "inspector.envKeys": "Env keys (names only)",
  "inspector.sourceRepo": "Source repo",
  "inspector.onDisk": "On disk",
  "inspector.installLocation": "Install location",
  "inspector.key": "Key",
  "inspector.config": "Configuration",
  "inspector.details": "Details",
  // badge values
  "badge.enabled": "enabled",
  "badge.disabled": "disabled",
  "badge.cached": "cached",
  "badge.missing": "missing",
  "badge.onDisk": "on disk",
  "badge.notOnDisk": "not on disk",
} as const;

export type StringKey = keyof typeof EN;

const ZH: Record<StringKey, string> = {
  "nav.dashboard": "总览",
  "nav.compare": "对比",
  "nav.doctor": "体检",
  "view.dashboard.subtitle": "实时清点你的 {target} 配置",
  "view.compare.subtitle": "Claude 与 Codex —— 按 名称 × 类型 看存在情况",
  "view.doctor.subtitle": "{target} 的可加载性与健康检查",

  "sidebar.target": "目标",
  "sidebar.readonly": "只读",
  "sidebar.reload": "刷新",
  "sidebar.toggleTheme": "切换主题",
  "sidebar.toggleLang": "切换语言",
  "sidebar.engineUnreachable": "引擎不可达",
  "sidebar.live": "实时",
  "sidebar.connecting": "连接中…",
  "sidebar.offline": "离线",
  "sidebar.inventory": "清单",
  "sidebar.analysis": "分析",

  "write.title": "治理操作",
  "write.action.enable": "启用插件",
  "write.action.disable": "禁用插件",
  "write.working": "处理中…",
  "write.noChange": "已是目标状态 —— 无需写入。",
  "write.line": "settings.json · 第 {line} 行",
  "write.reversible": "将修改 settings.json。可回滚 —— 写入前会自动快照。",
  "write.confirm": "确认并应用",
  "write.cancel": "取消",
  "write.dismiss": "关闭",
  "write.done": "已应用。",
  "write.snapshot": "快照 {id} —— 回滚命令：rollback {id}",
  "write.failed": "操作未能完成。",
  "write.vis.current": "当前可见性",
  "write.vis.set": "设为",
  "write.mcp.hint":
    "MCP 服务的启停状态记录在 config.toml，此处不预先显示 —— 选择操作后会先预览实际改动。",
  "write.mcp.enable": "启用服务",
  "write.mcp.disable": "禁用服务",
  "write.mcp.line": "config.toml · 第 {line} 行",
  "write.mcp.reversible": "将修改 config.toml。可回滚 —— 写入前会自动快照。",

  "common.loading": "加载中…",
  "common.filter": "筛选…",
  "common.errorTitle": "无法连接引擎",
  "common.errorHintBefore": "API 服务在运行吗？用以下命令启动",
  "col.name": "名称",

  "dash.kpi.skills": "技能",
  "dash.kpi.agents": "子代理",
  "dash.kpi.commands": "命令",
  "dash.kpi.plugins": "插件",
  "dash.kpi.marketplaces": "插件市场",
  "dash.kpi.mcpServers": "MCP 服务",
  "dash.visDefault": "默认",

  "compare.filter.all": "全部",
  "compare.filter.both": "两者都有",
  "compare.filter.claudeOnly": "仅 Claude",
  "compare.filter.codexOnly": "仅 Codex",
  "compare.comparing": "正在对比…",
  "compare.noData": "没有对比数据。",
  "compare.componentsUnit": "个组件",
  "compare.byKindTitle": "按类型 —— 共有 vs 仅单边",
  "compare.componentsTitle": "组件 · 显示 {n} 个",
  "compare.noMatch": "没有组件匹配。",
  "compare.col.kind": "类型",
  "compare.col.presence": "存在情况",
  "compare.legend.both": "共有",
  "compare.legend.claudeOnly": "仅 Claude",
  "compare.legend.codexOnly": "仅 Codex",
  "compare.presence.both": "共有",
  "compare.presence.claude-only": "仅 claude",
  "compare.presence.codex-only": "仅 codex",
  "compare.caveatBefore": "存在情况按",
  "compare.caveatKey": "名称 × 类型",
  "compare.caveatAfter": " 匹配。一个名称在两边都出现，并不保证内容相同。",

  "doctor.loadabilityTitle": "可加载性 · {target}",
  "doctor.loadable": "可加载",
  "doctor.degraded": "降级",
  "doctor.notLoaded": "未加载",
  "doctor.findingsBySeverity": "按严重程度分类",
  "doctor.errors": "错误",
  "doctor.warnings": "警告",
  "doctor.info": "提示",
  "doctor.probeMeta": "探测级别：{level} · {total} 项检查 · {ran} 项已执行",
  "doctor.findingsTitle": "发现项 · {n}",
  "doctor.healthy": "没有发现项 —— 配置看起来很健康。",

  "inspector.close": "关闭",
  "inspector.governance": "治理",
  "inspector.frontmatter": "前置元数据",
  "inspector.shadowing": "加载与遮蔽",
  "inspector.path": "路径",
  "inspector.tier": "层级",
  "inspector.marketplace": "市场",
  "inspector.version": "版本",
  "inspector.visibility": "可见性",
  "inspector.controlledBy": "控制来源",
  "inspector.controlledBy.settings": "settings.json 的 skillOverrides",
  "inspector.controlledBy.default": "默认（前置元数据）",
  "inspector.description": "描述",
  "inspector.tools": "工具",
  "inspector.origin": "来源标记",
  "inspector.noShadow": "未被遮蔽 —— 该项可干净解析。",
  "inspector.shadowed":
    "属于一个 {kind} 名称冲突（共 {count} 个同名）—— 由加载顺序决定胜出者。",
  "inspector.codexCoexist": "Codex 同名组件共存 —— codex 不发生遮蔽（未核验）。",
  "inspector.actionsP2": "写操作（禁用 / 可见性 / 删除）将在 P2 阶段提供 —— 本视图为只读。",
  "inspector.contentDeferred":
    "完整 SKILL.md 预览暂缓（它需要一个独立的文件读取端点，超出当前冻结的只读白名单）。",

  "dash.kindTitle": "{kind} · {target}",
  "dash.itemCount": "{shown} / {total}",
  "dash.noItems": "未找到任何项。",
  "dash.noMatchItems": "没有匹配筛选条件的项。",
  "col.source": "来源",
  "col.description": "描述",
  "col.visibility": "可见性",
  "col.model": "模型",
  "col.version": "版本",
  "col.enabled": "启用",
  "col.marketplace": "市场",
  "col.scope": "作用域",
  "col.transport": "传输",
  "col.command": "命令",
  "col.sourceRepo": "源仓库",
  "col.onDisk": "本地",
  "inspector.model": "模型",
  "inspector.disallowedTools": "禁用工具",
  "inspector.enabled": "启用状态",
  "inspector.cachePresent": "缓存",
  "inspector.scope": "作用域",
  "inspector.transport": "传输方式",
  "inspector.command": "命令",
  "inspector.args": "参数",
  "inspector.envKeys": "环境变量名（仅键名）",
  "inspector.sourceRepo": "源仓库",
  "inspector.onDisk": "本地存在",
  "inspector.installLocation": "安装位置",
  "inspector.key": "标识",
  "inspector.config": "配置",
  "inspector.details": "明细",
  "badge.enabled": "已启用",
  "badge.disabled": "已禁用",
  "badge.cached": "已缓存",
  "badge.missing": "缺失",
  "badge.onDisk": "本地",
  "badge.notOnDisk": "不在本地",
};

const STRINGS: Record<Lang, Record<StringKey, string>> = { en: EN, zh: ZH };

export type TVars = Record<string, string | number>;
export type TFn = (key: StringKey, vars?: TVars) => string;

function format(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const LangContext = createContext<LangContextValue | null>(null);

function readInitialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* localStorage unavailable (private mode / SSR) — fall through to default */
  }
  return "zh";
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore persistence failures */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const t = useCallback<TFn>(
    (key, vars) => format(STRINGS[lang][key] ?? EN[key] ?? key, vars),
    [lang],
  );

  const value = useMemo<LangContextValue>(
    () => ({ lang, setLang, t }),
    [lang, setLang, t],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within <LangProvider>");
  return ctx;
}

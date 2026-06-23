/*
 * Typed client for the claude-mgr engine, surfaced over the localhost API.
 *
 * Every read command returns the engine's stable JSON envelope verbatim:
 *   { command, result, diagnostics }
 * (the same shape src/cli.mjs renders for --format json). The server only routes
 * READ commands (a frozen allowlist); writes are not reachable in P0.
 */

export type Severity = "error" | "warn" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  phase?: string;
  [k: string]: unknown;
}

export interface Envelope<T = unknown> {
  command: string;
  result: T;
  diagnostics: Diagnostic[];
}

export type TargetId = "claude" | "codex";

export interface StatusInfo {
  version: string;
  target: TargetId;
  configDir: string;
  /** which targets the server could resolve a config dir for */
  targets: TargetId[];
  /** item kinds the write channel may toggle on this target ([] = read-only here) */
  writeKinds: string[];
  /** resolution diagnostics (e.g. the missing-hooks-lib fallback warn) */
  diagnostics: Diagnostic[];
}

/** Inventory counts (the `inventory` command, no --type narrowing). */
export interface InventoryCounts {
  skills: number;
  agents: number;
  commands: number;
  plugins: number;
  marketplaces: number;
  mcpServers: number;
}

export interface InventoryResult {
  counts: InventoryCounts;
  statusLine: unknown;
  topDirs: string[];
  unknownTopDirs: unknown[];
}

/**
 * One discovered component from `inventory --type <kind>`. Fields are kind-specific
 * and mostly optional — `name` is the only field every kind carries:
 *   skill/agent/command → frontmatter + source + path (skill also: visibility)
 *   plugin              → key + marketplace + version + enabled + cachePresent (no path)
 *   mcp                 → scope + transport + command + args + envKeys (key names only)
 *   marketplace         → sourceRepo + onDisk + installLocation
 */
export interface InventoryItem {
  kind?: string;
  name: string;
  path?: string;
  source?: { tier?: string; plugin?: string; marketplace?: string; version?: string };
  frontmatter?: {
    name?: string;
    description?: string;
    origin?: string;
    tools?: string;
    model?: string;
    disallowedTools?: string;
    [k: string]: unknown;
  };
  /** effective skillOverrides state, or 'default' (Claude skills only) */
  visibility?: string;
  // plugin
  key?: string;
  marketplace?: string;
  version?: string;
  enabled?: boolean;
  cachePresent?: boolean;
  // mcp (env values are redacted by the engine; envKeys are key NAMES only)
  scope?: string;
  transport?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  // marketplace
  installLocation?: string;
  onDisk?: boolean;
  sourceRepo?: string;
}

export interface InventoryListResult {
  type: string;
  items: InventoryItem[];
}

// ── compare (cross-target presence) ──────────────────────────────────────────
export type Presence = "both" | "claude-only" | "codex-only";

export interface CompareTargetTotal {
  id: TargetId;
  label: string;
  total: number;
}

export interface CompareCategory {
  category: string;
  totals: Record<string, number>;
  both: number;
  only: Record<string, number>;
}

export interface CompareItem {
  category: string;
  key: string;
  name: string;
  presence: Presence;
  in: TargetId[];
}

export interface CompareResult {
  targets: CompareTargetTotal[];
  categories: CompareCategory[];
  items: CompareItem[];
  detail: boolean;
}

// ── conflicts (name collisions / shadowing) ──────────────────────────────────
export interface ConflictMember {
  name: string;
  path: string;
  source: { tier?: string; plugin?: string; marketplace?: string; version?: string };
}

export interface ConflictCluster {
  kind: string;
  key: string;
  confidence: string;
  severity: string;
  likelyWinner: ConflictMember;
  /** ranked, likelyWinner first */
  possibleWinners: ConflictMember[];
  reason: string;
  fix: string;
}

export interface ConflictResult {
  conflicts: ConflictCluster[];
  dispositions: unknown[];
}

// ── doctor + health ──────────────────────────────────────────────────────────
export interface DoctorCheck {
  id: number;
  code: string;
  probeLevel: string;
  ran: boolean;
  findings: number;
}

export interface DoctorResult {
  probeLevel: string;
  checks: DoctorCheck[];
}

export interface HealthSummary {
  total: number;
  loadable: number;
  degraded: number;
  notLoaded: number;
}

export interface HealthGroup {
  scope: string;
  kind: string;
  status: string;
  count: number;
  names: string[];
}

export interface HookExplanation {
  event: string;
  matcher: string | null;
  command: string;
  kind: string;
  target: string;
}

export interface HealthResult {
  health: { summary: HealthSummary; groups: HealthGroup[] };
  hooks: {
    summary: {
      total: number;
      missing: number;
      indeterminate: number;
      byKind: Record<string, number>;
    };
    explanations: HookExplanation[];
  };
  advice?: unknown;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? "";
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Server/version/target status — the always-present header + footer facts.
 * Pass the active target so the reported configDir matches the view (the server
 * defaults to claude when no target is given).
 */
export function fetchStatus(target?: TargetId): Promise<StatusInfo> {
  const qs = target ? `?target=${encodeURIComponent(target)}` : "";
  return getJson<StatusInfo>(`/api/status${qs}`);
}

/**
 * Call a read command and return its full envelope. `params` become query args
 * forwarded into ctx.args (e.g. { target: 'codex', type: 'skill' }).
 */
export function fetchCommand<T = unknown>(
  cmd: string,
  params: Record<string, string> = {},
): Promise<Envelope<T>> {
  const qs = new URLSearchParams(params).toString();
  const url = `/api/command/${encodeURIComponent(cmd)}${qs ? `?${qs}` : ""}`;
  return getJson<Envelope<T>>(url);
}

// ── write channel (P2 pilot — plugin enable/disable) ─────────────────────────
/** The byte-level change the toggle would make (null when it's a no-op). */
export interface WriteDiff {
  line: number;
  before: string;
  after: string;
}

/** Flattened result of a disable/enable call (the engine's summarize() shape). */
export interface WriteResult {
  status: string;
  ok: boolean;
  dryRun: boolean;
  kind: string | null;
  name: string | null;
  desired: boolean | null;
  target: string | null;
  diff: WriteDiff | null;
  alreadyInState: boolean;
  applied: boolean;
  snapshotId: string | null;
}

export interface WriteEnvelope {
  command: string;
  apply: boolean;
  code: number;
  result: WriteResult;
  diagnostics: Diagnostic[];
}

/**
 * Call the write channel. `verb` is 'disable' | 'enable'; `apply:false` is a dry-run
 * preview (no write), `apply:true` performs the gated, snapshot-backed write. The
 * custom header is what makes this reachable only from the same-origin app. A non-2xx
 * still returns its JSON envelope (refusals carry diagnostics) — only a transport/JSON
 * failure throws.
 */
export async function writeCommand(
  verb: "disable" | "enable",
  body: { target: TargetId; type: "plugin"; name: string; apply: boolean },
): Promise<WriteEnvelope> {
  const res = await fetch(`/api/write/${verb}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-claude-mgr-write": "1",
    },
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  }
  // Guard envelopes (bad-json / forbidden-host / command-not-allowed) lack `result`.
  if (!json || typeof json !== "object" || !("result" in json)) {
    const msg = (json as { message?: string })?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return json as WriteEnvelope;
}

export { ApiError };

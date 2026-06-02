/**
 * Purpose categorization for MCP servers (Phase-4 / TUI-support; pure).
 *
 * The sibling of categorize.mjs for the OTHER half of the original "classify Skill
 * / MCP" ask. MCP servers are named by SERVICE (github, exa, pencil, …), not by
 * purpose, so they get their own service-name rule table (MCP_RULES) over the
 * SHARED CATEGORIES vocabulary. Reads ONLY the server `name` — never the
 * command/args/url/envKeys (that is the secret-bearing surface; categorization
 * must not touch it). Heuristic + `uncategorized` fallback, exactly like the
 * component categorizer; the dogfood refines the rules. Every rule term is a
 * linear literal/anchored alternation (no unbounded `[^x]*`/`.*` gap → no ReDoS),
 * and the matched name is length-capped as a backstop.
 *
 * Pure; never throws; deterministic (stable category order); proto-safe (grouped
 * objects keyed only by the fixed CATEGORIES vocabulary, never by a server name).
 * Zero npm dependencies.
 */

import { CATEGORIES } from './categorize.mjs';

/** Bound the matched (untrusted) server name — keeps matching linear on a pathological value. */
const NAME_CAP = 512;

/**
 * Ordered service-name rules — FIRST match wins. A rule matches when its `name`
 * regex tests true against the lowercased server name. Specific buckets precede
 * the broad `development` one. Names are services, so there is no description axis.
 * (`writing`/`domain` rarely apply to an MCP server; those buckets simply stay
 * empty, which the UI renders as a present-but-zero group.)
 * @type {ReadonlyArray<{category: string, name: RegExp}>}
 */
const MCP_RULES = Object.freeze([
  // research / web-information services.
  { category: 'research', name: /exa|firecrawl|perplexity|\bbrave\b|tavily|context7|web-?search|web-?fetch|^fetch$|deepwiki|wikipedia|arxiv/ },
  // design / visual / media services.
  { category: 'design', name: /pencil|figma|canva|blender|excalidraw|^image|sketch|screenshot/ },
  // self-iteration / agent-meta services (memory, reasoning).
  { category: 'self-iteration', name: /memory|sequential-?thinking|\bthinking\b|knowledge-?graph|reason|reflection/ },
  // data / analytics / database services.
  { category: 'data', name: /postgres|sqlite|mysql|clickhouse|bigquery|\bredis\b|snowflake|supabase|mongo|duckdb|airtable|\bdb\b/ },
  // business / commerce services.
  { category: 'business', name: /stripe|plaid|hubspot|salesforce|shopify|quickbooks|paypal|square/ },
  // ops / infra / productivity-automation services.
  { category: 'ops', name: /docker|kubernetes|k8s|\baws\b|\bgcp\b|azure|terraform|slack|linear|\bjira\b|notion|sentry|computer-?use|desktop-?commander|cron|schedul|gateway|registry|grafana|datadog|pagerduty/ },
  // development / code / browser-automation services — broad, LAST before uncategorized.
  { category: 'development', name: /github|gitlab|\bgit\b|filesystem|file-?system|sourcegraph|\be2b\b|playwright|puppeteer|browser|chrome|\bide\b|\blsp\b|repl|sandbox|codesandbox/ },
]);

/**
 * Classify one MCP server into a purpose category by its service `name`. A
 * malformed record (missing/non-string name) is `uncategorized`. Pure; never throws.
 * @param {{name?: unknown}} server
 * @returns {string}  a member of CATEGORIES
 */
export function categorizeMcpServer(server) {
  const s = server || {};
  let name = typeof s.name === 'string' ? s.name.toLowerCase() : '';
  if (name === '') return 'uncategorized';
  if (name.length > NAME_CAP) name = name.slice(0, NAME_CAP);
  for (const rule of MCP_RULES) {
    if (rule.name.test(name)) return rule.category;
  }
  return 'uncategorized';
}

/**
 * @typedef {Object} CategorizeMcpResult
 * @property {Object<string, string[]>} byCategory  category → server names (all CATEGORIES present)
 * @property {Object<string, number>} summary       category → count (all CATEGORIES present)
 * @property {import('../lib/diagnostic.mjs').Diagnostic[]} diagnostics  one info when uncategorized > 0
 */

/**
 * Categorize a list of MCP servers into a TUI/Web-UI-ready grouped view. The
 * grouped objects carry ALL categories (empty → `[]`/`0`) and are keyed ONLY by
 * the fixed CATEGORIES vocabulary (never by an untrusted server name), so there is
 * no prototype-pollution surface. Pure; never throws; deterministic.
 * @param {Array<{name?: unknown}>} servers
 * @returns {CategorizeMcpResult}
 */
export function categorizeMcp(servers) {
  const list = Array.isArray(servers) ? servers : [];
  /** @type {Object<string, string[]>} */
  const byCategory = Object.create(null);
  /** @type {Object<string, number>} */
  const summary = Object.create(null);
  for (const cat of CATEGORIES) {
    byCategory[cat] = [];
    summary[cat] = 0;
  }
  for (const srv of list) {
    const category = categorizeMcpServer(srv);
    const name = srv && typeof srv.name === 'string' ? srv.name : '';
    byCategory[category].push(name);
    summary[category] += 1;
  }
  for (const cat of CATEGORIES) byCategory[cat].sort();

  /** @type {import('../lib/diagnostic.mjs').Diagnostic[]} */
  const diagnostics = [];
  if (summary.uncategorized > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'categorize-mcp-uncategorized',
      message: `${summary.uncategorized} MCP server(s) did not match any purpose category — refine MCP_RULES in src/analysis/categorize-mcp.mjs`,
      phase: 'categorize',
    });
  }
  return { byCategory, summary, diagnostics };
}

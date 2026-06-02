/**
 * Purpose categorization for discovered components (Phase-4 / TUI-support; pure).
 *
 * Sorts each skill / agent / command into a PURPOSE category for the TUI and the
 * future Web-UI grouped views — so the inventory is not just a flat list but a
 * curated, browsable tree (writing / development / self-iteration / …). This is a
 * read-only ENRICHMENT over the existing scan output: it reads ONLY a component's
 * `name` and its frontmatter `description` (both already on the ComponentRecord),
 * adds NO new I/O, and exposes NO new secret surface.
 *
 * Method: an ORDERED rule table (`CATEGORY_RULES`) of name/description keyword
 * regexes. The FIRST rule whose `name` regex matches the component name — or whose
 * optional `desc` regex matches the description — wins. Order encodes specificity:
 * the meta ("self-iteration") and vertical ("domain") buckets come before the broad
 * "development" catch-all so e.g. `skill-creator` lands in self-iteration (not
 * development) and `healthcare-eval-harness` in domain. Anything unmatched is
 * `uncategorized` — surfaced (count) as an info Diagnostic so the taxonomy can be
 * refined against real data rather than guessed up front.
 *
 * The taxonomy is deliberately a plain DATA table: editing a regex or adding a
 * category is a one-line change, and the dogfood output IS the proposal. Keyword
 * matching is heuristic — false buckets are expected and cheap to correct; this is
 * a display aid, never a security or load-order decision.
 *
 * Zero npm dependencies. Pure; never throws; deterministic (stable category order).
 */

/**
 * The fixed category vocabulary, in the order they are reported. `uncategorized`
 * is always last. These are the ONLY keys ever used in the grouped output, so the
 * output object is never keyed by an (untrusted) component name — no prototype-
 * pollution surface.
 * @type {readonly string[]}
 */
export const CATEGORIES = Object.freeze([
  'writing',
  'development',
  'self-iteration',
  'research',
  'design',
  'ops',
  'data',
  'business',
  'domain',
  'uncategorized',
]);

/**
 * Ordered classification rules — FIRST match wins. A rule matches when its `name`
 * regex tests true against the lowercased component name, OR (when present) its
 * `desc` regex tests true against the lowercased description. Specific/meta buckets
 * precede the broad `development` catch-all on purpose.
 * @type {ReadonlyArray<{category: string, name: RegExp, desc?: RegExp}>}
 */
const CATEGORY_RULES = Object.freeze([
  // self-iteration / meta — improving skills, agents, hooks, or the harness itself.
  {
    category: 'self-iteration',
    name: /skill-(creator|create|health|comply|scout|stocktake)|skillify|hookify|self-improve|continuous-learning|harness-(optimizer|construction|audit)|harness-audit|agent-(harness|sort|eval|architecture|introspection)|prompt-optimiz|rules-distill|configure-ecc|^omc|^learner?$|instinct|^evolve$|claude-md|deepinit|context-budget|token-budget|model-route|council|devfleet|^multi-(execute|plan|workflow|backend|frontend)$|^prp-|agentic-engineering|agent-payment|learn-eval|^learn$|^eval$|^promote$|^prune$|checkpoint/,
    desc: /\b(skill|agent|hook|harness|prompt)s?\b[^.]{0,300}\b(creat|generat|improv|optimi|audit|distill|author|scaffold)/,
  },
  // domain-specific verticals (industry / regulated workflows).
  {
    category: 'domain',
    name: /healthcare|hipaa|emr|cdss|clinical|\bphi\b|logistics|carrier|customs|freight|inventory-demand|production-scheduling|returns-reverse|finance|billing|invoice|energy-procurement|\bdefi\b|trading|token-decimals|\bamm\b|oracle|prediction-market|visa|trade-compliance|quality-nonconformance|healthcare/,
  },
  // writing & content.
  {
    category: 'writing',
    name: /writer|writing|article|content-(engine|research|hash)|brand-voice|blog|essay|crosspost|changelog|avoid-ai|research-paper|newsletter|marketing-copy|\bwiki\b|article-writing/,
    desc: /\b(writ(e|ing|er)|article|blog post|prose|newsletter|essay|long-form|copywrit)/,
  },
  // research & information-gathering.
  {
    category: 'research',
    name: /research|deep-(research|dive)|\bexa\b|retrieval|competitive-ads|search-first|deepsearch|knowledge-ops|lead-(research|intelligence)|scraper?\b|market-research/,
    desc: /\b(research|investigat|citations?|sources?|literature review|gather (data|evidence))/,
  },
  // design & UI / visual / media.
  {
    category: 'design',
    name: /design|^ui-|liquid-glass|theme-factory|brand-guidelines|canvas-design|\bgsap\b|\bmotion\b|frontend-slides|frontend-design|a11y|accessibility|artifacts-builder|remotion|manim|video|image-enhancer|fal-ai|slack-gif/,
    desc: /\b(UI|UX|visual|layout|theme|aesthetic|animation|render a|design (system|direction))/,
  },
  // ops / automation / infrastructure / orchestration.
  {
    category: 'ops',
    name: /docker|deploy|github-ops|terminal-ops|\bpm2\b|canary|mcp-(builder|setup|server)|\brelease\b|automation|-ops$|ops-|\binfra|pipeline|orchestrat|autonomous|continuous-agent|notifications?|^connect$|scheduled?-task|loop-(start|status|operator)/,
    desc: /\b(deploy|CI\/CD|docker|pipeline|automat|infrastructure|orchestrat|schedul)/,
  },
  // data / analytics / databases.
  {
    category: 'data',
    name: /dashboard|clickhouse|data-(scraper|atlas|throughput|engineering)|benchmark|analytics|postgres|\bredis\b|mysql|\bsql\b|database-migrations|\bjpa\b|prisma|exposed-patterns/,
    desc: /\b(database|analytics|querie|dashboard|metrics|schema migration)/,
  },
  // business / marketing / growth.
  {
    category: 'business',
    name: /marketing|investor|^lead-|\bseo\b|sales|connections-optimizer|social-(graph|publisher)|outreach|campaign|twitter-algorithm|x-api|domain-name-brainstormer/,
    desc: /\b(marketing|sales|investor|\bSEO\b|outreach|campaign|growth|audience)/,
  },
  // development — broad catch-all, LAST before uncategorized.
  {
    category: 'development',
    name: /review(er)?|build|test(ing)?|patterns|\btdd\b|debug|refactor|\blint|api-(design|connector)|backend|frontend|coding-standards|simplif|build-(error|fix)|verification|security|e2e|\bqa\b|migration|architecture|hexagonal|runtime|sdk|repl|nextjs|turbopack|nodejs-|laravel|keccak|foundation-models|plugin-discovery|bun-runtime|^(analyst|planner|architect|debugger|tracer|verifier|critic|executor|git-master)$|feature-dev|build-fix|quality-gate/,
    desc: /\b(code|build|test|debug|refactor|compile|API|lint|review|implement|TypeScript|Python|function|class)/,
  },
]);

/**
 * Caps on the keyword-tested text. `name` + `description` come from frontmatter —
 * UNTRUSTED and uncapped at the source — so bound the regex INPUT to keep matching
 * cheap even on a pathological value (mirrors `extractVersion`'s 4 KiB cap in
 * probe-cli.mjs). Belt-and-suspenders with the `{0,N}`-bounded gaps in the rules:
 * any NEW rule regex MUST avoid an unbounded gap (`[^x]*` / `.*`) between two
 * required anchors, or it reintroduces O(n^2) backtracking on adversarial input.
 */
const NAME_CAP = 512;
const DESC_CAP = 4096;

/**
 * Classify one component into a purpose category. Reads only `name` +
 * `frontmatter.description`; a malformed record (missing/non-string name) is
 * `uncategorized`. Pure; never throws.
 * @param {{name?: unknown, frontmatter?: {description?: unknown}}} component
 * @returns {string}  a member of CATEGORIES
 */
export function categorizeComponent(component) {
  const c = component || {};
  let name = typeof c.name === 'string' ? c.name.toLowerCase() : '';
  if (name === '') return 'uncategorized';
  if (name.length > NAME_CAP) name = name.slice(0, NAME_CAP);
  const fm = c.frontmatter;
  let desc = fm && typeof fm.description === 'string' ? fm.description.toLowerCase() : '';
  if (desc.length > DESC_CAP) desc = desc.slice(0, DESC_CAP);
  for (const rule of CATEGORY_RULES) {
    if (rule.name.test(name)) return rule.category;
    if (rule.desc && desc !== '' && rule.desc.test(desc)) return rule.category;
  }
  return 'uncategorized';
}

/**
 * @typedef {Object} CategorizeResult
 * @property {{name: unknown, kind: unknown, category: string}[]} items  per-component category
 * @property {Object<string, string[]>} byCategory  category → component names (stable category order)
 * @property {Object<string, number>} summary       category → count (stable category order)
 * @property {import('../lib/diagnostic.mjs').Diagnostic[]} diagnostics  one info when uncategorized > 0
 */

/**
 * Categorize a list of components into a TUI/Web-UI-ready grouped view. The
 * `byCategory` and `summary` objects carry ALL categories (a category with no
 * members maps to `[]` / `0`, so the UI can render a stable set of buckets). The
 * grouped objects are keyed ONLY by the fixed CATEGORIES vocabulary (never by an
 * untrusted component name), so there is no prototype-pollution surface. Pure;
 * never throws; deterministic.
 * @param {Array<{name?: unknown, kind?: unknown, frontmatter?: object}>} components
 * @returns {CategorizeResult}
 */
export function categorizeComponents(components) {
  const list = Array.isArray(components) ? components : [];
  /** @type {Object<string, string[]>} */
  const byCategory = Object.create(null);
  /** @type {Object<string, number>} */
  const summary = Object.create(null);
  for (const cat of CATEGORIES) {
    byCategory[cat] = [];
    summary[cat] = 0;
  }

  /** @type {{name: unknown, kind: unknown, category: string}[]} */
  const items = [];
  for (const c of list) {
    const category = categorizeComponent(c);
    const name = c && typeof c.name === 'string' ? c.name : '';
    const kind = c ? c.kind : undefined;
    items.push({ name: c ? c.name : undefined, kind, category });
    byCategory[category].push(name);
    summary[category] += 1;
  }
  for (const cat of CATEGORIES) byCategory[cat].sort();

  /** @type {import('../lib/diagnostic.mjs').Diagnostic[]} */
  const diagnostics = [];
  if (summary.uncategorized > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'categorize-uncategorized',
      message: `${summary.uncategorized} component(s) did not match any purpose category — refine CATEGORY_RULES in src/analysis/categorize.mjs`,
      phase: 'categorize',
    });
  }
  return { items, byCategory, summary, diagnostics };
}

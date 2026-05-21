/**
 * Diagnostic model + accumulator for claude-mgr.
 *
 * Core rule (per plan, "DiagnosticBag that accumulates and NEVER throws"):
 * collecting a diagnostic must never throw, even on malformed input. The bag
 * is the single channel through which non-fatal failures surface; nothing in
 * the read path is allowed to raise. Every scanner returns
 * `{components[], diagnostics[]}` and never throws on bad input.
 *
 * Zero dependencies. Node stdlib only.
 */

/**
 * @typedef {'info'|'warn'|'error'} Severity
 */

/**
 * A single structured finding. `code` is a stable, machine-readable kebab id
 * (e.g. 'spawn-write-outside-expected'); `message` is human text; `severity`
 * gates release/doctor logic. Optional fields locate and remediate the finding:
 * `path` (the file it concerns), `phase` (which scan produced it), `fix`
 * (a human hint for how to resolve it).
 *
 * @typedef {Object} Diagnostic
 * @property {Severity} severity
 * @property {string} code
 * @property {string} message
 * @property {string} [path]
 * @property {string} [phase]
 * @property {string} [fix]
 */

const VALID_SEVERITIES = new Set(['info', 'warn', 'error']);

/**
 * Normalize an arbitrary input into a well-formed Diagnostic without throwing.
 * Unknown severities collapse to 'error' (fail loud, never silently drop).
 *
 * @param {unknown} input
 * @returns {Diagnostic}
 */
export function toDiagnostic(input) {
  const obj = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const codeRaw = obj.code;
  const sevRaw = obj.severity;
  const msgRaw = obj.message;

  const code = typeof codeRaw === 'string' && codeRaw.length > 0 ? codeRaw : 'unknown';
  const severity = typeof sevRaw === 'string' && VALID_SEVERITIES.has(sevRaw)
    ? /** @type {Severity} */ (sevRaw)
    : 'error';
  let message;
  if (typeof msgRaw === 'string') {
    message = msgRaw;
  } else if (input instanceof Error) {
    message = input.message;
  } else {
    message = '';
  }

  /** @type {Diagnostic} */
  const d = { severity, code, message };
  if (typeof obj.path === 'string') d.path = obj.path;
  if (typeof obj.phase === 'string') d.phase = obj.phase;
  if (typeof obj.fix === 'string') d.fix = obj.fix;
  return d;
}

/**
 * Accumulates diagnostics. NEVER throws on add. This is the contract the rest
 * of the codebase relies on: any read-path failure becomes a Diagnostic here.
 */
export class DiagnosticBag {
  constructor() {
    /** @type {Diagnostic[]} */
    this._items = [];
  }

  /**
   * Add a diagnostic. Accepts a partial object or an Error; normalizes it.
   * Guaranteed not to throw.
   * @param {unknown} input
   * @returns {Diagnostic} the normalized diagnostic that was stored
   */
  add(input) {
    let d;
    try {
      d = toDiagnostic(input);
    } catch {
      // Absolute backstop: even normalization failure must not throw.
      d = { severity: 'error', code: 'unknown', message: '' };
    }
    this._items.push(d);
    return d;
  }

  /**
   * Convenience: add from an Error with an explicit code.
   * @param {string} code
   * @param {unknown} err
   * @param {Partial<Diagnostic>} [extra] optional path/phase/fix overrides
   * @returns {Diagnostic}
   */
  addError(code, err, extra) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return this.add({ severity: 'error', code, message, ...(extra ?? {}) });
  }

  /** @returns {boolean} */
  hasErrors() {
    return this._items.some((d) => d.severity === 'error');
  }

  /**
   * Count diagnostics. With no argument, returns the total; otherwise the
   * number matching the given severity.
   * @param {Severity} [severity]
   * @returns {number}
   */
  count(severity) {
    if (!severity) return this._items.length;
    return this._items.filter((d) => d.severity === severity).length;
  }

  /** @returns {ReadonlyArray<Diagnostic>} a copy; internal array stays private */
  all() {
    return this._items.slice();
  }

  /**
   * Merge another bag's items into this one (chainable).
   * @param {DiagnosticBag} other
   * @returns {this}
   */
  merge(other) {
    if (other && typeof other.all === 'function') {
      for (const d of other.all()) this._items.push(d);
    }
    return this;
  }

  /**
   * Serialize to a plain array of diagnostics plus severity counts. Used by the
   * Result envelope and JSON output. Never throws.
   * @returns {{diagnostics: Diagnostic[], counts: {info: number, warn: number, error: number}}}
   */
  toJSON() {
    return {
      diagnostics: this.all(),
      counts: {
        info: this.count('info'),
        warn: this.count('warn'),
        error: this.count('error'),
      },
    };
  }
}

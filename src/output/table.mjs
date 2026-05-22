/**
 * Human table output adapter (P1.U14 sub-unit B).
 *
 * Renders a list of rows as aligned monospaced columns for the CLI's default
 * (human) format. Column width = max(header, all cells); cells are padded per a
 * left/right alignment. Color is OPT-IN: `formatTable` output is always plain so
 * it is safe to pipe/redirect; a caller colorizes specific cells via `colorize`,
 * which respects the `NO_COLOR` convention (https://no-color.org) and an explicit
 * `opts.color` override.
 *
 * Why plain-by-default: ANSI escapes corrupt redirected output and break string
 * assertions in tests. Keeping the table body plain and color a per-cell helper
 * means the common path needs no terminal detection at all.
 *
 * Never throws — every cell is coerced with String(); bad inputs degrade to ''.
 * Zero npm dependencies (no ANSI library). Node stdlib only. Pure (aside from the
 * documented NO_COLOR env read in colorize).
 */

/** Two spaces between columns — wide enough to read, narrow enough to scan. */
const COLUMN_GAP = '  ';

/** SGR reset, appended after a colorized span so color does not bleed. */
const RESET = '[0m';

/**
 * @typedef {Object} Column
 * @property {string} key                  property read from each row
 * @property {string} header               column heading text
 * @property {'left'|'right'} [align]       cell alignment; default 'left'
 */

/**
 * @typedef {Object} TableOpts
 * @property {boolean} [color]   reserved for future whole-table coloring; the
 *                               table body is always plain in Phase 1.
 */

/**
 * @typedef {Object} ColorOpts
 * @property {boolean} [color]   `false` force-DISABLES color. `true` or undefined
 *                               means color is on UNLESS NO_COLOR is set — NO_COLOR
 *                               always wins (there is no way to force color past it).
 */

/**
 * Render columns + rows as an aligned monospaced block: header, dashed separator,
 * then one line per row. Empty `columns` → ''. Empty `rows` → header+separator
 * only. Never throws.
 *
 * @param {Column[]} columns
 * @param {Array<Record<string, unknown>>} rows
 * @param {TableOpts} [_opts]   reserved; the body is always plain in Phase 1
 * @returns {string}
 */
export function formatTable(columns, rows, _opts) {
  const cols = Array.isArray(columns) ? columns : [];
  if (cols.length === 0) return '';
  const data = Array.isArray(rows) ? rows : [];

  const widths = cols.map((col) => columnWidth(col, data));
  const headerLine = renderLine(cols.map((col) => cellText(col.header)), cols, widths);
  const separatorLine = widths.map((w) => '-'.repeat(w)).join(COLUMN_GAP);
  const bodyLines = data.map((row) => renderLine(cols.map((col) => cellText(row && row[col.key])), cols, widths));

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

/**
 * Wrap `text` in an ANSI SGR `code` only when color is enabled. Color is enabled
 * unless `opts.color === false`, OR `NO_COLOR` is set (any non-empty value), OR
 * `opts.color` is undefined and `NO_COLOR` is set. When disabled, returns the
 * text unchanged (no escapes). Never throws.
 *
 * @param {string} text
 * @param {string|number} code   SGR parameter, e.g. 31 (red) or '1;32'
 * @param {ColorOpts} [opts]
 * @returns {string}
 */
export function colorize(text, code, opts) {
  const s = cellText(text);
  if (!colorEnabled(opts)) return s;
  return `[${code}m${s}${RESET}`;
}

/**
 * Decide whether color is enabled. Explicit `opts.color` wins; otherwise color is
 * on unless the `NO_COLOR` env var holds a non-empty value.
 *
 * @param {ColorOpts} [opts]
 * @returns {boolean}
 */
function colorEnabled(opts) {
  if (opts && typeof opts === 'object' && typeof opts.color === 'boolean') {
    // Explicit false always disables; explicit true still yields to NO_COLOR.
    if (opts.color === false) return false;
  }
  const noColor = typeof process !== 'undefined' && process.env ? process.env.NO_COLOR : undefined;
  if (typeof noColor === 'string' && noColor.length > 0) return false;
  return true;
}

/**
 * Width of one column = max of its header and every cell's rendered length.
 * Length is UTF-16 code-unit count; wide (CJK) glyphs display as 2 terminal
 * columns but count as 1, so CJK-heavy cells may visually under-pad. Known
 * Phase-1 limitation — full East-Asian-Width handling needs a width table the
 * zero-dependency constraint disallows.
 *
 * @param {Column} col
 * @param {Array<Record<string, unknown>>} data
 * @returns {number}
 */
function columnWidth(col, data) {
  let w = cellText(col.header).length;
  for (const row of data) {
    const len = cellText(row && row[col.key]).length;
    if (len > w) w = len;
  }
  return w;
}

/**
 * Join one row of already-stringified cells, padding each to its column width per
 * the column's alignment (default left), separated by the column gap.
 *
 * @param {string[]} cells
 * @param {Column[]} cols
 * @param {number[]} widths
 * @returns {string}
 */
function renderLine(cells, cols, widths) {
  return cells.map((cell, i) => pad(cell, widths[i], cols[i] && cols[i].align)).join(COLUMN_GAP);
}

/**
 * Pad `text` to `width`: right-align prepends spaces, anything else appends them.
 * A cell already at/over width is returned unchanged (never truncated).
 *
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} [align]
 * @returns {string}
 */
function pad(text, width, align) {
  const gap = width - text.length;
  if (gap <= 0) return text;
  const fill = ' '.repeat(gap);
  return align === 'right' ? fill + text : text + fill;
}

/**
 * Coerce any cell value to a display string. `null`/`undefined` → '' (per the
 * contract); everything else via String(), so numbers/objects never throw.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cellText(value) {
  return String(value ?? '');
}

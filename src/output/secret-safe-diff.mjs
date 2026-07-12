/**
 * Secret-safe display adapter for the raw Myers line diff.
 *
 * Change detection, alignment, line numbers, and stats are computed from the raw
 * inputs first. Only the copied op text is replaced from independently redacted
 * source lines, so a secret-only rotation remains a real delete+insert while no raw
 * secret reaches unified or structured renderers. Pure; never mutates the raw diff.
 */

import { redactSecretsLines } from '../lib/redact-secrets-text.mjs';
import { computeLineDiff } from './diff.mjs';

const SAFE_FALLBACK = '<redacted>';

/** Normalize text exactly as the Myers engine does, after display redaction. */
function safeLines(text) {
  const input = typeof text === 'string' ? text : '';
  const safe = redactSecretsLines(input);
  return (typeof safe === 'string' ? safe : '').replace(/\r\n?/g, '\n').split('\n');
}

/** Select one already-redacted numbered source line. */
function safeLine(lines, line) {
  if (!Number.isInteger(line) || line < 1) return SAFE_FALLBACK;
  const value = lines[line - 1];
  return typeof value === 'string' ? value : SAFE_FALLBACK;
}

/** Select display text without trusting either side of an asymmetric equal op. */
function safeOpText(op, aLines, bLines) {
  if (op.type === 'insert') return safeLine(bLines, op.bLine);
  if (op.type === 'delete') return safeLine(aLines, op.aLine);
  const aText = safeLine(aLines, op.aLine);
  const bText = safeLine(bLines, op.bLine);
  return aText === bText ? aText : SAFE_FALLBACK;
}

/**
 * Compute raw line semantics and return a display-safe copy of the diff.
 * @param {unknown} aText
 * @param {unknown} bText
 * @returns {import('./diff.mjs').LineDiff}
 */
export function computeSecretSafeLineDiff(aText, bText) {
  const raw = computeLineDiff(aText, bText);
  const aLines = safeLines(aText);
  const bLines = safeLines(bText);
  const ops = raw.ops.map((op) => ({ ...op, text: safeOpText(op, aLines, bLines) }));
  return { ops, stats: { ...raw.stats } };
}

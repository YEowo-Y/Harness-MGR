/**
 * Secrets content sniffer (Unit C / P3.U6 prereq).
 *
 * Consumed by P3.U6 (snapshot-secrets-filter). Pure; never throws.
 *
 * Detects secrets by CONTENT rather than filename. Complements the basename
 * allowlist in `secrets-allowlist.mjs`: a PEM pasted into `hooks/config.json`,
 * a bearer token inside `notes.md`, or a key saved as `.mykey` all pass the
 * filename check — this module catches them.
 *
 * Detection order (first match wins, entropy heuristic LAST):
 *   1. PEM blocks        (kind:'pem')
 *   2. Token shapes      (kind:'token')
 *   3. High-entropy run  (kind:'entropy')
 *
 * DOCUMENTED GAP — bare hex secrets (no recognisable prefix):
 *   Random hex keys and git SHAs are statistically IDENTICAL in Shannon entropy
 *   (both draw from 16 symbols at near-uniform probability). The entropy net
 *   cannot separate them: a threshold that catches hex secrets would necessarily
 *   flag every 40-char git SHA and every package-lock.json integrity hash,
 *   flooding false positives and violating the "legit skills must be captured"
 *   precision requirement (decided-item plan L22). Bare-hex secrets are therefore
 *   a DOCUMENTED GAP here; they are covered by the basename/extension allowlist
 *   (`.key`, `.asc`, `id_rsa`, etc.) and by the prefix-anchored token rules.
 *
 * EXPECTED entropy hits: package-lock.json / yarn.lock integrity hashes
 *   (sha512-<88 base64 chars>) WILL flag as kind:'entropy'. This is an acceptable
 *   over-flag — the U6 snapshot-secrets-filter can exclude lockfiles via their
 *   filename/extension before content-sniffing.
 *
 * Input: a Buffer or a string. Non-string/non-Buffer inputs return {match:false}
 * without throwing. Input is capped at the first INPUT_CAP bytes before any
 * scanning to bound regex cost on large/untrusted files.
 *
 * OPTION — `{ skipEntropy }` (follow-up #10, snapshot precision tuning):
 *   `sniffSecretContent(text, { skipEntropy: true })` runs the PEM + token legs
 *   but SKIPS the high-entropy run heuristic (leg 3), returning {match:false}
 *   when neither PEM nor token matched. WHY: leg 3 is the documented false-
 *   positive source — PROSE files (Markdown skill docs, READMEs) legitimately
 *   embed high-entropy runs (long URLs/paths, base64 examples, embedded hashes)
 *   that the entropy net cannot distinguish from a raw secret. The snapshot
 *   filter passes `skipEntropy:true` for `.md`/`.markdown` files so a prose file
 *   is dropped ONLY by a deterministic PEM/token shape (a real key pasted into a
 *   .md is STILL caught) or by its basename, NEVER by entropy alone. This is a
 *   deliberate recall/precision rebalance: dropping legit skill docs from a
 *   backup is a real data-completeness loss, whereas the only secret it now
 *   misses is a raw-base64-no-prefix credential in a .md — which is ALREADY the
 *   documented entropy GAP (see below) and is caught by name/extension if the
 *   file is named like a secret. Default `skipEntropy:false` is unchanged, so
 *   every pre-existing caller behaves identically.
 *
 * Zero npm dependencies. Pure; never throws on any input.
 */

/** Cap scanning to the first 64 KiB to prevent catastrophic backtracking. */
const INPUT_CAP = 64 * 1024;

// ---------------------------------------------------------------------------
// PEM block detector
// ---------------------------------------------------------------------------

/**
 * Matches: -----BEGIN CERTIFICATE-----, -----BEGIN OPENSSH PRIVATE KEY-----,
 * and the generic -----BEGIN <something> PRIVATE KEY----- form.
 * The newline following the header is not required — we match on the header
 * line alone so a single-line embedding (e.g. in JSON) is also caught.
 */
export const PEM_RE = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|CERTIFICATE|OPENSSH PRIVATE KEY)-----/;

// ---------------------------------------------------------------------------
// Token shape detectors (checked in order; first match returned)
// ---------------------------------------------------------------------------

/** @type {Array<{re: RegExp, pattern: string}>} */
export const TOKEN_PATTERNS = [
  // AWS access key ID (permanent) and STS temporary credentials:
  //   AKIA… = long-term IAM key; ASIA… = STS/assumed-role session key.
  //   Both: exactly 16 uppercase alphanumeric chars after the prefix.
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/, pattern: 'aws-akia' },

  // GitHub fine-grained personal access token (newer format, Nov 2022+).
  // github_pat_ followed by exactly 82 [A-Za-z0-9_] chars. These are NOT
  // caught by the ghp_/gho_ rule below — different prefix, different length.
  { re: /github_pat_[0-9A-Za-z_]{82}(?![0-9A-Za-z_])/, pattern: 'github-pat' },

  // GitHub classic tokens: ghp_ (personal), gho_ (oauth), ghs_ (server),
  // ghu_ (user), ghr_ (refresh) — each followed by exactly 36 alnum chars.
  { re: /(?:ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{36}(?![A-Za-z0-9])/, pattern: 'github-token' },

  // Google API key: AIza followed by exactly 35 [A-Za-z0-9_-] chars.
  // Negative lookahead enforces the exact length (consistent with the AKIA /
  // github rules), so a longer AIza-prefixed blob isn't truncated to 39 chars.
  { re: /AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, pattern: 'google-api-key' },

  // OpenAI key: sk- followed by 20+ alphanumeric chars.
  { re: /sk-[A-Za-z0-9]{20,}/, pattern: 'openai-key' },

  // Slack tokens: xoxb/xoxa/xoxp/xoxr/xoxs followed by dash-separated segments.
  { re: /xox[baprs]-[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/, pattern: 'slack-token' },

  // JWT: three base64url segments separated by dots, each starting with eyJ.
  { re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, pattern: 'jwt' },
];

// ---------------------------------------------------------------------------
// High-entropy run detector
// ---------------------------------------------------------------------------

/**
 * Entropy threshold: ENTROPY_THRESHOLD = 4.2 bits/char (SAMPLE entropy).
 *
 * Empirically measured on 200 deterministic LCG-seeded samples (seed 0xdeadbeef
 * for 32-byte / 0xcafebabe for 24-byte), sampling the contiguous base64-alphabet
 * run produced by Buffer.toString('base64') with padding stripped:
 *
 *   32-byte random → 43-char base64 run: min 4.833, mean 4.934, max 5.037
 *     → catch rate at 4.2: 100% (in true-random sampling ≈0.1% of 32-byte
 *       strings sit at the H≈4.20 boundary — an accepted residual miss).
 *
 *   NOTE: 24-byte random produces only a 32-char base64 run, which is BELOW
 *   the ENTROPY_RUN_RE {40,} char floor and is therefore NEVER entropy-checked
 *   (the isolated-run entropy 4.242 is shown for distribution context only; the
 *   pipeline catch rate for a standalone 32-char run is 0%). 24-byte secrets
 *   are a DOCUMENTED GAP for the entropy heuristic — they rely on the
 *   prefix-anchored token rules or the basename/extension allowlist.
 *
 * Benign corpus (runs actually matched by ENTROPY_RUN_RE ≥40 chars):
 *   40-char hex git SHA: entropy ≈ 3.90–3.96 → safely below 4.2
 *   prose / markdown table / long URL / SKILL.md: no runs ≥40 chars at all
 *
 * Threshold 4.2 catches 100% of 32-byte base64 secrets (43-char runs) while
 * keeping the full benign corpus at zero false positives.
 *
 * NOTE: asymptotic (source) entropy for a 64-symbol uniform base64 alphabet
 * is log2(64) = 6 bits/char, but finite SAMPLE entropy is capped at
 * log2(sample_length) ≈ 5.32 for 40-char runs. The threshold must be set
 * against SAMPLE entropy, not the asymptotic value.
 *
 * DOCUMENTED GAP — hex secrets: random hex keys and git SHAs have statistically
 * identical sample entropy (both 16-symbol alphabets → ~3.9 bits/char for 40
 * chars). Entropy cannot separate them; see the module header for the full
 * rationale. MIN_CHAR_CLASSES = 3 is KEPT to exclude all-lowercase runs,
 * all-digit strings, and other structured-but-low-entropy content.
 */
const ENTROPY_THRESHOLD = 4.2;
const MIN_CHAR_CLASSES = 3;

/** Matches a contiguous run of ≥40 base64/base64url/hex alphabet characters. */
const ENTROPY_RUN_RE = /[A-Za-z0-9+/=_-]{40,}/g;

/**
 * Compute the Shannon entropy (bits per character) of a string.
 * @param {string} s
 * @returns {number}
 */
function shannonEntropy(s) {
  if (s.length === 0) return 0;
  /** @type {Map<string,number>} */
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Count how many distinct character classes are represented in a string.
 * Classes: lowercase letters, uppercase letters, digits, special (+/=_-).
 * @param {string} s
 * @returns {number}  0–4
 */
function charClassCount(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[+/=_-]/.test(s)) n++;
  return n;
}

/**
 * Test a text string for a high-entropy run satisfying all three guards.
 * Returns the matching run string, or null.
 * @param {string} text
 * @returns {string|null}
 */
function findHighEntropyRun(text) {
  // Reset lastIndex before each use (global regex retains state).
  ENTROPY_RUN_RE.lastIndex = 0;
  let m;
  while ((m = ENTROPY_RUN_RE.exec(text)) !== null) {
    const run = m[0];
    if (
      shannonEntropy(run) > ENTROPY_THRESHOLD &&
      charClassCount(run) >= MIN_CHAR_CLASSES
    ) {
      return run;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SecretMatch
 * @property {boolean} match
 * @property {'pem'|'token'|'entropy'} [kind]    which rule matched (only when match)
 * @property {string} [pattern]                   the matching pattern (only when match)
 */

/**
 * Decode a Buffer to a UTF-8 string, replacing undecodable bytes with the
 * Unicode replacement character U+FFFD. `Buffer.toString('utf8')` does NOT
 * throw on invalid bytes — this is belt-and-suspenders wrapping.
 * @param {Buffer} buf
 * @returns {string}
 */
function bufferToString(buf) {
  try {
    return buf.toString('utf8');
  } catch {
    // toString('utf8') does not throw in practice; catch guards against future
    // Node.js changes or subclass overrides.
    return '';
  }
}

/**
 * @typedef {Object} SniffOptions
 * @property {boolean} [skipEntropy=false]  when true, skip the high-entropy run
 *   heuristic (leg 3); run only the deterministic PEM + token legs. Used by the
 *   snapshot filter for PROSE files to avoid false-positive drops (follow-up #10).
 */

/**
 * Inspect the content of a file (string or Buffer) for secret material.
 *
 * Returns the FIRST match found. When no secret is detected, returns
 * `{ match: false }`. Never throws on any input — non-string/non-Buffer
 * values (null, undefined, numbers, plain objects) all return `{ match: false }`.
 * Binary Buffers with invalid UTF-8 sequences decode to U+FFFD replacement
 * characters (no throw) and are unlikely to match any pattern.
 *
 * Input is capped at the first INPUT_CAP bytes/chars before scanning.
 *
 * @param {string|Buffer|unknown} textOrBuffer
 * @param {SniffOptions} [opts]   when `opts.skipEntropy` is true, leg 3 (the
 *   high-entropy run heuristic) is skipped; PEM + token legs still run. Default
 *   (absent opts or `skipEntropy:false`) is the original behaviour — backward
 *   compatible, every existing caller is unaffected.
 * @returns {SecretMatch}
 */
export function sniffSecretContent(textOrBuffer, opts) {
  // skipEntropy must be EXACTLY true to opt out; any other value (absent, false,
  // junk) keeps the original three-leg behaviour for backward compatibility.
  const skipEntropy = opts != null && typeof opts === 'object' && opts.skipEntropy === true;

  // Normalise to string, cap, reject non-string/non-Buffer input.
  let text;
  if (Buffer.isBuffer(textOrBuffer)) {
    text = bufferToString(textOrBuffer.subarray(0, INPUT_CAP));
  } else if (typeof textOrBuffer === 'string') {
    text = textOrBuffer.length > INPUT_CAP ? textOrBuffer.slice(0, INPUT_CAP) : textOrBuffer;
  } else {
    return { match: false };
  }

  // 1. PEM block detection.
  if (PEM_RE.test(text)) {
    return { match: true, kind: 'pem', pattern: 'pem-block' };
  }

  // 2. Token shape detection (first matching pattern wins).
  for (const { re, pattern } of TOKEN_PATTERNS) {
    if (re.test(text)) {
      return { match: true, kind: 'token', pattern };
    }
  }

  // 3. High-entropy run (last resort) — SKIPPED for prose files (follow-up #10).
  //    Prose legitimately carries high-entropy runs (URLs, base64 examples,
  //    embedded hashes); only PEM/token shapes above are reliable in prose.
  if (skipEntropy) {
    return { match: false };
  }
  const run = findHighEntropyRun(text);
  if (run !== null) {
    return { match: true, kind: 'entropy', pattern: `entropy:${run.slice(0, 8)}…` };
  }

  return { match: false };
}

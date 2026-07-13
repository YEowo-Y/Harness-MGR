/** Test-only capability probe for the POSIX wrapper parity suite. */

import { spawnSync } from 'node:child_process';

export const POSIX_CAPABILITY_COMMAND = `node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" && pwd -P`;

/**
 * Select the first shell that can execute the supported Node major and report
 * the injected cwd in shell-native form. The product wrapper is not probed here.
 * Never throws; a launcher alone is not sufficient capability.
 * @param {object} [options]
 * @returns {{shell:string,root:string}|null}
 */
export function resolvePosixRuntime(options = {}) {
  if (options === null || typeof options !== 'object') return null;
  const {
    candidates = ['sh', 'bash'],
    spawnFn = spawnSync,
    cwd,
  } = options;
  if (!Array.isArray(candidates) || typeof spawnFn !== 'function'
    || typeof cwd !== 'string' || cwd.length === 0) return null;
  for (const shell of candidates) {
    if (typeof shell !== 'string' || shell.length === 0) continue;
    try {
      const probe = spawnFn(shell, ['-c', POSIX_CAPABILITY_COMMAND], { cwd, encoding: 'utf8' });
      if (probe?.error || probe?.status !== 0 || typeof probe.stdout !== 'string') continue;
      const root = probe.stdout.replace(/\r/g, '').trim();
      if (!root.startsWith('/') || root.includes('\n') || root.includes('\0')) continue;
      return { shell, root };
    } catch {
      // Try the next candidate; capability discovery must never fail the suite.
    }
  }
  return null;
}

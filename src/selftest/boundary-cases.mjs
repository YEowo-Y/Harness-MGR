/**
 * boundary-cases.mjs — write-allowlist test matrix for selftest/boundary.mjs.
 *
 * Extracted from boundary.mjs (P4a.U1a) to keep that module under the 200-SLOC
 * ceiling after the 'remove' context cases were added.
 *
 * Zero npm dependencies.  node:path only.
 */

import { join, dirname } from 'node:path';

/**
 * Build the representative allowlist test matrix from validated root paths.
 * @param {string} targetClaudeDir
 * @param {string} mgrStateDir
 * @returns {Array<{label:string, target:string, context:string, expectAllow:boolean, expectedCode?:string}>}
 */
export function buildAllowlistCases(targetClaudeDir, mgrStateDir) {
  return [
    { label: 'mgrStateDir/snapshots/x.json apply -> ALLOW',
      target: join(mgrStateDir, 'snapshots', 'x.json'), context: 'apply', expectAllow: true },
    { label: 'mgrStateDir/lockfile.json apply -> ALLOW (U9 drift lockfile)',
      target: join(mgrStateDir, 'lockfile.json'), context: 'apply', expectAllow: true },
    { label: 'parent-of-targetClaudeDir/some-outside-file apply -> THROW write-outside-target',
      target: join(dirname(targetClaudeDir), 'some-outside-file'), context: 'apply',
      expectAllow: false, expectedCode: 'write-outside-target' },
    { label: 'targetClaudeDir/CLAUDE.md apply -> THROW write-rollback-only',
      target: join(targetClaudeDir, 'CLAUDE.md'), context: 'apply',
      expectAllow: false, expectedCode: 'write-rollback-only' },
    { label: 'targetClaudeDir/CLAUDE.md rollback -> ALLOW',
      target: join(targetClaudeDir, 'CLAUDE.md'), context: 'rollback', expectAllow: true },
    { label: 'targetClaudeDir/plugins/marketplaces/m apply -> THROW write-forbidden',
      target: join(targetClaudeDir, 'plugins', 'marketplaces', 'm'), context: 'apply',
      expectAllow: false, expectedCode: 'write-forbidden' },
    { label: 'targetClaudeDir/agents/__mgr-probe-x.md probe -> ALLOW',
      target: join(targetClaudeDir, 'agents', '__mgr-probe-0000.md'), context: 'probe', expectAllow: true },
    { label: 'targetClaudeDir/agents/real-agent.md probe -> THROW write-probe-only',
      target: join(targetClaudeDir, 'agents', 'real-agent.md'), context: 'probe',
      expectAllow: false, expectedCode: 'write-probe-only' },
    { label: 'targetClaudeDir/agents/__mgr-probe-x.md apply -> THROW write-rollback-only',
      target: join(targetClaudeDir, 'agents', '__mgr-probe-0000.md'), context: 'apply',
      expectAllow: false, expectedCode: 'write-rollback-only' },
    { label: 'targetClaudeDir/plugins/marketplaces/m rollback -> THROW write-forbidden',
      target: join(targetClaudeDir, 'plugins', 'marketplaces', 'm'), context: 'rollback',
      expectAllow: false, expectedCode: 'write-forbidden' },
    { label: 'targetClaudeDir/projects/p rollback -> THROW write-forbidden',
      target: join(targetClaudeDir, 'projects', 'p'), context: 'rollback',
      expectAllow: false, expectedCode: 'write-forbidden' },
    { label: 'targetClaudeDir/commands/greet.md rollback -> ALLOW',
      target: join(targetClaudeDir, 'commands', 'greet.md'), context: 'rollback', expectAllow: true },
    { label: 'targetClaudeDir/hooks/pre.mjs rollback -> ALLOW',
      target: join(targetClaudeDir, 'hooks', 'pre.mjs'), context: 'rollback', expectAllow: true },
    // Always-writable governed settings files (plan line 432) — apply + rollback.
    { label: 'targetClaudeDir/settings.json apply -> ALLOW',
      target: join(targetClaudeDir, 'settings.json'), context: 'apply', expectAllow: true },
    { label: 'targetClaudeDir/settings.local.json apply -> ALLOW',
      target: join(targetClaudeDir, 'settings.local.json'), context: 'apply', expectAllow: true },
    { label: 'targetClaudeDir/.mcp.json apply -> ALLOW',
      target: join(targetClaudeDir, '.mcp.json'), context: 'apply', expectAllow: true },
    { label: 'targetClaudeDir/settings.json rollback -> ALLOW',
      target: join(targetClaudeDir, 'settings.json'), context: 'rollback', expectAllow: true },
    { label: 'near-miss targetClaudeDir/settings.jsonx apply -> THROW write-not-allowed',
      target: join(targetClaudeDir, 'settings.jsonx'), context: 'apply',
      expectAllow: false, expectedCode: 'write-not-allowed' },
    { label: 'near-miss nested targetClaudeDir/sub/settings.json apply -> THROW write-not-allowed',
      target: join(targetClaudeDir, 'sub', 'settings.json'), context: 'apply',
      expectAllow: false, expectedCode: 'write-not-allowed' },
    // 'remove' context (P4a.U1a) — single-file component delete surface.
    { label: 'targetClaudeDir/agents/foo.md remove -> ALLOW',
      target: join(targetClaudeDir, 'agents', 'foo.md'), context: 'remove', expectAllow: true },
    { label: 'targetClaudeDir/commands/bar.md remove -> ALLOW',
      target: join(targetClaudeDir, 'commands', 'bar.md'), context: 'remove', expectAllow: true },
    { label: 'targetClaudeDir/agents/foo.txt remove -> THROW write-remove-only (not .md)',
      target: join(targetClaudeDir, 'agents', 'foo.txt'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/agents/sub/foo.md remove -> THROW write-remove-only (nested)',
      target: join(targetClaudeDir, 'agents', 'sub', 'foo.md'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/agents/__mgr-probe-0000.md remove -> THROW write-remove-only (probe name)',
      target: join(targetClaudeDir, 'agents', '__mgr-probe-0000.md'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/CLAUDE.md remove -> THROW write-remove-only (not in agents/commands)',
      target: join(targetClaudeDir, 'CLAUDE.md'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/settings.json remove -> THROW write-remove-only (not in agents/commands)',
      target: join(targetClaudeDir, 'settings.json'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/skills/s/SKILL.md remove -> THROW write-remove-only (skills are dirs, 4b)',
      target: join(targetClaudeDir, 'skills', 's', 'SKILL.md'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/plugins/marketplaces/m/agents/x.md remove -> THROW write-forbidden (forbidden wins)',
      target: join(targetClaudeDir, 'plugins', 'marketplaces', 'm', 'agents', 'x.md'), context: 'remove',
      expectAllow: false, expectedCode: 'write-forbidden' },
    { label: 'targetClaudeDir/agents/foo.md apply -> THROW write-rollback-only (remove did NOT widen apply)',
      target: join(targetClaudeDir, 'agents', 'foo.md'), context: 'apply',
      expectAllow: false, expectedCode: 'write-rollback-only' },
    // 'remove-skill' context (P4b) — single skill-DIRECTORY delete surface.
    ...buildRemoveSkillCases(targetClaudeDir),
  ];
}

/**
 * 'remove-skill' context cases (P4b) — extracted to keep buildAllowlistCases
 * under the 80-SLOC function ceiling.
 * @param {string} targetClaudeDir
 * @returns {Array<{label:string, target:string, context:string, expectAllow:boolean, expectedCode?:string}>}
 */
function buildRemoveSkillCases(targetClaudeDir) {
  return [
    { label: 'targetClaudeDir/skills/foo remove-skill -> ALLOW',
      target: join(targetClaudeDir, 'skills', 'foo'), context: 'remove-skill', expectAllow: true },
    { label: 'targetClaudeDir/skills/foo apply -> THROW write-rollback-only (remove-skill did NOT widen apply)',
      target: join(targetClaudeDir, 'skills', 'foo'), context: 'apply',
      expectAllow: false, expectedCode: 'write-rollback-only' },
    { label: 'targetClaudeDir/skills/foo remove -> THROW write-remove-only (leaf .md remove does NOT cover skill dir)',
      target: join(targetClaudeDir, 'skills', 'foo'), context: 'remove',
      expectAllow: false, expectedCode: 'write-remove-only' },
    { label: 'targetClaudeDir/skills/sub/foo remove-skill -> THROW write-remove-skill-only (nested)',
      target: join(targetClaudeDir, 'skills', 'sub', 'foo'), context: 'remove-skill',
      expectAllow: false, expectedCode: 'write-remove-skill-only' },
    { label: 'targetClaudeDir/skills/foo.mgr-old remove-skill -> THROW write-remove-skill-only (sidecar excluded)',
      target: join(targetClaudeDir, 'skills', 'foo.mgr-old'), context: 'remove-skill',
      expectAllow: false, expectedCode: 'write-remove-skill-only' },
    { label: 'targetClaudeDir/agents/foo remove-skill -> THROW write-remove-skill-only (not under skills/)',
      target: join(targetClaudeDir, 'agents', 'foo'), context: 'remove-skill',
      expectAllow: false, expectedCode: 'write-remove-skill-only' },
    { label: 'targetClaudeDir/CLAUDE.md remove-skill -> THROW write-remove-skill-only',
      target: join(targetClaudeDir, 'CLAUDE.md'), context: 'remove-skill',
      expectAllow: false, expectedCode: 'write-remove-skill-only' },
    { label: 'targetClaudeDir/plugins/marketplaces/m/skills/x remove-skill -> THROW write-forbidden (forbidden wins)',
      target: join(targetClaudeDir, 'plugins', 'marketplaces', 'm', 'skills', 'x'), context: 'remove-skill',
      expectAllow: false, expectedCode: 'write-forbidden' },
  ];
}

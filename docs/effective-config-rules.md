# Effective settings — per-key merge rules

How `harness-mgr` computes the **effective** view of Claude Code settings when the
same key is set in more than one layer. These rules mirror Claude Code's own
`settingsMergeCustomizer` as reverse-engineered from the deobfuscated **CC 2.1.x**
source (`ghboke/claude-code-reverse`, corroborated). They are **version-pinned to
the 2.1.x line**; re-verify per Claude Code release.

This file is the contract for [`src/analysis/settings-merge.mjs`](../src/analysis/settings-merge.mjs)
and seeds `config show-effective`. Any key NOT documented here is reported with
`mergeConfidence: "unknown"` — the tool shows the raw per-layer values and does
**not** fabricate an effective value.

## Layer precedence (highest wins)

Layers are merged lowest → highest; a higher layer overrides per the per-key rule.

1. **CLI arguments** (single session) — highest
2. **Project** `.claude/settings.local.json`
3. **Project** `.claude/settings.json`
4. **User** `~/.claude/settings.json`
5. **`managed-settings.json` / MDM / Registry** — reported, **not merged** (read-only floor)

Phase 1 governs the **user** level; project/local/CLI layers participate only when
the caller supplies them. The CLI boundary assembles the ordered layer
stack from the real settings files at runtime; `settings-merge.mjs` itself is a
pure function over that stack.

## Per-key rules

| Key | Strategy | Behavior |
|---|---|---|
| `permissions.allow` / `permissions.ask` / `permissions.deny` | **array union** | Concatenated across layers, de-duplicated, first-seen order preserved. (Not simple replacement — this is Claude Code's actual behavior.) |
| `permissions.*` (other subkeys, e.g. `defaultMode`) | highest-wins | The highest layer that sets the subkey wins. |
| `hooks.<event>` | **per-event array concat** | Each event's array is concatenated in layer order. *(Phase 2 refinement: the verified loader additionally de-dups by `hookDedupKey`; Phase 1 uses plain concat.)* |
| `enabledPlugins` | **object merge** | Shallow merge; a later (higher) layer overrides the same key. |
| `skillOverrides` | **object merge** | Shallow merge; a later (higher) layer overrides the same skill's visibility (modeled on `enabledPlugins`; not independently re-verified against Claude Code's `settingsMergeCustomizer`). |
| `env` | **object merge** | Shallow merge; later layer wins per key. |
| `model`, `outputStyle`, `cleanupPeriodDays`, `includeCoAuthoredBy` | **scalar, highest-wins** | The highest layer that defines the key wins (first-hit from the top). |
| *anything else* | **unknown** | `mergeConfidence: "unknown"`. Raw per-layer values are reported; no effective value is fabricated. |

## `mergeConfidence`

- `known` — the key has a documented rule above; `value` is the computed effective result.
- `unknown` — the key is not documented; `perLayer` lists each contributing layer's raw value, in layer order. This is deliberate: guessing a merge for an unrecognized key would be worse than admitting uncertainty.

As Claude Code adds settings keys, extend the table above (and `KNOWN_MERGE_RULES`
in `settings-merge.mjs`) rather than letting the tool silently guess.

## Source

Verified against `utils/settings/settings.ts:538-547,645-796` (ghboke/claude-code-reverse,
deobfuscated CC 2.1.88), corroborated by Windy3f3f3f3f & luyao618. Pinned to the
**2.1.x** minor line.

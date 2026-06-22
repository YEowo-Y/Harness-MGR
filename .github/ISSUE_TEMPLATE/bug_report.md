---
name: Bug report
about: Something behaved differently than documented
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear description of the bug.

**Command + flags**
The exact `claude-mgr` (or `node src/cli.mjs`) invocation, e.g. `inventory --type skill --format json`.

**Expected vs actual**
What you expected, and what you got instead. Paste the relevant output (use `--format json` if it
helps). **Redact any secrets/tokens** before pasting.

**Environment**
- OS (Windows / macOS / Linux):
- Node version (`node --version`, must be >= 24):
- claude-mgr version / commit:
- Target (`claude` / `codex`):

**Was this a read or a write?**
Read commands are non-destructive. For write commands, note whether you used `--apply` and whether a
snapshot/rollback was involved.

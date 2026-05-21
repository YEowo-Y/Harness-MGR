---
name: long-name-skill
description: Skill whose directory name is 60 characters long. Combined with
  a deep fixture path this approaches Windows MAX_PATH (260 chars). Exercises
  path.toNamespacedPath() and extended-length path handling in win-paths.mjs.
---

# long-name-skill

Fixture for long-path handling. Discovery must use extended-length path prefixes
(\\?\) on Windows when the full path exceeds MAX_PATH.

---
name: MySkill
description: Skill with mixed-case directory name. On Windows (case-insensitive
  NTFS) MySkill and myskill refer to the same path. Discovery must normalize
  component names consistently and not double-count on case-insensitive volumes.
---

# MySkill

Fixture for case-insensitive path handling. The loader uses the directory name
as the component key; this fixture verifies no double-counting or missed lookup
when keys differ only by case.

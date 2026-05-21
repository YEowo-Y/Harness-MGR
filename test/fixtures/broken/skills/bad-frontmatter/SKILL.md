---
name: [unclosed bracket
description: This SKILL.md has malformed YAML frontmatter — the name value is
  an unclosed YAML flow-sequence, which a strict parser must reject with a
  Diagnostic rather than throw.
---

# bad-frontmatter

Fixture for broken-frontmatter handling. Discovery must emit a Diagnostic and
continue scanning other components, never throw.

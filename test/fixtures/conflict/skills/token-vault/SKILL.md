---
name: token-vault
description: Legitimate skill whose name contains "token". Proves that secrets
  detection must use content-sniff + extension, NOT name patterns — a skill
  named token-vault is NOT a credential leak.
---

# token-vault

Manages auth tokens securely. This fixture guards against false-positive secret
detection triggered by the word "token" in a skill name.

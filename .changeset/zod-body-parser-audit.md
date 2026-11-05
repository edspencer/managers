---
"@managers/server": patch
---

Dependency security updates: `zod` goes to ^4.6.6 (GHSA-mrhx-c7xc-m3w5, memory exhaustion when validating oversized constrained collections; every state write is validated by a strict zod schema) and `body-parser` to 2.4.0 (GHSA-27r3-jxmh-p828, via the MCP SDK's express).

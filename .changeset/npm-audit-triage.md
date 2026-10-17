---
"@managers/server": patch
"@managers/web": patch
---

Triage the npm audit advisories inherited from Paddock: production dependencies go from 30 vulnerable packages (1 critical, 17 high) to 13 (0 critical, 8 high), the whole tree including dev tooling from 58 (4 critical, 34 high) to 37 (3 critical, all dev-only test tooling), and every open advisory is documented in `docs/security/npm-audit.md`. `proxy-addr` 2.0.8 stops an IPv4-mapped `managementApi.trustedProxies` entry such as `::ffff:10.0.0.0/8` from trusting every IPv4 peer, and links in rendered Markdown that resolve off-origin (`/\host`) are no longer navigated in-app. CI now fails on any undocumented high or critical advisory.

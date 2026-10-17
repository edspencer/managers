---
"@managers/server": patch
"@managers/web": patch
---

Triage the npm audit advisories inherited from Paddock: 30 vulnerable packages (1 critical, 17 high) down to 13 (0 critical, 8 high), with every open one documented as unreachable in `docs/security/npm-audit.md`. `proxy-addr` 2.0.8 stops an IPv4-mapped `managementApi.trustedProxies` entry such as `::ffff:10.0.0.0/8` from trusting every IPv4 peer, and links in rendered Markdown that resolve off-origin (`/\host`) are no longer navigated in-app. CI now fails on any undocumented high or critical advisory.

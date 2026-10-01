---
"@managers/server": minor
"@managers/web": minor
---

First published release of Managers: scheduled, per-project manager agents that track long-running objectives (milestones M1–M15, forked from Paddock 0.74.1). Ships as a multi-arch Docker image (`ghcr.io/edspencer/managers`), an npm package (`npx @edspencer/managers`, with provenance) and a release tarball.

The `managers` command now starts with authentication off when, and only when, it binds a loopback address and nothing set `MANAGERS_AUTH_MODE` or `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH`. The no-auth security banner still shows. Any other bind, the Docker image and `node packages/server/dist/index.js` still refuse to start without auth unless the opt-in is set.

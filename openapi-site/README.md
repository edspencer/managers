# Managers HTTP API — static reference

A self-contained, **read-only** API reference for this repo's server:
Swagger UI (`index.html`) rendering `open-api.json`. It is **not connected to a
live server** — "Try it out" is disabled.

Managers does not publish it anywhere; it is the checked-in spec. `index.html`
loads it from **`/api/open-api.json`**, so serving this directory at a root other
than `/api/` needs that `url:` adjusted.

## Files

- `index.html` — branded Swagger UI (loads swagger-ui-dist from a CDN, reads `./open-api.json`).
- `open-api.json` — the OpenAPI 3.0 spec, **generated from the server's route schemas**.
- `icon-192.png` — the Paddock logo used in the header.

## Regenerate the spec

The spec is derived from the live route schemas, so regenerate it after any route
change (and on each release):

```bash
npm run build:server              # compile the server (dist/)
node scripts/dump-openapi.mjs     # writes openapi-site/open-api.json
```

The dump boots the app in-process against a throwaway temp dir (no port, no real
data) and reads `app.swagger()`. It pins `MANAGERS_AUTH_MODE=jwt` (with an issuer and audience) so the published
reference advertises the bearer Authorize flow (the security schemes are
mode-aware; see `packages/server/src/openapi.ts`).

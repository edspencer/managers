#!/usr/bin/env node
/**
 * Emit a static OpenAPI spec from the route schemas — the input for the public
 * API reference (e.g. the Cloudflare-hosted paddock-api site).
 *
 * Boots the REAL app in-process (buildApp) against a throwaway temp data dir —
 * no port is bound, no real project data is touched — then reads the live
 * `app.swagger()` document. Runs in CI with just the built server present
 * (`npm run build:server`).
 *
 * Auth mode defaults to `jwt` so the published reference advertises the bearer
 * Authorize flow (the security schemes are mode-aware — see openapi.ts).
 *
 * Usage:  node scripts/dump-openapi.mjs [outfile]
 *   default outfile: openapi-site/open-api.json
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "paddock-openapi-"));

// Isolate from any ambient MANAGERS_* config (dev-box env leak): pin every path
// at a throwaway temp dir and pick a representative, boot-safe auth mode.
process.env.MANAGERS_DATA_DIR = tmp;
process.env.MANAGERS_PROJECTS_DIR = path.join(tmp, "projects");
process.env.MANAGERS_STATE_DIR = path.join(tmp, "state");
process.env.MANAGERS_HERDCTL_CONFIG = path.join(tmp, "herdctl.yaml");
mkdirSync(process.env.MANAGERS_PROJECTS_DIR, { recursive: true });
// jwt mode → the reference shows the bearer Authorize scheme. The JWKS URL is a
// placeholder: `createRemoteJWKSet` only validates it is a URL at boot (it is
// fetched lazily on verify, which never happens here).
process.env.MANAGERS_AUTH_MODE = "jwt";
process.env.MANAGERS_AUTH_JWT_HEADER = "Authorization"; // canonical → bearer scheme
process.env.MANAGERS_AUTH_JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
process.env.MANAGERS_OPENAPI_ENABLED = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.MANAGERS_WEB_DIST;

const { buildApp } = await import(path.join(root, "packages/server/dist/app.js"));
const out = process.argv[2] ?? path.join(root, "openapi-site", "open-api.json");
mkdirSync(path.dirname(out), { recursive: true });

const built = await buildApp({ serveStatic: false });
await built.app.ready();
const spec = built.app.swagger();
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
await built.close();
console.error(
  `wrote ${out} — ${Object.keys(spec.paths ?? {}).length} paths, openapi ${spec.openapi}, ` +
    `security: ${JSON.stringify(spec.security ?? [])}`,
);
process.exit(0);

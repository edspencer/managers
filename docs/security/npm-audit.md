# npm audit triage

What `npm audit` reports against this repo, what was done about each advisory,
and why the ones still open are safe to leave. CI enforces it:
`npm run audit:check` ([`scripts/npm-audit-check.mjs`](../../scripts/npm-audit-check.mjs))
fails on any **high or critical** advisory whose GHSA id is not in
[`npm-audit-exceptions.json`](npm-audit-exceptions.json). Moderate and low
advisories are documented here but never gate CI.

**When CI goes red on a new advisory,** fix it (a direct bump, or an `overrides`
entry in the root `package.json` for a transitive one), or triage it: add the id
to the exceptions file AND a row to the table below, with the reason it cannot
be reached. An exception the check reports as unmatched should be removed from
both.

Last triaged: 2026-10-17 (task t-260930-a6xx).

| | Vulnerable packages | Critical | High | Moderate | Low | Distinct advisories |
|---|---|---|---|---|---|---|
| Before (inherited from Paddock v0.74.1) | 30 | 1 | 17 | 11 | 1 | 72 |
| After | 13 | 0 | 8 | 3 | 2 | 16 |

## What was fixed

All within the existing major versions; no application code changed except the
two hardenings marked with a test.

| Change | Advisories closed |
|---|---|
| `proxy-addr` ^2.0.7 → ^2.0.8 | **critical** GHSA-jqcg-44mw-7w3h. Reachable: `managementApi.trustedProxies` is compiled with proxy-addr, and an entry like `::ffff:10.0.0.0/8` trusted every IPv4 peer's `X-Forwarded-Proto` on `/mcp`. Pinned by a test in `trusted-proxy.test.ts`. |
| `yaml` 2.5.1 → 2.9.1 | GHSA-48c2-rrv3-qjmp (stack overflow on deeply nested YAML; `project.yaml` and frontmatter are parsed with it) |
| `react-router-dom` 6.26.2 → 6.30.6 | GHSA-2w69-qvjg-hvjx, GHSA-2j2x-hqr9-3h42, GHSA-9jcx-v3wj-wh4m |
| `mermaid` ^11.15.0 → ^11.17.2 | GHSA-c4c3-pg64-4m4v, GHSA-6x64-9x62-f2gx (agent-written diagrams are rendered) |
| `overrides: dockerode → uuid ^11.1.1` | GHSA-w5hq-g745-h8pq (and with it the dockerode / `@herdctl/core` / `@herdctl/chat` entries, which only carried it) |
| `npm audit fix` (lockfile only) | `@fastify/busboy`, `@grpc/grpc-js`, `@hono/node-server`, `hono`, `@modelcontextprotocol/sdk`, `brace-expansion`, `dompurify`, `fast-uri` (both lines), `ip-address`, `qs` |

## Still open

None of these is reachable as Managers is built and configured. "Fastify 5"
means the fix exists only in fastify 5.x (or a plugin release that requires it);
fastify 4 is end-of-life and gets no backports. That migration (fastify 5,
`@fastify/static` 8+, `@fastify/websocket` 11, `@fastify/multipart` 9,
`@fastify/swagger` 9, `@fastify/swagger-ui` 5+) is a real code change and is
left as a follow-up; it would close every fastify row below.

| Advisory | Package | Severity | Decision | Reason |
|---|---|---|---|---|
| [GHSA-667r-xxjv-c9mm](https://github.com/advisories/GHSA-667r-xxjv-c9mm) | fastify 4.28.1 | high | Accept (fastify 5) | Needs a JSON Schema `$async` validator; no route has one. |
| [GHSA-9q9j-q6p8-xq58](https://github.com/advisories/GHSA-9q9j-q6p8-xq58) | fastify 4.28.1 | high | Accept (fastify 5) | Needs a route `headers` schema using `dependencies` or nested names; no route declares a headers schema. |
| [GHSA-hwr6-493r-vm6h](https://github.com/advisories/GHSA-hwr6-493r-vm6h) | fastify 4.28.1 | high | Accept (fastify 5) | Needs a part schema of boolean `false`; none exists. |
| [GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq) | fastify 4.28.1 | high | Accept (fastify 5) | Needs body schemas keyed by Content-Type (`body.content`); none exist. Every state write is re-validated by the strict zod `*WriteSchema` in `state-writes.ts` regardless. |
| [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7) | fastify 4.28.1 | high | Accept (fastify 5) | Needs encapsulated `setNotFoundHandler`s with their own `preHandler`. There is one root not-found handler (SPA shell / 404) and auth is a global `onRequest` hook, so no guard can be skipped. |
| [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) | find-my-way 8.2.2 | high | Accept (fastify 5) | HTTP/2 only; the server never sets `http2`. |
| [GHSA-83w8-p2f5-377r](https://github.com/advisories/GHSA-83w8-p2f5-377r) | @fastify/static 7.0.4 | high | Accept (fastify 5) | A bypass of route guards in front of static files. Nothing guards a static route specifically (auth is global), it is registered with `wildcard: false`, and it serves only the compiled web bundle, which holds no secrets (`/assets/` is already auth-exempt). |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | braces 3.0.3 (via micromatch, fast-glob, shelljs, nodejs-whisper) | high | Accept (no fix) | No fixed braces release exists. The chain is the OPTIONAL `nodejs-whisper` dependency, used only when dictation is set to `local` (default `off`), and the paths it handles are server-built (`mkdtemp` dir + `audio.wav`), never user text. Also flags micromatch, fast-glob, shelljs and nodejs-whisper themselves, which carry only this advisory. |
| [GHSA-w2qp-rph6-63g4](https://github.com/advisories/GHSA-w2qp-rph6-63g4) | fastify 4.28.1 | moderate | Accept (fastify 5) | Needs a root-level primitive body schema on a Fastify route; the only ones are MCP tool input schemas, which Fastify never compiles. |
| [GHSA-444r-cwp2-x5xf](https://github.com/advisories/GHSA-444r-cwp2-x5xf) | fastify 4.28.1 | moderate | Accept (fastify 5) | Needs `trustProxy` set; it never is. The `/mcp` guard reads the socket, not `req.protocol` (`routes/mcp.ts`). |
| [GHSA-4mh8-r7rc-xpvc](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc) | fastify 4.28.1 | moderate | Accept (fastify 5) | HTTP/2 plus `reply.trailer()`; neither is used. |
| [GHSA-8pvw-jcv7-9cmj](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj) | @fastify/static 7.0.4 (also via @fastify/swagger-ui) | moderate | Accept (fastify 5) | Bypasses the `allowedPath` option, which is never set. swagger-ui only exists when `MANAGERS_OPENAPI_ENABLED=1`, and serves public UI assets. |
| [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) | react-router 6.30.6 | moderate | Mitigated in app code (fix is react-router 7) | The one path where untrusted text reaches `navigate()` is `useInternalLinks` (links in agent-written Markdown). It now resolves the href against the page and navigates in-app only when the result is same-origin, so `/\host` is never handed to the router. Pinned by `shared.test.tsx`. Every other `navigate`/`<Link>` target comes from the app's URL helpers (`tasksUrl`, `objectivesUrl`, …), which always start with a fixed path prefix. |
| [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) | react-router 6.30.6 | moderate | Accept (react-router 7) | Server-side-render hydration only (`deserializeErrors`). The SPA uses `createBrowserRouter` with no SSR and no `hydrationData`. |
| [GHSA-mrq3-vjjr-p77c](https://github.com/advisories/GHSA-mrq3-vjjr-p77c) | fastify 4.28.1 | low | Accept (fastify 5) | Needs `reply.send()` of a Web `ReadableStream`/`Response`; none does. |
| [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) | katex 0.16.47 (via mermaid) | low | Accept (mermaid 12) | Needs an existing prototype pollution to exploit; mermaid's own (GHSA-c4c3-pg64-4m4v) is fixed above. mermaid 11 requires katex ^0.16; the fixed 0.18 line comes with mermaid 12, a major. |

npm's "vulnerable packages" count (13) is larger than the number of distinct
problems: `@fastify/swagger-ui`, `mermaid`, `react-router-dom`, `micromatch`,
`fast-glob`, `shelljs` and `nodejs-whisper` are listed only because they depend
on a package above.

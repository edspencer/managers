# Managers

**Managers** is a fork of [Paddock](https://github.com/edspencer/paddock) (forked
at v0.74.1) that turns it into a set of scheduled, per-project **manager agents**
which track Ed's long-running objectives. The plan lives outside this repo, in the
Managers notes project (`IMPLEMENTATION-PLAN.md`); this file covers how to work in
the code.

What changed from Paddock, and what did not:

- **Everything user- or environment-facing is renamed.** The env prefix is
  `MANAGERS_*` (never `PADDOCK_*`), the CLI is `managers`, the default data dir is
  `~/.managers`, the config file is `managers.config.yaml`, the default port is
  **7234** (so it runs beside Paddock's 7233), the in-project config dir is
  `.managers/`, and the in-process MCP servers are `managers` (self-management +
  state tools) and `managers_files` (send_file). The name `paddock` is left free on
  purpose: it becomes a per-project MCP *connection* to Ed's real Paddock.
- **Boot isolation.** `start.ts` calls `env-scrub.ts` first, which deletes every
  inherited `PADDOCK_*` variable from `process.env` (logging the count only), so
  none reaches a keeper, sweeper or trigger child. `test/unit/no-paddock-env.test.ts`
  fails the build if any `packages/*/src` file spells `PADDOCK_` outside that file.
- **Data-dir guard** (`data-dir-guard.ts`, applied in `loadPaddockConfig`): a
  projects root that already holds `*/project.yaml` but no `.managers-data` marker
  is **refused** unless `MANAGERS_ADOPT_DATA_DIR=1`. A fresh root is claimed (the
  marker is written). This is what stops a rig from ever touching real data.
- **Runtime posture (M3, `managers/claude-overlay.ts`).** Transcripts never
  expire and there is no Claude Code auto-memory:
  - `<claudeHome>/settings.json` is ALWAYS a file Managers generated (never a
    symlink, never absent): the host's settings (hooks filtered per `claude.hooks`)
    or nothing, plus the overlay `{cleanupPeriodDays: 36500, autoMemoryEnabled:
    false, autoDreamEnabled: false}`. Never use `cleanupPeriodDays: 0` — it is a
    Claude Code validation error.
  - Every agent (keeper, trigger, sweeper) declares `setting_sources:
    ["user","project"]`, so that file loads on the CLI runtime (`--setting-sources`)
    and on the SDK runtime, batch and `openChatSession` alike (herdctl
    `toSDKOptions`). Pinned by `test/integration/retention-settings.test.ts`.
  - `start.ts` sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; boot warns about any
    project `.claude/settings.json` with a lower `cleanupPeriodDays` (project beats
    user, and the cleanup is global over the Claude home).
  - `claude.transcripts: host` is a config ERROR, and the own→host transcript
    migration (#882) routes refuse (`not_supported`).
  - The sweeper curates OVERVIEW.md/CHANGELOG.md only — never CLAUDE.md.
  - Projects are notebooks: the New Project modal has no clone/directory option
    (the server still accepts `repo`/`path`); a GitHub repo is stored as a link.
    Discover lost its sidebar button and the empty-Home takeover; `/discover` and
    its footer link remain.
- **Kept as internal names:** TS identifiers (`PaddockConfig`, `loadPaddockConfig`,
  `PaddockTrigger`, …), file names (`self-mcp*.ts`, `PaddockManageBlock.tsx`),
  herdctl agent names (`keeper-<slug>`, …), the localStorage `paddock:*` keys and
  the CSS palette names. `website/` and `docs/` are **frozen upstream Paddock
  reference** — not maintained, and their env names are Paddock's.

Everything below this point is inherited from Paddock and still accurate for the
code, with the renames above applied; where it says "Paddock", read "Managers".

## Monorepo layout

Two `private` packages, versioned and released **together** (one number = "the
Paddock version"). Neither is published under its own name — releases synthesize
a single public **`@edspencer/paddock`** package from their built output
(`scripts/make-npm-package.mjs`), so the workspace manifests stay `private`:

- **`packages/server`** (`@managers/server`) — **Fastify 4 + `@fastify/websocket`**
  backend. Wraps herdctl's `FleetManager`, the Project layer, sidecar stores, the
  `/ws` streaming transport, in-process MCP tools, and the auth boundary; serves
  the built SPA in production. Entry: `index.ts` (lifecycle only) → `app.ts`
  `buildApp()` (all DI/wiring).
- **`packages/web`** (`@managers/web`) — **React + Vite + Tailwind** SPA (Chat /
  Files / Changes / Settings), a PWA with a versioned service worker.

## Architecture pointers

Read [`website/src/content/docs/architecture/overview.md`](website/src/content/docs/architecture/overview.md)
for depth (every claim there is cited to `packages/server/src`, by file + symbol,
never by line number). The essentials:

- **Three storage classes** (ARCHITECTURE §3) — keep them straight: (1) **transcript
  JSONL** written by Claude Code, Paddock reads/renders only
  (`<dataDir>/claude-home/projects/<enc-cwd>` symlinked to `<project>/.chats/`, or out at
  the user's own folder under `claude.transcripts: host`); (2) **browser localStorage** `paddock:*` client
  prefs (drafts, model, heights); (3) **server JSON sidecars** for durable app state
  (`ArchiveStore`, `ReadStateStore`, `QueuedMessageStore`, sweep watermark) — all
  write-through, corruption-tolerant, follow one shared pattern.
- **WS / session-hub flow** (§4) — all live chat runs over `GET /ws`. `ws.ts` drives
  the turn lifecycle; `session-hub.ts` fans out, buffers, and replays frames so a
  turn's stream survives socket death and re-attaches.
- **MCP injection** (§5) — agents get extra tools via in-process MCP injection
  (`injectedMcpServers`), no network/auth: `send_file` on every turn, env-gated
  project-only self-management (`MANAGERS_SELF_MCP`). Automated/spawned turns get
  `send_file` only (anti-fork-bomb).
- **Auth boundary** (§7) — no native login; `auth.ts` `onRequest` hook turns
  upstream identity into `req.user` (`MANAGERS_AUTH_MODE`: `none` / `trusted-header`
  / `jwt`). See [`AUTH.md`](AUTH.md).
- **Sweeper + drive mode** (§6, §9) — post-turn tool-less `sweeper-<slug>` curates
  notes out of band (always a one-shot `trigger()`, so always the CLI runtime —
  it is the *only* unconditional CLI-runtime user). Chat turns run `batch`
  (one-shot `trigger()`, CLI runtime) or `session` (persistent `openChatSession`,
  which hard-codes the SDK runtime; background tasks / wake-ups survive the
  turn), per `MANAGERS_DRIVE_MODE` / `project.driveMode`. **Triggers resolve
  drive mode the same way chats do** (`resolveDriveMode` in `ws-triggers.ts`),
  so they are NOT unconditionally CLI-runtime either. `session` is the default,
  so **chats and triggers normally run on the SDK, not `claude -p`**.

Config resolves **env > YAML file > default** (`config.ts`; the file is
`<dataDir>/managers.config.yaml`) — see
[`environment.md`](website/src/content/docs/configuration/environment.md) for every
variable and [`config-file.md`](website/src/content/docs/configuration/config-file.md)
for the file. The `claude:` block there says what an instance shares with the host's
Claude Code (`transcripts`, `credentials`, `instructions`, `hooks`, `mcpServers` — each
`own|host`, #691); paddock ALWAYS owns its Claude home (`<dataDir>/claude-home`) and
refuses to start if it resolves to the user's `~/.claude`. `credentials` is the one key defaulting
to `host` — isolation is about writes, and reading a login writes nothing (see
`claude-credentials.ts`). `hooks` is the one about code execution: `own` means the
host's `settings.json` hooks do NOT run here, and because that file is a mixed bag it
is implemented by paddock WRITING a filtered `settings.json` into its own home rather
than by declining a symlink (`claude-settings.ts`). `mcpServers` is the odd one out: MCP
servers are declared in `~/.claude.json`, a SIBLING of the home rather than a file in it,
so no symlink bridge could reach them — `host` READS that file at boot and merges the
servers into each keeper's `mcp_servers` agent config, the one seam both runtimes read
(`claude-mcp.ts`). A **sibling** `mcpServers:` block declares servers to paddock itself
rather than borrowing the machine's (`mcp-servers.ts`); it wins a name clash with `host`,
is file-only, and takes `env:VAR_NAME` references anywhere a string goes so tokens stay
out of the git-tracked file. A host Claude Code **plugin** is the third contributor and
the one neither of those can see, because a plugin declares its servers inside itself
(#700): `claude-plugins.ts` enumerates the host's installed plugin directories from the
CLI's own `plugins/installed_plugins.json` and passes them as `agent.plugins`, gated by
`claude.instructions` (which is what bridges `plugins/`) with `claude.mcpServers`
deciding only whether the plugins' own servers come too, via `skipMcpDiscovery`. Three
rules that are load-bearing for anything touching MCP here: an attached server whose
`mcp__<name>__*` pattern is not added to the keeper's `allowed_tools` has every call
auto-denied with no prompt (a PLUGIN's server is registered as
`plugin:<plugin>:<server>`, so its pattern is `mcp__plugin_<plugin>_<server>__*` —
derived, not read); nothing may ever log or serialise a declared server's values
(`describeServer` is the only renderer); and under `driveMode: batch` the CLI runtime
puts the whole `mcp_servers` record in one `--mcp-config` argv element, so an `env`
value or an `Authorization` header is visible in `/proc/<pid>/cmdline` to the same user.

## UI conventions

**Read [`docs/DESIGN.md`](docs/DESIGN.md) before touching anything visual.** It is
the repo's only document about how Paddock *looks* (every other `DESIGN-*.md` is
architecture, and unlike the rest of `docs/` it is current, not the stale fork).
It covers the token architecture, the type/space/radius/elevation/motion scales,
the shared primitives, and — aimed squarely at a coding agent — a "Reject this"
section and a step-by-step "How to add a direction".

The five rules it exists to protect, all enforced by
`packages/web/src/styles/tokens.test.ts`, which fails the build:

- **Colour lives only in `packages/web/src/styles/tokens.css`**, as semantic
  tokens (`--surface-raised`, `--text-muted`, `--danger-soft`) declared twice —
  `:root` for light, `.dark` for dark, ramps derived **separately** in OKLCH.
- **Never a literal hex, `rgb()` or raw palette step in component code.** Write
  `text-fg-muted`, not `text-paddock-500` or `text-[#8f7c54]`. The one exception
  is `src/lib/brand.ts`.
- **Never a `dark:` variant for a colour** — the token swaps itself. Never an
  arbitrary `text-[Npx]` — use a rung (`text-3xs` … `text-3xl`). Never a bare
  `outline` focus ring (use `box-shadow`), never `transition-all`.
- **Reach for a primitive** from `packages/web/src/components/ui/` (`Button`,
  `Card`, `Section`, `EmptyState`, `Field`, `Input`, `Toggle`, `Chip`,
  `Callout`, `Dialog`, `Menu`) before hand-rolling markup. Structural changes go
  in the primitive, where one edit reaches every call site.
- **`--accent` / `--accent-600` / `--accent-700` are the branding seam** (#34):
  space-separated sRGB channels a running server overwrites for
  `MANAGERS_BRAND_ACCENT`. Keep that format and keep every other accent token
  derived from them.

Styling is **Tailwind v4** — configuration is CSS (`packages/web/src/index.css`),
there is no `tailwind.config.js` and no PostCSS config; do not reintroduce them.

## Dev conventions

Runbooks inherited from Paddock: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`DEV.md`](DEV.md)
(read `PADDOCK_` there as `MANAGERS_`). Node 22+.

- **Run everything through `scripts/clean-env.sh`.** It strips every inherited
  `PADDOCK_*`/`MANAGERS_*` var, `NODE_ENV`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR` before exec'ing the command. The dev
  box exports production Paddock's config and a real Claude credential into every
  shell; either one reaching a test false-fails it, and reaching a server can
  point it at production data or spend real API credit.

  ```bash
  NODE_ENV=development npm install --include=dev    # NODE_ENV=production prunes devDeps
  scripts/clean-env.sh npm run typecheck
  scripts/clean-env.sh npm run test -w packages/server
  scripts/clean-env.sh npm run test -w packages/web
  scripts/clean-env.sh npm run build
  scripts/clean-env.sh npm run test:e2e             # after a build; fake `claude` on PATH
  ```

  Use the package scripts, never ad-hoc `npx vitest` / `tsc -p`.
- **Never point a server, rig or test at real data or a real Claude home.** Isolate
  `HOME` and `CLAUDE_CONFIG_DIR`, and unset the Claude credentials so no real API
  call can happen. The data-dir guard is a backstop, not a licence.
- **QA rig.** The credential-free rig is `scripts/managers-rig/` (read its
  README): synthetic fixtures, run under `pm` as `managers-qa` via
  `/data/paddock-servers/managers-qa/run.sh`, re-seeded on every start, with
  `HOST=127.0.0.1` forced. The fake `claude`'s `[[MCP <server>.<tool> <json>]]`
  directive makes a turn really call an MCP tool, with no model involved.
  `scripts/managers-rig/leak-check.mjs` is the isolation proof that can actually
  fail. Add new fixtures to `fixtures.mjs` and never remove one. Screenshots and
  scratch go in `.playwright-mcp/` or `qa-scratch/` (both gitignored) and are
  never committed.
- **Commits.** Work on `main`, Conventional Commits (`type(scope): summary`), one
  lightweight tag `m<N>` per milestone. **There is no remote to push to — never
  push**, never force anything, and leave the `paddock` remote's config alone.
- **No changesets, no releases.** `.changeset/` and `release.yml` were removed;
  versions are `0.1.0`. `@herdctl/core` and `@herdctl/chat` are pinned to exact
  versions (the fork depends on herdctl internals; bump deliberately).
- After large edits run `npm run check:nul` — edits have been known to insert NUL
  bytes that typecheck and tests do not notice.
- UI work follows [`docs/DESIGN.md`](docs/DESIGN.md) and the primitives in
  `packages/web/src/components/ui/`; `packages/web/src/styles/tokens.test.ts` must
  stay green.

## Where to find things

**The documentation website is the source of truth**, and its content is plain
markdown checked into this repo under `website/src/content/docs/` — read those
files directly, no fetching. The handful of root files below (`AUTH.md`,
`CONTRIBUTING.md`, `DEV.md`, `DOCS-UPDATE-RUNBOOK.md`, `RELEASING.md`) are
contributor runbooks the website does not own, and stay canonical here.

**`docs/` is three different things** — see [`docs/README.md`](docs/README.md),
which is the index it lacked:

1. **Superseded forks** (`ARCHITECTURE.md`, `CONFIGURATION.md`, `API.md`,
   `INTEGRATION.md`, `TESTING.md`, `concepts/`) — each has a maintained website
   twin and now carries a banner naming it. Don't read them, and **fix the
   website copy** rather than the fork; patching one just makes it look
   maintained. They are kept only because inbound links still point at them.
2. **Originals with no twin** (`DESIGN-backing-store.md`, `DESIGN-testing.md`,
   `HISTORY.md`, `archive/CONTRACT-v{2,3}.md`) — the website links *out* to
   these by URL, so `docs/` is their **permanent** address. They are
   point-in-time records, not stale forks.
3. **Live assets** — `docs/demo/` is load-bearing (`scripts/demo-gif/make.mjs`
   hard-codes the path). `docs/screenshots/` is rendered by nothing, but
   `HISTORY.md` cites specific files in it as a milestone record.

So `docs/` as a whole is **not** deletable, and saying it was slated for deletion
without marking a single file in it is what let three of the forks drift into
advice that breaks a server (`CLAUDE_HOME=$HOME/.claude`, removed in #691).

| For… | Read |
|---|---|
| How the code fits together | [`website/src/content/docs/architecture/overview.md`](website/src/content/docs/architecture/overview.md) |
| What a project/agent/chat/sweeper *is* | [`website/src/content/docs/concepts/`](website/src/content/docs/concepts/) |
| Running the full stack locally | [`DEV.md`](DEV.md) |
| Contributing, tests, gotchas | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Every `MANAGERS_*` env var | [`website/src/content/docs/configuration/environment.md`](website/src/content/docs/configuration/environment.md) |
| REST endpoints | [`openapi-site/open-api.json`](openapi-site/open-api.json) — the OpenAPI 3 spec, generated from the Fastify route schemas (published at `/api/`; live on an instance at `/open-api` when `MANAGERS_OPENAPI_ENABLED=1`) |
| WebSocket (`/ws`) frame contract | [`website/src/content/docs/reference/websocket.md`](website/src/content/docs/reference/websocket.md) — hand-maintained; OpenAPI cannot describe it |
| Test strategy & layers | [`website/src/content/docs/contributing/testing.md`](website/src/content/docs/contributing/testing.md) |
| Auth modes & secrets | [`AUTH.md`](AUTH.md) |
| Release pipeline | [`RELEASING.md`](RELEASING.md) |
| herdctl API contract Paddock depends on | [`website/src/content/docs/architecture/herdctl-integration.md`](website/src/content/docs/architecture/herdctl-integration.md) |
| Regenerating the README/docs demo reel | [`scripts/demo-gif/README.md`](scripts/demo-gif/README.md) |

**The demo reel is generated, not hand-made.** `docs/demo/paddock-demo.gif` (and
its copy under `website/public/demo/`) comes out of `npm run demo:gif` — a
committed seed/shoot/build pipeline that stages a synthetic instance, drives it,
and photographs it. Never edit or hand-replace those files; change
`scripts/demo-gif/beats.mjs` (the storyboard) or `fixtures.mjs` (the content) and
re-run. It went 26 minor versions stale once because the original was ad-hoc and
undiscoverable — worth refreshing whenever a release changes what the UI looks
like.

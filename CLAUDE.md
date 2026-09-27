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
  NON-EMPTY projects root without a `.managers-data` marker is **refused** unless
  `MANAGERS_ADOPT_DATA_DIR=1` (since M9.5; before, only one holding
  `*/project.yaml`). Only an absent or empty root is claimed (the marker is written). This is what stops a rig from ever touching real data.
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
- **Domain store (M4, `managers/`).** Managers' own state is plain files in the
  data repo, per workspace (the root is Home): `objectives/<id>/{objective.md,
  journal/YYYY-MM.md}`, `log/YYYY-MM.md`, `tasks/{open,done/YYYY-MM}/<id>.md`,
  `memory/{MEMORY.md,facts/,playbooks/}` (the ROOT's is shared with every project,
  tagged `scope: root`), `runs/YYYY-MM/<id>.yaml`, `reports/<type>/{current,
  YYYY-MM-DD}.md`. `layout.ts` owns every path and id grammar; `schemas.ts` has a
  lenient read and a strict write zod schema per record; the stores re-parse a file
  only when its mtime/ctime/size moved (no watchers). A file that will not parse is
  skipped with a `parseErrors` entry in lists and is a 422 `parse_error` on a direct
  read. Read REST lives under `…/managers/…` on both workspace mounts
  (`routes/managers.ts`). Boot runs `ensureDataRepo` (marker, `.gitignore`, union-merge
  `.gitattributes`, README, `git init` unless `MANAGERS_DATA_GIT_INIT=0` — the test
  helper sets `0`). Slugs `objectives tasks log runs reports memory archive` are
  reserved, and a new notebook is seeded with `.managers/triggers/wake.md` and a
  DISABLED `wake` trigger.
- **State writes (M5).** Every write — the agents' `managers` MCP state tools and
  the UI's write REST (`POST/PATCH …/managers/tasks`, `…/tasks/:id/answer`,
  `POST/PATCH …/managers/objectives`) — goes through ONE writer,
  `managers/state-writes.ts`: a per-workspace promise-chain lock
  (`write-queue.ts`; temp-file + rename for rewrites, `appendFile` for journals),
  ids minted under that lock, and every record validated through the STRICT
  `*WriteSchema` (an update re-reads the raw frontmatter, never echoes the lenient
  read DTO; hand-added keys are preserved). `managers/autocommit.ts` then commits
  ONLY the owned paths (`objectives tasks log runs reports memory .gitattributes`)
  per workspace — agent writes as `managers-bot` (`MANAGERS_BOT_GIT_*`), UI writes
  as the request's user or `MANAGERS_GIT_AUTHOR_*` — 10 s debounced
  (`MANAGERS_AUTOCOMMIT_DEBOUNCE_MS`), flushed when a turn ends, off with
  `MANAGERS_AUTOCOMMIT=0`, never pushed. The `managers` MCP server is now injected
  on EVERY keeper and trigger turn: its state block (`self-mcp-state.ts`) is
  always on; the chat-read block keeps `selfMcpEnabled`, spawn-write keeps the
  depth gate. `enforceManagementPolicy` polices state ops for every principal —
  the in-process keeper may only WRITE its own project; external principals need
  explicit grants (`DEFAULT_READ_ONLY_SCOPE` no longer uses `list_*`).
  `memory_op` is real since M14 (see below).
- **Runs and the dead-man's switch (M6).** Every trigger fire (the one path,
  `ws-triggers.ts` `fireTriggerForProject`) writes `runs/YYYY-MM/<run-id>.yaml`
  via `managers/trigger-runs.ts`: `status: running` before the turn, finished by
  the turn's `onComplete` hook (`StartAgentTurnOpts.runId`/`onComplete`, fired
  once by `ws-turn.ts` on every ending and awaited — bounded — BEFORE the hub
  turn ends), then committed at once (`flushManagersCommit`). The run id reaches
  the state tools as `currentRunId` only while the turn runs, so
  `record_artifact` works and each episode/task/report the run writes is noted
  on its record. A surfaced dead-end (error/max-turns/usage-limit notice) counts
  as a failed run even when the drive reported success. `run.expect`
  (`trigger-config.ts`) is evaluated at finish (`managers/expect.ts`);
  `managers/alerts.ts` `computeAlerts` (pure) derives `run-failed`,
  `artifact-missing`, `stale`, `schedule-stalled` and `run-stuck`, served by
  `GET …/managers/alerts` and the `list_alerts` tool. `mcpCalls` counts
  `mcp__<server>__<tool>` calls, excluding `managers*`. The Triggers tab's edit
  form carries run fields it doesn't show (`runExtra`), so a full-replace PUT
  never drops `run.expect`.
- **The wake briefing (M7).** `managers/briefing.ts` `buildBriefing` is the ONE
  builder of what a manager sees: 13 sections in a fixed order (header, the
  protocol from `managers/protocol.ts`, behaviours/connections placeholders,
  shared + project `MEMORY.md`, the bound objective in full or every active
  objective's summary, open tasks awaiting-ed first, answers since the trigger's
  previous run, recent runs, alerts, the project log, OVERVIEW.md), each with a
  hard character budget (`SECTION_BUDGETS`) and a `[truncated: …]` note.
  Deterministic (`now` injected, stable sorts) and snapshot-tested
  (`test/unit/managers/__snapshots__/briefing-acme-wake.md` — change the output on
  purpose and update it). Embedded docs have headings demoted two levels and
  `<project-context>` escaped. It reaches the agent through `wrapPreload`, so
  chat names stay the request: a schedule fire is briefed unless
  `run.briefing: false`, an event fire only with `run.briefing` set
  (`{objective}` beats the objective's `triggers:` binding); the fire writes
  `.managers/briefings/<run>.md` (gitignored) and its sha256 onto the run.
  `composePreloadedPrompt` (New Chat preload + `create_chat`) now sends the
  `kind: chat` briefing instead of OVERVIEW + CHANGELOG, and always wraps. Also:
  `get_briefing` tool, `GET …/managers/briefing` preview, `briefingText` on the
  run detail. The environment prompt (SDK runtime only) just points at the
  protocol. Any new `run.*` key must go into `runSchema`.
- **Behaviours and binary autonomy (M8, `managers/behaviours.ts`).** `project.yaml`
  `behaviours:` maps a kebab-case name to `{enabled, description, triggers, tools,
  instructions}`. Definitions merge field by field (built-in < Home/root < project);
  `enabled` counts ONLY when literally `true` in the workspace's own file (the root's
  flag applies to Home alone) — **everything defaults to off, and off means it does
  not happen at all, not even as a proposal** (protocol rule 5 says so). An off
  behaviour's triggers (its `triggers:` list, or a trigger's `run.behaviour`; an
  undefined name fails closed) are not armed (`triggersToHerdctlSchedules` gate) and
  `fireTriggerForProject` throws `BehaviourOffError` before any run record — Run now
  is a 409 `behaviour_off`, `run_trigger` a tool error, cron/event fires silent; its
  tools join `denied_tools` on the keeper AND trigger agents, restated with the
  fleet defaults and `BEHAVIOUR_TAMPER_DENIED_TOOLS` (Edit/Write of `project.yaml`
  and `.managers/**`). The briefing's Behaviours section lists ON ones with
  instructions, then "Not permitted". The ONLY switch is `PATCH
  …/managers/behaviours/:name {enabled}` (Settings → Behaviours): it writes
  `project.yaml`, calls `ensureProjectAgent`, logs an `#autonomy` episode and
  commits `project.yaml` with the log at once (`Autocommitter.schedule`'s
  `extraPaths`). The generic project PATCH cannot touch `behaviours`, and
  `set_trigger` refuses to change `run.behaviour`. `managers/behaviour-state.ts`
  keeps a fingerprint in `.managers/state/behaviours.json` (gitignored; adopted at
  boot); any other change raises the info alert `behaviours-changed-outside-ui`
  (cleared by a switch or `POST …/behaviours/acknowledge`). HerdctlService caches
  Home's definitions for the sync config builders (`setRootProvider`); the fire path
  always re-reads, so a stale arming can only be refused, never widened.
- **Per-project MCP connections (M9, `managers/project-mcp.ts`).** `project.yaml`
  `mcp:` maps a connection name to the instance `mcpServers:` declaration shape
  (`url`/`type`/`headers`/`command`/`args`/`env`) plus `tools:` (bare tool names;
  absent = every tool) and `description`. `resolveProjectMcp(project, env)` reuses
  `resolveDeclaredMcpServers` but an inline secret-ish `headers`/`env` value or a url
  with a query/userinfo is a HARD error (dropped), `managers`/`managers_files`/
  `playwright` are refused, an unset `env:VAR` drops the connection, and `tools:`
  becomes exact `mcp__<name>__<tool>` allowlist patterns. Never cascaded from the
  root; `normalize` carries the block verbatim so a broken entry survives a save.
  `HerdctlService.projectMcpOf` resolves it (logging secret-free notices on
  registration); `buildAgentConfig` merges the servers over the instance/host ones
  and widens `allowed_tools` by the exact patterns; `buildTriggerConfig` gives a
  SCOPED trigger a connection only when its own `run.tools` names it
  (`triggerConnections` swaps `mcp__<name>__*` for what the connection allows).
  Off-behaviour tools stay denied on top. REST: `GET …/managers/connections`
  (redacted url, header KEYS, env var names + set?, allowlist, errors) and `POST
  …/connections/:name/probe` (`managers/mcp-probe.ts`: SDK client, 10 s,
  `initialize` + `tools/list`, errors sanitised to e.g. `401 Unauthorized`). The
  briefing's Connections section lists names, descriptions and callable tools; a
  `preSerialization` hook redacts inline `mcp:` values from every project DTO.
  Settings → Connections (`ConnectionsSection.tsx`). The fake `claude` now
  permission-checks MCP calls against `--allowedTools`/`--disallowedTools`, and the
  rig runs `fake-paddock-mcp.mjs` beside the server.
- **Audit fixes (M9.5).** `project.yaml` writes: every `ProjectStore` mutator runs
  its read-modify-write under a per-workspace lock (`withYamlLock`) and
  `writeYaml` is temp-file + rename, so concurrent saves never lose `behaviours:`.
  A file that exists but will not read as a record (bad YAML, not a mapping, a
  `behaviours:` block the sanitiser would thin — `behavioursShapeError`) sets the
  DTO's `configError`: the store REFUSES to rewrite it, and the gate FAILS CLOSED —
  every behaviour off, the last-known-good definitions
  (`managers/behaviour-lkg.ts`, `.managers/state/behaviour-defs.json`) keep their
  triggers gated and tools denied, a synthetic `config-unreadable` behaviour (gating
  `*` when nothing is known) and an error alert appear, and the Behaviours PATCH is
  a 409. `behavioursFor` treats a throwing root read the same way. Agents (every MCP
  principal) cannot create, change or remove a behaviour-gated trigger or one whose
  name was ever gated (`managers/trigger-guard.ts`, tombstones in
  `.managers/state/gated-triggers.json`); humans use the Triggers tab/REST. At boot
  `MANAGERS_MCP_*` vars are moved out of `process.env` (`managers/mcp-secret-env.ts`;
  resolvers read `mcpResolveEnv()`), so children never inherit another project's
  token. Autocommit stages only store-shaped files (`isOwnedStateFile`); a behaviour
  switch commits pending `project.yaml` edits separately as the bot first, and
  switches are serialised. The data-dir guard claims only an EMPTY root. Boot fails
  runs left `running` by a previous process (`interrupted by restart`). `mcpCalls`
  counts calls that went through; errored/denied ones go to `mcpErrors`. The
  `bypass-permissions` alert warns when a narrowed connection or gated tool meets
  `bypassPermissions`. History titles strip the preload (`runs.ts` `runPrompt`).
- **The report primitive (M10, `managers/reports.ts`, `managers/effective-triggers.ts`).**
  `project.yaml` `reports:` maps a kebab-case type to `{enabled, schedule: {cron|interval},
  promptFile?, model?, description?}`; definitions merge built-in < Home < project and
  `enabled` counts only in the workspace's own file (the behaviours rule). The built-in
  `status` type exists everywhere, unscheduled. File-only (not in `PATCHABLE_KEYS`).
  Each effective type is a DERIVED trigger `report-<type>` — never persisted, computed by
  `effectiveTriggers(project, root)` wherever triggers are armed/registered/fired
  (`HerdctlService.effectiveTriggersOf` for the keeper `schedules`, the scoped trigger
  agents and the chat listing; `effectiveTriggersFor` on the fire path, the schedule
  handler, Run now, alerts and briefings). Its capability is fixed: its own scoped agent,
  `tools: [Read, Grep, Glob]` + the injected `managers` tools, `maxTurns: 20`, `expect:
  {kind: report, report: <type>}`, the `briefing` kind `report` (standard sections plus
  Schedule, the previous report and what changed since it). `report-*` and `consolidate`
  are RESERVED: `ProjectStore.setTrigger` refuses them for everyone, the agent trigger
  guard refuses `remove_trigger` too. Derived triggers go through the same behaviour gate
  (arming and every fire, Refresh included); a declared trigger under a derived name is
  replaced but its `run.behaviour` is carried; the `derived` marker (which makes the run
  kind `report`) is not in the trigger schema, so nothing in `project.yaml` can claim it.
  `write_report` validates the type against the workspace's effective types, strips any
  model-written `## Needs you` / `## Alerts` section and leading title, and composes
  `{type, generated, run, previous}` frontmatter + `# <Type>: <project>, <date>` + the
  server-rendered Needs you (awaiting-ed tasks, linked `/projects/:slug/tasks#<id>`) and
  Alerts + the body, into `YYYY-MM-DD.md` and `current.md`. `POST
  …/managers/reports/:type/refresh` fires the derived trigger ignoring `enabled` → 202
  `{runId, sessionId}`; `GET …/managers/reports` lists every effective type with its
  config and current report.
- **Objectives and Tasks UI (M11, `packages/web/src/components/managers/`).** Two tabs
  after Home, on both mounts: `…/objectives[/:objectiveId]` and `…/tasks[/:taskId]`
  (`ProjectViewTab` `objectives|tasks`, `deriveView` matches whole segments, sticky
  last tab knows them). `ObjectivesPane` (cards: status, the `excerpt` of "Where we
  are" and `openTasks`, both added to the list DTO server-side) → `ObjectiveDetail`
  (sections as Markdown, open tasks, "Edit in Files", `JournalTimeline`: by UTC day,
  `id="ep-…"` anchors, "Load older" one month at a time, and a `#ep-…` in an older
  month pages back until it is loaded; the run link resolves the run's chat).
  `TasksPane`: open tasks grouped Awaiting you → Doing → Open → Blocked, filters in
  the URL query (`?objective=<id>|none&status=a,b`), closed months lazy behind "Show
  done", `#<task-id>` marks a row (the report's Needs-you link), a row `Menu` moves
  the status (never to awaiting-ed), `/tasks/:taskId` is `TaskDetailView`.
  `TaskAnswer` (self-contained, for M13's reuse) posts `…/answer`; its "Wake the
  manager now" switch reads `GET …/managers/wake` `{available, reason}`, the same
  check the answer route uses. Every pane has a skeleton, an error `Callout` with
  Retry and an empty state; tokens and `ui/` primitives only.
- **Project overview, report history, Memory (M12).** A PROJECT's Home opens on
  `ManagersOverview` (passed into `HomePane` as the `managers` slot; the root's Home is
  M13's): `StatusReportCard` shows `reports/status/current.md` MINUS its title and its
  stored "Needs you"/"Alerts" (`reportMarkdown.ts` `reportBody`, fence-aware) and renders
  both LIVE from `…/tasks?status=awaiting-ed` and `…/alerts` (`AlertsList`), so a stale
  report never hides or repeats a request; the three reads are independent (a report
  error is a Callout, the live sections still render). "Refresh now" POSTs M10's refresh
  and polls the run (spinner) → re-reads; a failed run, a run that wrote no report, and a
  409 each say so. `ObjectivesSummary` (active/paused), `RunsList` (last 10, pages back
  ≤12 months) → `RunDrawer` (`Dialog placement="side"`, new on the primitive: error,
  expect, what it wrote, connection calls, chat link, "What the manager saw" = the
  run's `briefingText`). Routes `…/reports/:reportType[/:reportDate]` (`ReportHistory`,
  no tab — Home stays highlighted) and the Memory tab `…/memory[/:fact]` (`MemoryPane`:
  project + Shared sections, Active/Superseded/All in `?show=`, "Consolidation: on/off"
  from the `consolidate-memory` behaviour → `settings#behaviours`). The fact DTO gains
  `evidenceLinks` (`managers/evidence-links.ts`: ids resolved through
  `EpisodesStore.index`, project facts in the project, root facts in Home then the
  viewing project; `href` = objective page `#ep-…` or the log file in Files; unresolved
  ids kept with `found: false`). Objective Lessons' `[[fact]]` now link to Memory.
  Rendered Markdown's internal links navigate in-app via `useInternalLinks`.
- **Home's "Needs you" (M13).** The ROOT's Home opens on `NeedsYouPanel` (the
  `managers` slot at the root), fed by the one instance-level Managers route, `GET
  /api/managers/needs-you` (`registerManagerInstanceRoutes`, outside the workspace
  mount; `managers/needs-you.ts` `collectNeedsYou`): for Home plus every project, its
  awaiting-ed tasks, its alerts (the SAME `workspaceAlerts` the `…/alerts` route
  uses), its status report's age (`stale` past 48 h) and unreadable task files. A
  workspace that throws becomes `{slug, name, error}` (paths made relative), never a
  failed response. Quiet workspaces are dropped unless `?all=1`; `totals.checked`
  counts them. Order: asks (longest-waiting first) → unreadable → alert-only (worst
  severity first) → quiet, ties by name. The panel groups by workspace (header →
  that Home, counts, "Status report 3d old"), answers with `TaskAnswer` in place
  (per-workspace `…/wake`), alert rows open the project's Home, and it re-reads
  quietly after an answer. Note the stores read ENOENT **and ENOTDIR** as "none yet",
  so a corrupt task dir only surfaces as an error when reading it really fails
  (EACCES for a non-root server, ELOOP, …). The full v1 loop is
  `test/e2e/journey-managers-loop.spec.ts`, which runs on the GIT e2e server
  (`chromium-git`; its UI author is "Ed" and its autocommit debounce 500 ms).
- **Consolidation and `memory_op` (M14, `managers/consolidation.ts`, `managers/memory-index.ts`).**
  The built-in `consolidate-memory` behaviour (OFF by default, config `{schedule "30 3 * *
  *", threshold 40, minGapHours 6, model, promptFile}` in `behaviours.<name>.config`, merged
  built-in < Home < project) derives the `consolidate` trigger in EVERY workspace
  (`effectiveTriggers`; armed only on the workspace's own flag; gated by the behaviour at
  every fire; fixed capability Read/Grep/Glob, `maxTurns` 30, `expect: none`, briefing kind
  `consolidation` = the standard sections plus Memory protocol, Active facts in full, Superseded
  facts and the episodes since the last consolidation). `memory_op` (`StateWriter.memoryOp`:
  add/update/supersede/noop; evidence ids must EXIST in the workspace's episode index, a
  `pattern` needs 2; never deletes — supersede sets `until`, update/supersede append `## History`;
  every write regenerates `memory/MEMORY.md` below `<!-- managers:index -->`, keeping Ed's
  preamble verbatim, grouped by type + `## Superseded`, ≤150 lines / 20KB) is allowed ONLY
  (a) while a message Ed sent through the UI drives the turn — `ws.ts` onChatSend's
  `humanTurnLive`, cleared when the foreground drive settles, so a wake or background
  re-invocation replaying that chat's cached server defs is refused; the chat ORIGIN no longer
  counts — and (b) inside a live consolidation run of the same workspace, recognised by the
  IN-MEMORY `ConsolidationTracker` (`ManagersState.consolidations`), which only the fire path
  fills: no file (project.yaml, a run record) can claim it. Everything else gets "not
  available in this turn". Agents cannot `run_trigger consolidate` (any principal); the
  schedule, the early fire (an AGENT episode pushing importance since the last succeeded
  consolidation past `threshold`, ≥ `minGapHours` since the last one; per-workspace claim) and
  Ed's `POST …/managers/consolidation/run` (Memory tab) start it. At run end the server writes
  one `#reflection` episode listing the ops (never counted toward the threshold). `GET
  …/managers/consolidation` feeds the Memory header ("Last consolidated …", "Run consolidation
  now" when on); Settings → Behaviours shows its schedule chips.
- **Security posture (M14.5, `boot-posture.ts`, `herdctl-bridge-bind.ts`, AUTH.md).** Boot
  REFUSES `MANAGERS_AUTH_MODE=none` (the default) unless `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1`
  (agents on this host can otherwise act as Ed over REST/WS), `jwt` without BOTH
  `MANAGERS_AUTH_JWT_ISSUER` and `MANAGERS_AUTH_JWT_AUDIENCE` unless
  `MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE=1`, and `MANAGERS_DRIVE_MODE=batch` unless
  `MANAGERS_ALLOW_BATCH_DRIVE=1` (herdctl's CLI runtime serves each turn's injected MCP tools
  over an unauthenticated HTTP bridge). A project's `driveMode: batch` runs as session without
  that flag (`resolveProjectDriveMode`, the ONE resolver) and the PATCH is a 400
  `batch_drive_disabled`. Every opted-in danger (plus `trusted-header`) is a `SECURITY:` boot
  warning, a `warnings[]` entry of `GET /api/security`, and a persistent `SecurityBanner` in the
  shell. The rig, E2E server, docs-media/demo-gif rigs and `test/helpers/app.ts` set the opt-ins.
  `installHerdctlBridgeLoopbackBind` (buildApp) makes `http.Server.prototype.listen` rewrite
  exactly `listen(0, "0.0.0.0")` from herdctl's `mcp-http-bridge` (not `container-runner`) to
  `127.0.0.1`. Also M14.5: a project with an unreadable `project.yaml` is collated on Home's
  Needs you (`ProjectStore.listUnreadable`, `configError` + a `config-unreadable` alert); an
  in-process agent writes triggers only in its OWN project; an unattended consolidation's
  `add` needs evidence and a `user` fact needs an episode Ed wrote; consolidation ops are
  noted on the run (`memoryOps`) so a restart-interrupted run still gets its `#reflection`;
  a `running` consolidation record counts only if `ConsolidationTracker` knows the id.
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

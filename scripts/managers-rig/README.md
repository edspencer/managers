# `scripts/managers-rig/` — the credential-free Managers QA rig

A synthetic Managers instance for QA: seeded projects, chats and a git-backed data
repo, served by the **built** server with the fake `claude` on `PATH`, no
credentials, and an isolated `HOME`. Nothing it runs calls Anthropic.

Forked from `scripts/demo-gif/` (Paddock's README-GIF rig). Its README's
"Things that will bite you" section still applies and is worth reading once.

**Never point any of this at `/data/projects`, `/data/.claude`, `/data/claude-home`
or another real data dir.** `seed.mjs` refuses those paths, but don't rely on it.

## The pieces

| File | Does |
| --- | --- |
| `fixtures.mjs` | The synthetic world: Home (the root workspace) plus `acme-site`, `widget-lib`, `empty-project` and (M9) `broken-conn`, `wrong-token`, with their files, triggers and chats. **Later milestones add fixtures here, as data.** Never remove one an earlier milestone's QA relies on. |
| `seed.mjs` | `--out <dir> [--now <ISO>]`. Writes `<dir>/data` (a complete `MANAGERS_DATA_DIR`: the `.managers-data` marker, a projects root `git init`ed with one clean commit, chats, job records, read state, provenance), `<dir>/home`, `fake-script.json` and `manifest.json`. Times are relative to the wall clock; `--now` is only for screenshot determinism. |
| `serve.mjs` | `--data <dir>/data --port <N> [--home <dir>/home]`. Boots `packages/server/dist` with `rigEnv` (below) and forwards SIGTERM/SIGINT/SIGHUP to it. Importable: `startServer`, `rigEnv`. |
| `fake-paddock-mcp.mjs` | M9. A stand-in Paddock `/mcp` (streamable HTTP, bearer `rig-token`, canned tools). `serve.mjs` spawns it on PORT+1; tests import `startFakePaddockMcp`. See "Connections fixture". |
| `leak-check.mjs` | `--out <scratch> [--port <N>]`. The isolation proof; see below. |
| `lib/transcript.mjs` | Builders for Claude Code transcript lines (forked from the demo rig). |
| `lib/domain.mjs` | Renderers for Managers domain state (objectives + journals, tasks, facts, `MEMORY.md`, runs, status reports) from relative-time data, in the exact §4 on-disk shapes. |

`rigEnv` deletes every `PADDOCK_*` / `MANAGERS_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `NODE_ENV` it inherits, then sets:

- `HOME` to the rig home, and `test/bin` first on `PATH` (the fake `claude`);
- `HOST=127.0.0.1` (forced), `PORT`;
- `MANAGERS_DATA_DIR`, `MANAGERS_PROJECTS_DIR`, `MANAGERS_WEB_DIST`;
- `MANAGERS_DRIVE_MODE=batch`, `MANAGERS_AUTH_MODE=none`, plus their M14.5 opt-ins
  `MANAGERS_ALLOW_BATCH_DRIVE=1` and `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1` (so the UI shows
  the red "No authentication" banner, by design);
- nothing for the `managers` MCP (the target of `[[MCP managers.*]]`): since M5 it
  is injected on every keeper and trigger turn for its state tools
  (`record_episode`, `upsert_task`, `list_tasks`, …), and its chat-read block
  (`list_projects`, `list_chats`, `read_chat`) is on under the default `balanced`
  profile. (M2–M4 set `MANAGERS_SELF_MCP=1`; it was redundant under that profile
  and M5 dropped it, so the rig runs the default posture);
- `MANAGERS_SWEEP_MIN_INTERVAL_MS=999999999` (the sweeper would rewrite seeded files).
  The interval counts from the last sweep, and a never-swept project counts as swept
  at epoch 0, so `seed.mjs` also writes `sweep-state.json` stamping every workspace
  as swept at seed time. Without it, the first turn in each project rewrites its
  seeded `OVERVIEW.md`/`CHANGELOG.md` (since M3 the sweeper never touches
  `CLAUDE.md`). A project created in QA has no watermark, so IT is swept after its
  first turn — which is how M3's QA checks curation;
- M9: `MANAGERS_RIG_PADDOCK_URL` (the fake Paddock's url) and the synthetic
  connection tokens `MANAGERS_MCP_PADDOCK_WIDGET_LIB="Bearer rig-token"` and
  `MANAGERS_MCP_PADDOCK_WRONG_TOKEN="Bearer wrong-secret"`
  (`MANAGERS_MCP_PADDOCK_BROKEN_CONN` stays unset on purpose);
- `MANAGERS_FAKE_SCRIPT=<rig>/fake-script.json`, and
  `MANAGERS_FAKE_INVOCATION_LOG=<rig>/invocations.jsonl` (one line per fake-claude
  spawn, including its `--mcp-config`, its `--setting-sources` (`settingSources`,
  M3) and `paddockEnvCount`, a count and never names).

Server output goes to `<rig>/server.log` and to `pm logs`.

## Running it under pm (`managers-qa`)

The wrapper lives at `/data/paddock-servers/managers-qa/run.sh`, outside the
repo, and re-seeds from scratch on every start:

```bash
#!/usr/bin/env bash
# Credential-free Managers QA rig. NEVER point at /data/projects or /data/.claude.
set -euo pipefail
REPO=/data/projects/clones/managers
RIG=/data/paddock-servers/managers-qa/state
: "${PORT:?pm must export PORT}"
NODE_BIN="$(dirname "$(command -v node)")"
rm -rf "$RIG" && mkdir -p "$RIG"
env -u NODE_ENV node "$REPO/scripts/managers-rig/seed.mjs" --out "$RIG"
# exec: serve.mjs becomes pm's child and already forwards SIGTERM/SIGINT/SIGHUP to the server.
exec env -i PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" HOME="$RIG/home" \
  node "$REPO/scripts/managers-rig/serve.mjs" --data "$RIG/data" --port "$PORT" --home "$RIG/home"
```

| | |
| --- | --- |
| Build first | `scripts/clean-env.sh npm run build` (the rig serves `dist/`) |
| Start | `pm start managers-qa --cwd /data/projects/clones/managers -- /data/paddock-servers/managers-qa/run.sh` |
| Port | `pm status managers-qa` (or `--json`); drive `http://127.0.0.1:<port>` |
| After a rebuild | `pm stop managers-qa && pm start managers-qa` — `pm restart` can lose `PORT` |
| Logs | `pm logs managers-qa --lines 200`, or `/data/paddock-servers/managers-qa/state/server.log` |
| Finish | `pm stop managers-qa && pm rm managers-qa` |

Every start wipes `state/`, so anything QA created is gone after a restart. The
seeded chats' session ids are in `state/manifest.json`.

Finding the server's pid (it is serve.mjs's child, not pm's): serve.mjs prints
`Managers rig up: … (server pid N)` to `pm logs`. Or take pm's pid (the serve.mjs
process) and read `/proc/<pid>/task/<pid>/children`.

Prove the server is your build before trusting a screenshot: grep the served
bundle or an API response for something you just added.

## The fake `claude`'s `[[MCP …]]` directive

Put `[[MCP <server>.<tool> <json-args>]]` anywhere in a prompt (a chat message
or a trigger prompt) and the fake **really calls that tool**:

```
QA [[MCP managers.list_projects {}]]
[[MCP managers.list_chats {"project":"acme-site"}]] then [[MCP managers.nope {}]]
[[MCP managers.record_episode {"text":"QA wrote this","importance":4,"tags":["qa"]}]]
[[MCP managers.upsert_task {"title":"QA ask","status":"awaiting-ed","ask":"Approve QA?"}]]
```

The state tools (M5) write the data repo and are auto-committed as `managers-bot`
(10 s debounce, or at once when the turn ends): check with
`git -C /data/paddock-servers/managers-qa/state/data/projects log -1 --format=%an`.

- It is repeatable; calls run in prompt order, before the reply.
- `<json-args>` is an optional JSON object (default `{}`). A `]]` inside it is fine.
- `<server>` is a key of the turn's `--mcp-config`. In batch mode herdctl exposes
  each injected server (`managers`, `managers_files`) as a localhost HTTP bridge
  there. Declared `http`/`sse` servers (with `headers`) and `stdio` servers work
  the same way, which is how per-project connections get QA'd later.
- Each call is written to the transcript as a `mcp__<server>__<tool>` `tool_use`
  plus its `tool_result`, so the UI shows a normal tool block.
- An unknown server or tool, a connection or call failure, a timeout
  (`MANAGERS_FAKE_MCP_TIMEOUT_MS`, default 15000), a tool returning `isError`, or
  malformed args all give a `tool_result` with `is_error: true`. The turn then
  **carries on** to its reply and a success result.

The full list of the fake's directives is in the header of `test/bin/claude`.

## Proving isolation

The pm wrapper runs under `env -i`, and `rigEnv` scrubs `PADDOCK_*` too. So finding
no `PADDOCK_*` in the rig server's `/proc/<pid>/environ` proves only that the
*wrapper* is clean, not that the *server* would cope with a leaked Paddock
environment. That is the plan's QA check, and it is worth doing, but it can't fail.

`leak-check.mjs` is the check that can fail. It seeds a separate throwaway rig and
boots the server with fake Paddock-style vars injected **after** the scrub
(`startServer({ leakEnv })`): `PADDOCK_AUTH_MODE=jwt`, `PADDOCK_DATA_DIR=/nonexistent`,
and so on. Then it checks:

1. the vars are really in the server's environ;
2. the server logged its boot scrub;
3. the API answers 200 with the seeded projects;
4. the brand is Managers;
5. a real trigger turn's fake `claude` saw `paddockEnvCount: 0`, and its
   `[[MCP managers.list_projects {}]]` call succeeded.

```bash
node scripts/managers-rig/leak-check.mjs --out /data/paddock-servers/managers-qa/leak-check --port 5098
```

It prints PASS/FAIL per check, exits non-zero on any failure, and stops its server
when it's done. Choose a port that `pm status` shows as free.

## Extending the fixtures

Read the header of `fixtures.mjs`. In short:

- domain state (objectives, tasks, memory, reports, runs) is plain files, so add it
  to a project's `files`;
- new `project.yaml` blocks go in `yaml: { … }`;
- chats go in `chats: [{ label, prompt, reply, hoursAgo, unread?, origin?, tool? }]`;
- Managers domain state goes in `state: (clock) => ({ path: text })`, built with the
  `lib/domain.mjs` renderers so every date is relative to the seed clock.

`seed.mjs` also runs the server's own `ensureDataRepo` (from `packages/server/dist`,
so **build before seeding**) before the initial commit, so the rig's `.gitignore`,
`.gitattributes` and `README.md` are exactly what boot would write and the tree is
still clean once the server is up.

### Domain fixtures (M4)

| Workspace | State |
| --- | --- |
| Home (root) | Shared memory: `MEMORY.md` + facts `house-style`, `weekend-quiet` (every project sees them as `scope: root`); one `awaiting-ed` task. |
| `acme-site` | Objectives `blog-cadence`, `pricing-rewrite` (active) and `fix-broken-links` (done); **25 journal entries over 40 days** across two month files each, plus 3 project-log entries; tasks in **every status** (two `awaiting-ed`, one `doing`, `blocked`, `open`, and a `done` and a `dropped` in `tasks/done/<month>/`); facts `reviews-stall-drafts`, `pricing-owner`; four runs (`succeeded`/`met`, **`failed`**, `succeeded` with **`expectResult: missing`**, an old `n/a`); a `status` report (`current.md` + two dated). |
| `widget-lib` | Objective `burn-down-issues` with a short journal; the §4 renovate `awaiting-ed` task; and a **deliberately malformed task** (`status: someday`) — the `parseError` fixture: lists skip and report it, a direct read is 422. |
| `empty-project` | Still nothing: the empty-state fixture. |

### Runs and alerts fixtures (M6)

`acme-site` also has an **enabled** `publish-check` trigger (`cron: 0 3 1 1 *`, so it
never fires during QA; use Run now) with `run.expect: {kind: episode, within: 48h}`.
Its inline prompt records one episode through `[[MCP managers.record_episode …]]`.
Its only run, four days old, is `met`, so on a fresh boot
`GET /api/projects/acme-site/managers/alerts` shows **`stale:publish-check`**, and
that alert clears after one Run now. A matching 4-day-old project-log episode names
that run. `empty-project`'s alerts are `[]`.

### Wake briefing fixture (M7)

`acme-site` also has a **disabled** `wake` schedule trigger (`cron: 0 7 * * *`) with
the inline body `Wake. [[TOOL]]` and no `run.briefing` key, so a Run now is briefed by
default: the chat's first user message is `<project-context>` + the briefing + `My
request:` + the body, and `.managers/briefings/<run>.md` keeps a copy (gitignored). It
is bound to no objective, so the briefing lists acme-site's active objectives. Preview
any workspace's briefing at `GET /api/projects/<slug>/managers/briefing`
(`?objective=`, `?trigger=`, `?kind=chat`); `empty-project` shows `(no objectives)` and
`(no open tasks)`.

### Behaviours fixture (M8)

Home's `project.yaml` **defines** `triage-external-prs` (gating the trigger
`triage-prs` and the tool `mcp__paddock__create_chat`) with no `enabled`, so it is
OFF in every project. `widget-lib` has an **enabled** `triage-prs` schedule trigger
(`cron: 0 3 1 1 *`, body `Triage external PRs. [[TOOL]]`, `run.behaviour:
triage-external-prs`): on a fresh boot it is not armed and Run now is a 409 naming the
behaviour. `widget-lib` also defines its own `draft-release-notes` (off). Switch
behaviours at `/projects/widget-lib/settings` → Behaviours (or `PATCH
…/managers/behaviours/<name> {enabled}`). Every project also lists the built-in
`consolidate-memory` (off). `empty-project` defines none of its own, so its card shows
"No behaviours defined in this project" above the inherited rows. A hand edit of a
`project.yaml` flag raises `behaviours-changed-outside-ui` in that workspace's alerts.

### Connections fixture (M9)

`serve.mjs` also starts **`fake-paddock-mcp.mjs`**, a streamable-HTTP MCP server on
**PORT+1** (any free port when that one is taken; `pm logs managers-qa` prints
`Fake Paddock MCP up: <url>`). It answers only `Authorization: Bearer rig-token`
(401 otherwise) and serves canned `list_projects`, `list_chats`, `create_chat` and
`read_chat`. It is killed with the server. `rigEnv` points the connections at it with
`MANAGERS_RIG_PADDOCK_URL` and sets two SYNTHETIC tokens:

| Workspace | `mcp.paddock` | Expect |
| --- | --- | --- |
| `widget-lib` | `Authorization: env:MANAGERS_MCP_PADDOCK_WIDGET_LIB` (`Bearer rig-token`), narrowed to the four tools | "env … set"; Test connection lists the four tools |
| `broken-conn` | `env:MANAGERS_MCP_PADDOCK_BROKEN_CONN`, which is **unset** | "missing" chip, Not attached, Test connection names the variable |
| `wrong-token` | `env:MANAGERS_MCP_PADDOCK_WRONG_TOKEN` (`Bearer wrong-secret`) | Test connection: `401 Unauthorized` |
| `empty-project` | none | the Connections empty state with the YAML snippet |

`widget-lib` also has a **disabled** `paddock-dispatch` trigger whose body calls
`[[MCP paddock.list_projects {}]]` then `[[MCP paddock.create_chat
{"project":"demo","prompt":"triage #12"}]]`. `create_chat` is a tool of Home's
`triage-external-prs`, which is OFF, so on a fresh boot that call is **denied** (the
fake `claude` enforces `--disallowedTools` / `--allowedTools` for MCP calls since M9)
and `list_projects` succeeds; switch the behaviour on and Run now again to see a
canned `fake-chat-new-0001`. The run record's `mcpCalls` counts both attempts.

### Reports fixture (M10)

Every workspace has the built-in `status` report type, and so the derived trigger
`report-status` (never in `project.yaml`; its schedule is armed only when the
project's own `reports.status.enabled` is `true`, which no fixture sets).
`acme-site` sets `reports.status.promptFile: status-report.md`, whose body is a
`[[MCP managers.write_report {"type":"status",…}]]` that also writes its own
"## Needs you" (the server drops it and renders the real one from the two
awaiting-ed tasks, plus "## Alerts" with `stale:publish-check`). Fire it with
`POST /api/projects/acme-site/managers/reports/status/refresh` (202 `{runId,
sessionId}`), then poll `…/managers/runs/<runId>`.

`acme-site` also has a **disabled** `bogus-report` trigger that calls
`write_report {"type":"bogus",…}`: the tool call errors and nothing is written.
`empty-project` lists `status` with `current: null`.

### Objectives and Tasks UI fixture (M11)

No new files: the M4 domain fixtures drive the Objectives and Tasks tabs.
`acme-site` has three objectives (`blog-cadence` and `pricing-rewrite` active,
`fix-broken-links` done and with no tasks, which is the zero-results filter),
journals spanning two months (so "Load older" has a month to load), two
awaiting-ed tasks with options, and closed tasks in two `done/` months (so "Show
done" then "Load older" both have something). The one change: the `morning-check`
run of yesterday (`r-…-wk`, the run the `blog-cadence` "Morning wake" journal
entry names) now carries `sessionId` = the seeded `acme-site:morning` chat, so
the journal's run link opens a chat. Home has one awaiting-ed task and no
objectives. No fixture has an ENABLED `wake` (until M13's `widget-lib` one), so
the answer form's "Wake the manager now" switch is disabled with its reason;
enable `acme-site`'s `wake` in the Triggers tab to exercise the enabled path (its
cron is 07:00 UTC).

### Home overview, Memory and report history fixture (M12)

Additions only:
- The failed `morning-check` run (`r-…-fl`) has a briefing: `renderRun`'s
  `briefing` option writes `.managers/briefings/<run>.md` and records its path and
  sha256, so the run drawer's "What the manager saw" has text. The other runs
  have none ("No briefing was recorded").
- `acme-site`'s stored status reports carry `generated` (like an M10-composed
  report), and today's has a stored `## Needs you` and `## Alerts: None.` — what
  the server wrote THEN. Home's card hides both and renders them live, so after
  answering a task in the Tasks tab it has already left Home's Needs you while
  the stored report still lists it; the live Alerts show `stale:publish-check`.
  Report history has two dates.
- `pricing-owner` cites evidence in an OLDER journal month (August:
  `pricing-rewrite`'s "Collected five competitor pricing pages", so the chip
  pages the objective back to it) and one id that resolves nowhere
  (`ep-200101-0000-zz`, shown struck through). `renderFact`'s `evidence` takes a
  literal id string for that.
- `empty-project` stays empty: no report ("No status report yet"), no runs ("No
  runs yet — enable a trigger"), no project memory (Shared still lists Home's two
  facts).

### Home "Needs you" fixture (M13)

Additions only:
- `widget-lib` has a status report **three days old**, so the root Home's Needs you
  shows "Status report 3d old" on its group (`acme-site`'s is fresh, the control).
- `widget-lib` has an **enabled** `wake` trigger (cron 03:00 on 1 January, so it
  never fires by itself) whose prompt records one `#wake` episode on
  `burn-down-issues`. Answering `widget-lib`'s ask from Home with "Wake the manager
  now" on therefore fires a real run (fake `claude`) that shows on `widget-lib`'s
  Home. It is the first enabled `wake` in the rig: the answer form's disabled
  switch and its reason are now on `acme-site` ("the wake trigger is disabled") and
  Home ("no wake trigger").
- With the seed as is, `/` shows three groups — `acme-site` (2 asks, the
  `stale:publish-check` warning), `widget-lib` (1 ask, 1 unreadable task file,
  the stale hint) and Home (1 ask) — and "4 asks · 1 alert — 6 projects checked".
- **Per-project error.** The rig runs as root, so `chmod 000` on a task directory
  changes nothing (root reads it anyway), and the stores treat ENOENT/ENOTDIR as
  "no tasks yet". Make a directory unreadable with a self-referencing symlink
  instead, and remove it afterwards:
  `mkdir -p <rig>/data/projects/broken-conn/tasks && ln -s open <rig>/data/projects/broken-conn/tasks/open`
  (ELOOP). `broken-conn`'s group then shows an error row and the others render.

### Consolidation fixture (M14)

Additions only. Consolidation **ships off** everywhere, the rig included.
- `acme-site`'s `project.yaml` has `behaviours.consolidate-memory.config.promptFile:
  consolidate.md` and **no** `enabled`. Switch it on in Settings → Behaviours; the
  Memory tab then shows "Run consolidation now".
- `.managers/triggers/consolidate.md` calls `memory_op add qa-pattern` (a
  `pattern`) citing two REAL seeded journal entries (`…-af`, `…-aj` in
  `blog-cadence`), so a run writes `memory/facts/qa-pattern.md`, regenerates
  `memory/MEMORY.md` under the marker (the "Acme Site memory" preamble stays) and
  ends with a server-written `#reflection` episode in `log/`.
- `.managers/triggers/consolidate-one-evidence.md` is the unhappy path (a pattern
  with ONE evidence id): copy it over `consolidate.md` in the rig and run again —
  the Memory op tool block is an error and nothing is written.
- `acme-site`'s disabled `memory-wake` trigger calls `memory_op` from a wake: Run
  now shows the "not available in this turn" error.
- Ed's own chat message may call `memory_op` (the fake `claude` runs a
  `[[MCP managers.memory_op …]]` typed in the composer); a wake or a replay of
  that chat may not.
- The rig's scheduler reports no `nextRunAt` for any schedule, so "armed" is read
  from the keeper's `schedules` (or `/managers/consolidation` `enabled`).

Keep the fixtures synthetic, with no real names, hosts or paths. Keep
`empty-project` empty: it is the empty-state fixture.

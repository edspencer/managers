<h1 align="center">Managers</h1>

<p align="center">
  <strong>Scheduled, per-project manager agents that keep track of your long-running objectives.</strong><br/>
  A fork of <a href="https://github.com/edspencer/paddock">Paddock</a>, built on <a href="https://github.com/edspencer/herdctl">herdctl</a>.
</p>

<p align="center">
  <a href="https://github.com/edspencer/managers/actions/workflows/ci.yml"><img src="https://github.com/edspencer/managers/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/edspencer/herdctl"><img src="https://img.shields.io/badge/built%20on-herdctl-c2603c" alt="Built on herdctl"></a>
  <a href="AI-DECLARATION.md"><img src="https://img.shields.io/badge/AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2" alt="AI-DECLARATION: copilot"></a>
</p>

> **Status: v1, early.** Expect breaking changes. Releases (from 0.2.0) ship as an
> npm package and a multi-arch container image; see [Install](#install) and
> [`RELEASING.md`](RELEASING.md).

## What it is

Managers gives each of your projects a **manager**: a Claude Code agent that wakes
on a schedule, reads where things stand, works on the project's objectives, and
writes down what it did and what it needs from you. There is no master manager.
Each project owns its own state, and a **Home** workspace (the instance root)
holds anything shared across projects.

A manager's state is plain Markdown and YAML files in a git-tracked data
directory, not a database. You can read and edit all of it by hand, and the
managers' writes are committed to that repo. It stays local unless you turn on
`MANAGERS_DATA_SYNC=1`, which pulls and pushes it to its `origin` remote.

Managers is a fork of Paddock, so it keeps Paddock's machinery: projects, many
Claude Code chats per project, triggers (schedules and events), a web UI, and
post-turn curation of each project's `OVERVIEW.md` and `CHANGELOG.md`. On top of
that it adds the manager layer described below.

## Core concepts

- **Objectives** (`objectives/<id>/objective.md`): a long-running goal with a
  "where we are" summary and an append-only, dated **journal** of what happened.
- **Tasks** (`tasks/open/<id>.md`, moved to `tasks/done/YYYY-MM/` when closed):
  one Markdown file each. A task with status `awaiting-ed` is a question for you
  (the code calls the human "Ed"); you answer it in the UI, and can wake the
  manager straight away.
- **Memory**: episodic entries (the journals and the project `log/`) and semantic
  **facts** (`memory/facts/`) that cite the episodes they came from. Home's memory
  is shared with every project. A **consolidation** run, off by default, distils
  episodes into facts; facts are superseded, never deleted.
- **Runs**: every trigger fire writes a run record (`runs/YYYY-MM/<id>.yaml`) with
  its outcome, what it wrote, and an optional expectation (for example "records an
  episode within 48h"). Failed runs, missing artifacts, stale schedules and stuck
  runs raise **alerts**.
- **The wake briefing**: before a scheduled turn, the server assembles what the
  manager sees (its protocol, memory, objectives, open tasks, your answers, recent
  runs, alerts), with a size budget per section. Each run keeps a copy.
- **Reports**: a `status` report per workspace ("in flight, and what needs you"),
  regenerated on a schedule or on demand with the previous report in view. Its
  "Needs you" and "Alerts" sections are rendered live from tasks and alerts.
- **Behaviours**: named capabilities (triggers and tools) declared in
  `project.yaml`. **Everything is off by default, and off means it does not
  happen at all.** You switch a behaviour on per project in Settings; the switch
  is logged and committed.
- **Connections**: per-project MCP servers in `project.yaml` `mcp:`, such as that
  project's Paddock deployment. Secrets come from environment variables
  (`env:VAR`), never from the file. This is how a manager orchestrates Paddock
  agents: over Paddock's `/mcp` (`create_chat`, `send_message`, `read_chat`, …),
  limited to the tools you list.
- **Home's "Needs you"**: one page collating every workspace's questions, alerts
  and stale reports.

```yaml
# project.yaml (excerpt)
mcp:
  paddock:
    url: https://paddock.example.com/mcp
    headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_MYPROJECT" }
    tools: [list_chats, read_chat, create_chat]
behaviours:
  triage-external-prs:
    description: Dispatch triage of outside PRs to Paddock.
    triggers: [triage-prs]
    tools: [mcp__paddock__create_chat]
    # no `enabled: true`, so it is off
reports:
  status:
    enabled: true
    schedule: { cron: "0 7 * * 1-5" }
```

## Install

**On a laptop** (Node 22+):

```bash
npx @edspencer/managers            # or: npm i -g @edspencer/managers && managers
# open http://127.0.0.1:7234
```

The `managers` command binds `127.0.0.1` with authentication off, which it
allows on a loopback bind only, and the UI shows a banner saying what that
means (see [Security](#security)).

**On a server, VM or LXC** (linux/amd64 or arm64):

```bash
docker run -d --name managers -p 127.0.0.1:7234:7234 -v /srv/managers-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e MANAGERS_AUTH_MODE=jwt -e MANAGERS_AUTH_JWKS_URL=... \
  -e MANAGERS_AUTH_JWT_ISSUER=... -e MANAGERS_AUTH_JWT_AUDIENCE=... \
  ghcr.io/edspencer/managers:latest      # :devbox adds the coding-agent toolbox
```

Each GitHub Release also carries a self-contained tarball.

## Quick start from a checkout

You need **Node 22+**. Build once:

```bash
git clone https://github.com/edspencer/managers.git && cd managers
NODE_ENV=development npm install --include=dev
npm run build
```

`scripts/clean-env.sh <cmd>` runs a command with every inherited `PADDOCK_*` and
`MANAGERS_*` variable, `NODE_ENV` and Claude credential removed. Use it for tests
and builds if your shell also runs a real Paddock or Managers.

### 1. The credential-free rig (no Claude, no API calls)

This seeds a synthetic instance (Home plus five projects with objectives, tasks,
memory, runs, reports and chats) and serves it with a fake `claude` binary.
Nothing calls Anthropic.

```bash
RIG="$(mktemp -d)"
node scripts/managers-rig/seed.mjs --out "$RIG"
node scripts/managers-rig/serve.mjs --data "$RIG/data" --home "$RIG/home" --port 7300
# open http://127.0.0.1:7300
```

The rig runs with authentication off and in batch drive mode (both opted in), so
the UI shows red security banners. That is by design. See
[`scripts/managers-rig/README.md`](scripts/managers-rig/README.md) for the fixtures.

### 2. With real Claude

Managers runs Claude Code with your credentials: a `claude` login on the host,
or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the server's environment.
The `claude` CLI must be on `PATH` for the sweeper and the CLI runtime. **Real
turns spend real credit.**

A local, single-user trial on loopback:

```bash
export MANAGERS_DATA_DIR="$HOME/managers-data"   # a new, empty directory
export MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1      # read "Security" below first
node packages/server/dist/cli/managers.js        # http://127.0.0.1:7234
```

To back the data directory with a git remote (e.g. a private GitHub repo), clone
the **empty** repo to the data directory's `projects/` (or `MANAGERS_PROJECTS_DIR`)
before first boot. Managers claims it, commits its skeleton, and with
`MANAGERS_DATA_SYNC=1` runs `git pull --rebase --autostash` then `git push` every
`MANAGERS_DATA_SYNC_INTERVAL` (default `10m`) and after each run. It uses the
process's ordinary git credentials (a deploy key, a credential helper) and never
force-pushes; a conflicting pull is aborted and shows as a `data-sync-failed`
alert on Home.

A new project is seeded with a `wake` trigger that is **disabled**. Enable it in
the project's Triggers tab when you want its manager to run on a schedule.

For anything else, put Managers behind an SSO proxy and use `jwt` mode (below).
The deeper configuration reference is Paddock's
[environment reference](https://paddock.edspencer.net/configuration/environment/)
(read `PADDOCK_` as `MANAGERS_`), plus [`.env.example`](.env.example).

## Security

Managers runs agents with Bash on your machine, using your Claude login. Read
[`AUTH.md`](AUTH.md) before running it anywhere but a throwaway rig.

- **Run it in its own container or VM**, with no source checkouts and only
  narrowly scoped tokens. Isolation comes from what the container can reach, not
  from removing tools.
- **Auth modes**: `none` (the default), `trusted-header` or `jwt`. With `none`,
  any agent on the host can call the API as you, so **boot refuses `none`**
  unless `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1`. The one exception is the
  `managers` command on a loopback bind (the `npx` laptop case), which allows it
  and shows the banner; `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=0` makes it refuse. `jwt` needs both
  `MANAGERS_AUTH_JWT_ISSUER` and `MANAGERS_AUTH_JWT_AUDIENCE` (or
  `MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE=1`). `trusted-header` is allowed but
  warned about. Use `jwt` behind an SSO proxy for a real install.
- **Drive modes**: `session` (the default) runs turns on the Claude Agent SDK.
  `batch` runs one-shot `claude -p` and serves each turn's injected tools over an
  unauthenticated local HTTP bridge (Managers binds it to `127.0.0.1`), so
  **boot refuses `batch`** unless `MANAGERS_ALLOW_BATCH_DRIVE=1`.
- Every opted-in danger is logged at boot as `SECURITY:`, listed by
  `GET /api/security`, and shown as a banner on every page.
- The server binds `127.0.0.1` by default, and refuses a routable interface with
  no auth unless `MANAGERS_DANGEROUSLY_ALLOW_OPEN=1`.
- The data directory must be empty or already carry the `.managers-data`
  marker, so an existing directory of other data is refused. A fresh `git clone`
  of an empty repo (only `.git/`) counts as empty.

## Development

```bash
scripts/clean-env.sh npm run typecheck
scripts/clean-env.sh npm test              # server + web; fake claude, no API calls
scripts/clean-env.sh npm run build
scripts/clean-env.sh npx playwright install chromium
scripts/clean-env.sh npm run test:e2e      # browser journeys against the built app
```

[`CLAUDE.md`](CLAUDE.md) is the map of what Managers changed and where it lives.
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`DEV.md`](DEV.md) are inherited from
Paddock and still describe this code. `docs/` is frozen Paddock material.

## Forked from Paddock

Managers started as a fork of [Paddock](https://github.com/edspencer/paddock)
v0.74.1 and keeps its full history. It diverges freely: Paddock ideas are ported
across by hand, not merged. The environment variables (`MANAGERS_*`), the CLI
(`managers`), the data dir (`~/.managers`), the config file
(`managers.config.yaml`) and the default port (7234) are renamed, so it can run
beside a Paddock. Some internal names still say `paddock`, and inherited docs and
comments say "Paddock" where they mean this code.

## License

[MIT](LICENSE), covering both the Paddock code and the Managers additions.

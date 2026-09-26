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
| `fixtures.mjs` | The synthetic world: Home (the root workspace) plus `acme-site`, `widget-lib` and `empty-project`, with their files, triggers and chats. **Later milestones add fixtures here, as data.** Never remove one an earlier milestone's QA relies on. |
| `seed.mjs` | `--out <dir> [--now <ISO>]`. Writes `<dir>/data` (a complete `MANAGERS_DATA_DIR`: the `.managers-data` marker, a projects root `git init`ed with one clean commit, chats, job records, read state, provenance), `<dir>/home`, `fake-script.json` and `manifest.json`. Times are relative to the wall clock; `--now` is only for screenshot determinism. |
| `serve.mjs` | `--data <dir>/data --port <N> [--home <dir>/home]`. Boots `packages/server/dist` with `rigEnv` (below) and forwards SIGTERM/SIGINT/SIGHUP to it. Importable: `startServer`, `rigEnv`. |
| `leak-check.mjs` | `--out <scratch> [--port <N>]`. The isolation proof; see below. |
| `lib/transcript.mjs` | Builders for Claude Code transcript lines (forked from the demo rig). |

`rigEnv` deletes every `PADDOCK_*` / `MANAGERS_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `NODE_ENV` it inherits, then sets:

- `HOME` to the rig home, and `test/bin` first on `PATH` (the fake `claude`);
- `HOST=127.0.0.1` (forced), `PORT`;
- `MANAGERS_DATA_DIR`, `MANAGERS_PROJECTS_DIR`, `MANAGERS_WEB_DIST`;
- `MANAGERS_DRIVE_MODE=batch`, `MANAGERS_AUTH_MODE=none`;
- `MANAGERS_SELF_MCP=1`, so keeper and trigger turns get the `managers` self-MCP
  (the target of `[[MCP managers.*]]`);
- `MANAGERS_SWEEP_MIN_INTERVAL_MS=999999999` (the sweeper would rewrite seeded files).
  The interval counts from the last sweep, and a never-swept project counts as swept
  at epoch 0, so `seed.mjs` also writes `sweep-state.json` stamping every workspace
  as swept at seed time. Without it, the first turn in each project rewrites its
  seeded `OVERVIEW.md`/`CHANGELOG.md` and adds a `CLAUDE.md`;
- `MANAGERS_FAKE_SCRIPT=<rig>/fake-script.json`, and
  `MANAGERS_FAKE_INVOCATION_LOG=<rig>/invocations.jsonl` (one line per fake-claude
  spawn, including its `--mcp-config` and `paddockEnvCount`, a count and never names).

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
```

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
- chats go in `chats: [{ label, prompt, reply, hoursAgo, unread?, origin?, tool? }]`.

Keep the fixtures synthetic, with no real names, hosts or paths. Keep
`empty-project` empty: it is the empty-state fixture.

# `docs/` — what is actually in here

**This directory is frozen material inherited from Paddock.** Managers does not
maintain it. Paddock's documentation site,
**[paddock.edspencer.net](https://paddock.edspencer.net)** (source in
[edspencer/paddock](https://github.com/edspencer/paddock/tree/main/website/src/content/docs)),
is the reference for the inherited machinery; read `PADDOCK_` there as
`MANAGERS_`. The Managers-specific concepts are in the root
[`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md) and [`AUTH.md`](../AUTH.md).

This directory is **not** one thing. It is three, and the difference matters
because part of it is stale enough to break a server if you follow it:

## 1. Superseded forks — do not read, do not patch

Each of these has a maintained twin on the website and carries a warning banner
pointing at it. They are kept only because other files still link to them.

| Stale fork | Read instead |
|---|---|
| `ARCHITECTURE.md` | [Architecture overview](https://paddock.edspencer.net/architecture/overview/) |
| `CONFIGURATION.md` | [Environment variables](https://paddock.edspencer.net/configuration/environment/) |
| `API.md` | [REST + WebSocket API](https://paddock.edspencer.net/reference/api/) |
| `INTEGRATION.md` | [herdctl integration](https://paddock.edspencer.net/architecture/herdctl-integration/) |
| `TESTING.md` | [Testing](https://paddock.edspencer.net/contributing/testing/) |
| `concepts/` | [Concepts](https://paddock.edspencer.net/concepts/) |

They are not updated against releases, and they have been wrong in ways that
cost real time — until #691 was reflected here they told readers to set
`CLAUDE_HOME=$HOME/.claude`, a variable that no longer exists and a value that
now makes Paddock **refuse to boot**. If you find something else wrong in one of
them, it is Paddock's upstream docs that are maintained, not these.

## 2. Originals that live here permanently

These have **no** website twin. Each is a
**point-in-time** record — accurate when written, deliberately not tracked
against later releases.

- `DESIGN-backing-store.md` — the approved git + NAS backing-store design.
- `DESIGN-testing.md` — why the test strategy stubs the LLM and nothing else.
- `HISTORY.md` — the original build journal (formerly `JOURNAL.md`).
- `archive/CONTRACT-v2.md`, `archive/CONTRACT-v3.md` — archived wire contracts.

## 3. Live assets

- `demo/` — Paddock's demo GIF frames and script (they show Paddock, not
  Managers). The path is hard-coded in
  [`scripts/demo-gif/make.mjs`](../scripts/demo-gif/make.mjs).
- `screenshots/` — historical UI captures. Nothing *renders* them, but
  `HISTORY.md` names specific files here nine times as the record of what each
  milestone captured, so they are not free to delete.

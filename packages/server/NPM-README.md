# Managers

**Scheduled, per-project manager agents that keep track of your long-running
objectives.** Each project gets a manager: a Claude Code agent that wakes on a
schedule, reads where things stand, works on the project's objectives, and writes
down what it did and what it needs from you. Its state is plain Markdown and YAML
in a git-tracked data directory. A fork of
[Paddock](https://github.com/edspencer/paddock), built on
[herdctl](https://github.com/edspencer/herdctl).

```sh
npx @edspencer/managers
```

Then open <http://127.0.0.1:7234>.

> **First run downloads ~250 MB.** Managers drives Claude Code, and the Claude
> Agent SDK ships a per-platform binary of that size. It cannot be skipped:
> installing with `--omit=optional` produces a Managers whose chats all fail.
> Later runs reuse the npm cache. For repeated use, `npm i -g @edspencer/managers`
> and then `managers` is friendlier than bare `npx`.

**Real turns spend real Claude credit.** Every behaviour (scheduled wakes,
reports, memory consolidation) is off until you switch it on in the UI.

## Credentials

Managers runs Claude Code on your behalf, so it needs Claude credentials. **If you
already use Claude Code on this machine, there is nothing to do:** it uses the
login you already have (the macOS Keychain entry on a Mac, or
`~/.claude/.credentials.json` elsewhere), read, never copied. Otherwise:

```sh
claude setup-token                  # Claude Max/Pro
export ANTHROPIC_API_KEY=sk-ant-…   # or API billing
```

Managers keeps its own Claude home under the data dir, so its transcripts never
mix with yours.

## Security

The `managers` command binds **127.0.0.1** and runs with **authentication off**,
so nothing off this machine can reach it. Processes **on** this machine can, and
that includes the agents Managers runs: with no auth, an agent's Bash can call
the API as you. The UI shows a permanent banner saying so.

- To close that, use `MANAGERS_AUTH_MODE=jwt` behind your identity provider (see
  [AUTH.md](https://github.com/edspencer/managers/blob/main/AUTH.md)).
- To make the command refuse to start without auth, set
  `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=0`.
- It **refuses to start** if you bind a routable interface (`--host 0.0.0.0`)
  with auth off. Configure `MANAGERS_AUTH_MODE` first.

## Options

```
  -p, --port <port>       HTTP/WS port (default 7234)
      --host <host>       Bind address (default 127.0.0.1)
  -d, --data-dir <path>   Projects + state (default ~/.managers)
  -o, --open              Open the app in your browser once it is listening
      --verbose           Show the server's own logs (quiet by default)
  -v, --version           Print the version
  -h, --help              Show help
```

`managers service install` keeps it running in the background from login
(launchd on macOS, a systemd user unit on Linux; it refuses to install from the
`npx` cache, so `npm i -g` first). `managers config show --resolved` prints every
effective setting and where it came from.

Your projects, objectives, tasks, memory, chats and settings persist in
`~/.managers`, or wherever `--data-dir` points. It is one directory, and the
projects inside it are a git repository the managers commit to. Move it to move
your instance; delete it to start over.

## Requirements

Node.js 22 or newer.

## Other ways to run it

A multi-arch (amd64 + arm64) Docker image is published alongside this package,
and is the better fit for a server, a VM or an LXC:

```sh
docker run -d --name managers -p 127.0.0.1:7234:7234 -v managers-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  -e MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1 \
  -e MANAGERS_DANGEROUSLY_ALLOW_OPEN=1 \
  ghcr.io/edspencer/managers:latest
```

The image binds `0.0.0.0` inside the container, so with auth off it needs both
opt-ins, and publishing on `127.0.0.1:` is what keeps that private. For anything
reachable from a network, use `MANAGERS_AUTH_MODE=jwt` instead (see AUTH.md).

## Links

- [Repository and documentation](https://github.com/edspencer/managers#readme)
- [Issues](https://github.com/edspencer/managers/issues)

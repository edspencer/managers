---
"@managers/server": minor
---

Align the `managers` CLI with the CLI contract (SPEC 0.2)

`serve` is now the name for running in the foreground, `/api/health` reports the
version it is running, `service status` answers in scriptable exit codes and
`--json`, there is a `service logs`, and the generated units are hardened. Ported
from Paddock 0.80–0.82, whose CLI this is.

**Behaviour changes a script can see.** These are why this is a minor:

- **Usage errors now exit `2`, not `1`.** An unknown command, flag or bad value
  exits 2 and prints a short usage synopsis after the message. `1` now means only
  that something genuinely failed.
- **`service status` now exits `3` or `4`.** `0` when installed, running and
  answering; `3` when installed but not running, or running and not answering;
  `4` when there is no unit. `service logs`, `start`, `stop` and `restart` exit
  `4` with no unit too.
- **An `install`, `start` or `restart` that never answers now exits `1`**, not 0.
- **Linux service logs go to a file, not the journal.** Both streams append to
  `<data-dir>/logs/service.log` (the path macOS already used, now one file rather
  than two), which Managers rotates itself at 8 MB, keeping three generations.
  An existing unit keeps the path it names until `managers service install` is
  re-run.
- **The server's logs now go to stderr, not stdout**, so `serve`'s first stdout
  line is `Managers <version>: <url>`. Docker, Kubernetes and the service units
  collect both streams; a log shipper reading stdout ALONE is the one thing that
  changes.

Everything else is additive:

- `managers serve` runs the server; **`managers start` stays an alias, for good.**
- `GET /api/health` answers `{ ok, version }`, with no auth.
- `managers service status --json`: installed / running / answering, the
  installed and running versions, port, URL, pid, unit, log file and warnings.
- `managers service logs [-f] [-n <lines>]`, the last 50 lines by default.
- The main `--help` lists all seven `service` actions.
- Generated units: Node resolved through symlinks, a `PATH` without per-session
  entries or missing directories, every systemd `ExecStart` word quoted, and
  warnings for a vanished Node, a running-vs-installed version gap and (Linux)
  lingering being off, which is now checked rather than printed at everyone.
- **macOS:** `install`, `start` and `restart` no longer lose a race with launchd
  (`Bootstrap failed: 5: Input/output error`): they wait for a bootout to finish,
  and retry a bootstrap that returns launchd's race codes 5 or 37.
- **Linux:** a reinstall over a RUNNING service now restarts it.
  `systemctl --user enable --now` does nothing to an active unit, so the old
  process went on serving the old code.

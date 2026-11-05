---
"@managers/server": minor
---

`managers update`, `managers doctor`, and `service install --refresh`

Wave F3 of the CLI-contract rollout (edspencer/cli-contract SPEC 0.2), ported from Paddock 0.82 and the contract's `reference/`.

**New: `managers update [--check] [--to <version|tag>] [--yes] [--force] [--json]`** (`upgrade` is a hidden alias). It asks the registry, checks the running instance is not busy, stops the service, installs with the package manager this copy came from, hands over to the new CLI to rewrite the unit, waits for `/api/health` to report the new version, and **rolls back** if it doesn't. Exit codes a script can see: **5** this install can't update itself (a checkout, npx, a container, or a managed install: the right command is printed), **6** the update failed and the old version is running again, **7** it failed and could not be rolled back, **75** busy, **2** no terminal and no `--yes`. `--check` exits 0 whether or not there is an update; read `updateAvailable` from `--json`. Nothing contacts the registry on its own.

**New: `managers doctor [--json] [--offline]`.** SPEC §1's eight checks (Node against `engines`, the install method, the unit, the running version, the port, linger, the data dir, a newer version), then Managers' own: the configuration loads, and **the security posture `/api/security` reports** (no authentication, trusted-header, any-audience JWTs, batch drive mode), asked of the running instance or computed from this shell's configuration by the server's own rule. Exits 1 if any check failed.

**New: `managers service install --refresh`** re-renders an existing unit from the settings it records (port, host, data dir), and exits 4 with nothing installed. `service status` repeats what the last `update --check` or `doctor` found (`update` in `--json`, absent rather than null when there's nothing). `service start` and `restart` run `systemctl --user reset-failed` first. A first `service install` that launchd or systemd refuses no longer leaves a unit behind (so `status` doesn't report it installed); a refused reinstall keeps the unit it had.

**The image** sets `MANAGERS_IN_DOCKER=1` and puts `managers` on `PATH`, so `docker exec <container> managers busy` works as a pre-update hook and `managers update` inside it prints the image to pull and exits 5. Set `MANAGERS_UPDATE_HINT` to have `update` print your own upgrade command instead (for a container or install managed by Ansible, say).

`--check`, `--to`, `--yes`, `--refresh` and `--offline` exit 2 on commands that can't act on them. See UPDATING.md.

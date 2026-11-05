---
"@managers/server": minor
---

`managers busy`, `GET /api/busy`, a `service stop` that refuses when Managers is mid-turn, and a SIGTERM that finishes or records the work under way

Wave F2 of the CLI-contract rollout (edspencer/cli-contract SPEC 0.2, §4), ported from Paddock 0.81.

**New: `managers busy [--json]`.** Asks the running instance whether it is in the
middle of something a restart would lose. It exits **0** not busy, **75** busy,
**3** when nothing answers, and **1** when something answered but not as
Managers' busy check. 75 is `EX_TEMPFAIL`, which Watchtower's
`lifecycle.pre-update` hook reads as "skip this one".

**`service stop` and `service restart` now run that check first and refuse with
exit 75 unless `--force` is given.** A script that stops Managers unconditionally
needs `--force`, or needs to handle 75: that is the behaviour change in this
release. `service uninstall` and `service start` don't check. A forced stop
prints the message it would have refused with, prefixed `Overriding:`.
**`--force` anywhere else is now a usage error (exit 2)** rather than being
silently ignored. When the busy work is chat turns, the refusal says to run the
command from a terminal rather than from inside a Managers chat.

**New: `GET /api/busy`**, answering `{ busy, version, counts }` with four counts:
`chat` (chat turns running, triggers and schedules included), `background`
(background tasks a live session still holds after its turn), `job` (herdctl
scheduler jobs) and **`run`** (Managers trigger runs in flight: from the moment a
fire writes its `running` record until that record is finished and committed,
which is wider than the turn at both ends). No authentication, because it
carries counts and nothing else; in-memory state only.

**New: `<data-dir>/runtime.json`**, written 0600 once the server is listening and
removed when it stops, holding `{ pid, port, url, version, startedAt }`.

**SIGTERM now finishes or records the work under way, instead of closing at
once.** If chat turns or trigger runs are in flight, a stop waits up to 8 seconds
for them to end by themselves; whatever is left is recorded — each trigger run's
record is finished as `failed`, `error: interrupted by shutdown` (through its own
completion hook, so a consolidation still gets its `#reflection` episode and the
record is committed), and the log names what was cut short. An idle instance
stops at once. Signals are idempotent and the whole stop is bounded at 15
seconds, inside launchd's 20-second kill budget. Under Docker, whose default
`docker stop` timeout is 10 seconds, give the container a `stop_grace_period` of
at least 20 seconds to let the wait run.

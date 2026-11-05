/**
 * Process lifecycle for a Managers server: bind the port, publish
 * `runtime.json`, and wire signal-driven shutdown. Split out of `index.ts` so
 * the `managers` CLI (src/cli/managers.ts) and the plain `node dist/index.js`
 * entrypoint share one implementation.
 *
 * Config is resolved INSIDE `buildApp()`, not at module load, so a caller may
 * still mutate `process.env` right up until this function is invoked. The CLI
 * depends on that to apply its own defaults (e.g. a data dir under $HOME).
 */
import { buildApp } from "./app.js";
import { describeScrub, scrubInheritedEnv } from "./env-scrub.js";
import { applyRuntimeEnv } from "./managers/claude-overlay.js";
import { describeSequester, sequesterMcpSecrets } from "./managers/mcp-secret-env.js";
import { startServiceLogRotation } from "./service-log.js";
import { removeRuntimeFile, writeRuntimeFile } from "./runtime-file.js";
import { MANAGERS_VERSION } from "./version.js";
import { describeShutdown, describeShutdownStart, drainInFlight, recordInterruptedRuns } from "./shutdown-drain.js";
import { INTERRUPTED_BY_SHUTDOWN } from "./managers/trigger-runs.js";

/**
 * How long a clean shutdown gets before we exit anyway.
 *
 * The CLI contract requires the SIGTERM path to exit "within the unit's stop
 * timeout" (SPEC §4, §8), and the tightest of those is **launchd's**: with no
 * `ExitTimeOut` in the plist, a LaunchAgent gets 20 seconds before SIGKILL
 * (systemd's user default is 90). So the budget is 20 seconds, and this sits
 * inside it with room for the exit itself.
 *
 * The deadline matters because the two awaits below are not bounded by anything
 * else. `app.close()` waits for in-flight requests and open WebSockets, and a
 * browser holding `/ws` is the normal state of a running Managers; `fleet.stop()`
 * talks to subprocesses. Exceeding the budget is strictly worse than exiting at
 * it: SIGKILL skips the rest of this function, so the runtime file would be left
 * behind for the next instance's `busy` to find and the log would have no record
 * of what was cut short.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

/**
 * The URL to record in `runtime.json` — the one a CLI on this machine can
 * actually fetch, which is not always the one we bound.
 *
 * A wildcard bind is the normal case for a container or a dev box (`HOST=0.0.0.0`
 * is what this repo's own `pm` wrapper injects), and `http://0.0.0.0:<port>` is
 * not an address to connect TO. Node happens to resolve it to loopback on Linux
 * and fails on some other stacks, so the file records loopback explicitly rather
 * than relying on that. A real interface address is left alone: someone who
 * bound `192.168.1.10` meant it, and that address reaches the server from here
 * as well as from anywhere else.
 *
 * IPv6 gets brackets, because `new URL('http://::1:7234')` is not a URL.
 */
export function runtimeUrl(host: string, port: number): string {
  const loopback: Record<string, string> = {
    "0.0.0.0": "127.0.0.1",
    "::": "::1",
    "": "127.0.0.1",
  };
  const h = loopback[host] ?? host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${String(port)}`;
}

export interface StartOptions {
  /**
   * Allow `MANAGERS_AUTH_MODE=none` without `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH`
   * when, and only when, the resolved bind host is loopback. Set by the
   * `managers` CLI (laptop first run); see boot-posture.ts. Never an env var, so
   * no child process can inherit it.
   */
  loopbackNoAuth?: boolean;
}

export async function start(opts: StartOptions = {}): Promise<void> {
  // FIRST, before any config is resolved or any child can be spawned: drop every
  // inherited `PADDOCK_*` variable so none of them reaches a keeper, sweeper or
  // trigger subprocess (see env-scrub.ts). Only the count is logged.
  const scrubbed = scrubInheritedEnv();
  // Managers M9.5: MCP credentials (`MANAGERS_MCP_*`) leave process.env too, so
  // no keeper/trigger/sweeper child inherits another project's token; the MCP
  // resolvers read them from the private map (managers/mcp-secret-env.ts).
  const sequestered = sequesterMcpSecrets();
  // Managers M3: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, process-wide, so every
  // keeper/trigger/sweeper child inherits it (belt-and-braces with the
  // `autoMemoryEnabled: false` in the generated settings.json).
  applyRuntimeEnv();
  const { app, cfg, close, hub, managers } = await buildApp({ loopbackNoAuth: opts.loopbackNoAuth === true });
  // warn, not info, when anything was removed: it means this process was started
  // from a shell configured for Paddock, which is worth seeing even at LOG_LEVEL=warn.
  if (scrubbed > 0) app.log.warn({ scrubbedEnvVars: scrubbed }, describeScrub(scrubbed));
  else app.log.info({ scrubbedEnvVars: 0 }, describeScrub(0));
  app.log.info({ sequesteredMcpVars: sequestered }, describeSequester(sequestered));

  // Nothing else rotates the service log: the supervisor appends to it through
  // its own descriptor, a `systemd --user` unit writing to a file gets no
  // journal rotation, and macOS has nothing that would (SPEC §7). A no-op on a
  // foreground run, where that file does not exist — see service-log.ts.
  const stopRotation = startServiceLogRotation(cfg.dataDir, {
    warn: (message) => {
      app.log.warn(message);
    },
  });

  /**
   * Exit on SIGTERM/SIGINT having finished or recorded the work under way
   * (SPEC §4, §8).
   *
   * Three things are deliberate here.
   *
   * **It waits briefly, then records.** A chat turn is a `claude` subprocess
   * that can run for minutes; no 20-second stop timeout can wait for one, and
   * `herdctl.stop()` ends the fleet with `waitForJobs: false` precisely because
   * waiting is not an option. So in-flight turns and trigger runs get a short,
   * bounded window to end by themselves (shutdown-drain.ts), and whatever is
   * left is recorded: each trigger run's record is finished as failed,
   * "interrupted by shutdown", and the count goes in this `warn` line in the
   * service log, the one artefact that survives the restart and which
   * `managers service logs` reads. What is NOT done, and should not be, is
   * writing a note into the cut-short chat's transcript: `claude` owns that file
   * and may append to it after we are gone, so a server-side write cannot be
   * ordered against the subprocess's own and would be the resurrection race
   * `turn-interlock.ts` exists to avoid.
   *
   * The reason a count is enough: `/api/busy` reports the same numbers BEFORE
   * the stop, and `managers service stop` refuses on them. The log line is for
   * the race §4 admits — work that started between the check and the signal.
   *
   * **It is idempotent.** A supervisor that sends SIGTERM twice, or a Ctrl-C
   * after a SIGTERM, used to re-enter `close()` concurrently: a second
   * `app.close()` on a closing Fastify rejects, and a second `fleet.stop()`
   * races the first. The guard makes the extra signals no-ops.
   *
   * **It exits 0.** The unit's `Restart=always` / `KeepAlive` means the
   * supervisor brings Managers back whatever the code; 0 is what makes a logout
   * or a `service stop` read as a clean stop rather than a crash in the logs.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = Date.now();
    stopRotation();
    // Published once we were listening; removed here so a `busy` or a
    // `service status` run after this exit does not find a live-looking
    // instance. Before the slow awaits, because this is the part that must land
    // even if they overrun the deadline below.
    removeRuntimeFile(cfg.dataDir);
    // Finish, then record (shutdown-drain.ts). An idle instance skips the wait.
    // What is in flight is logged first, so a supervisor that kills sooner than
    // the wait still leaves the record.
    const inFlight = () => ({ turns: hub.runningSessions().length, runs: managers.liveRuns.size });
    const starting = describeShutdownStart(signal, inFlight());
    if (starting !== undefined) app.log.warn(starting);
    const drained = await drainInFlight(inFlight);
    const recorded = await recordInterruptedRuns(managers.liveRuns, INTERRUPTED_BY_SHUTDOWN);
    app.log.warn(describeShutdown(signal, drained, recorded));
    // Bounded: see SHUTDOWN_DEADLINE_MS, which the wait above counts against.
    // `exit(0)` either way, so a hung `app.close()` cannot turn a stop into a
    // SIGKILL.
    const left = Math.max(1_000, SHUTDOWN_DEADLINE_MS - (Date.now() - startedAt));
    await Promise.race([close(), new Promise((r) => setTimeout(r, left))]).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: cfg.port, host: cfg.host });

  // `<dataDir>/runtime.json`, 0600, written only once we are actually listening
  // (SPEC §4) — it is how `managers busy`, and later `update`, find THIS instance
  // without guessing a port. A failure to write it is logged and not fatal: the
  // server is up and serving, and the one thing that stops working is a CLI
  // finding it, which is better than refusing to run.
  try {
    writeRuntimeFile(cfg.dataDir, {
      pid: process.pid,
      port: cfg.port,
      url: runtimeUrl(cfg.host, cfg.port),
      version: MANAGERS_VERSION,
    });
  } catch (err) {
    app.log.warn(
      `could not write ${cfg.dataDir}/runtime.json (${(err as Error).message}) — ` +
        "`managers busy` will report this instance as not running",
    );
  }

  app.log.info(`managers-server listening on http://${cfg.host}:${cfg.port}`);
}

/**
 * The first half of a clean stop (CLI contract SPEC §4, §8): **finish or record
 * the work under way**, inside the unit's stop timeout.
 *
 * Paddock's SIGTERM only records — it logs how many chat turns it is cutting
 * short and closes at once. Managers does a little better, in two steps:
 *
 *  1. **Let it finish, briefly.** If a chat turn or a trigger run is in flight,
 *     wait up to {@link SHUTDOWN_DRAIN_MS} for it to end on its own. Many do: a
 *     scheduled wake that is writing its last episode, a report being composed,
 *     a run whose turn has ended and whose record is being committed. An idle
 *     instance does not wait at all, so a stop with nothing running is as quick
 *     as it ever was.
 *  2. **Record what is left.** Every trigger run still in flight is finished as
 *     `failed`, `error: interrupted by shutdown` — through the run's own
 *     completion hook, so `expect` is evaluated, a consolidation still gets its
 *     `#reflection` episode, and the record is committed — rather than sitting
 *     `running` until the next boot calls it "interrupted by restart". A chat
 *     turn has no record of its own to write (its transcript belongs to `claude`,
 *     which may still append to it), so it is recorded by the count in the log.
 *
 * The drain is bounded by a count of polls rather than a wall-clock deadline, so
 * an injected no-op sleep in a test cannot turn it into a spin.
 */

/**
 * How long a stop waits for in-flight work to end by itself. With the shutdown
 * deadline (start.ts `SHUTDOWN_DEADLINE_MS`, 15 s) this leaves time to record
 * what is left and close inside launchd's 20 s budget, the tightest of the unit
 * stop timeouts (systemd's user default is 90 s). Docker's default `docker stop`
 * timeout is 10 s, which is why the compose example and the home-lab role give
 * the container a longer `stop_grace_period`.
 */
export const SHUTDOWN_DRAIN_MS = 8_000;

/** How long recording the cut-short runs may take before the stop goes ahead anyway. */
export const SHUTDOWN_RECORD_MS = 2_000;

const POLL_MS = 250;

export interface InFlight {
  /** Chat turns running (`hub.runningSessions().length`). */
  turns: number;
  /** Trigger runs in flight (`managers.liveRuns.size`). */
  runs: number;
}

export interface DrainOptions {
  drainMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DrainResult {
  /** What was in flight when the stop began. */
  before: InFlight;
  /** What was still in flight when the wait ended. */
  after: InFlight;
  /** How many polls the wait took (0 when nothing was in flight). */
  polls: number;
}

const idle = (f: InFlight): boolean => f.turns === 0 && f.runs === 0;

/** Wait, boundedly, for the in-flight work to end. Never throws; a reading that throws counts as zero. */
export async function drainInFlight(read: () => InFlight, opts: DrainOptions = {}): Promise<DrainResult> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const maxPolls = Math.max(0, Math.ceil((opts.drainMs ?? SHUTDOWN_DRAIN_MS) / pollMs));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const safeRead = (): InFlight => {
    try {
      const f = read();
      return { turns: Math.max(0, f.turns | 0), runs: Math.max(0, f.runs | 0) };
    } catch {
      return { turns: 0, runs: 0 };
    }
  };
  const before = safeRead();
  let after = before;
  let polls = 0;
  while (!idle(after) && polls < maxPolls) {
    await sleep(pollMs);
    polls++;
    after = safeRead();
  }
  return { before, after, polls };
}

/**
 * Finish every run still in flight as failed with `reason`, each through its own
 * interrupt (which is once-only, so a turn that ends at the same moment cannot
 * finish it twice). Bounded by `timeoutMs`; returns how many were recorded in time.
 */
export async function recordInterruptedRuns(
  liveRuns: ReadonlyMap<string, (reason: string) => Promise<void>> | undefined,
  reason: string,
  timeoutMs: number = SHUTDOWN_RECORD_MS,
): Promise<number> {
  if (!liveRuns || liveRuns.size === 0) return 0;
  let recorded = 0;
  const all = Promise.all(
    [...liveRuns.values()].map((interrupt) =>
      interrupt(reason).then(
        () => {
          recorded++;
        },
        () => undefined,
      ),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  if (timer) clearTimeout(timer);
  return recorded;
}

/**
 * The line logged the moment a stop begins, when something is in flight — before
 * the wait, so a supervisor whose kill timeout is shorter than the wait (PM2's
 * is 1.6 s) still leaves a record of what it cut short. Undefined when idle.
 */
export function describeShutdownStart(signal: string, f: InFlight, drainMs: number = SHUTDOWN_DRAIN_MS): string | undefined {
  if (idle(f)) return undefined;
  const what = [
    f.turns > 0 ? `${f.turns} chat turn${f.turns === 1 ? "" : "s"}` : "",
    f.runs > 0 ? `${f.runs} trigger run${f.runs === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return `${signal}: ${what} in flight; waiting up to ${Math.round(drainMs / 1000)}s for ${f.turns + f.runs === 1 ? "it" : "them"} to finish.`;
}

/** The log line for a stop, from what was in flight before and after the wait. */
export function describeShutdown(signal: string, d: DrainResult, recorded: number): string {
  if (idle(d.before)) return `${signal}: shutting down, nothing in flight.`;
  const parts = (f: InFlight): string =>
    [
      f.turns > 0 ? `${f.turns} chat turn${f.turns === 1 ? "" : "s"}` : "",
      f.runs > 0 ? `${f.runs} trigger run${f.runs === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
  if (idle(d.after)) return `${signal}: shutting down; waited for ${parts(d.before)} to finish, and they did.`;
  const tail =
    d.after.runs > 0
      ? ` ${recorded} of ${d.after.runs} run record${d.after.runs === 1 ? "" : "s"} marked failed (interrupted by shutdown).`
      : "";
  return (
    `${signal}: shutting down with ${parts(d.after)} still in flight — cut short.${tail} ` +
    "Run `managers busy` before a stop or an update to see this before it happens."
  );
}

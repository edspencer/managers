/**
 * The SIGTERM path's finish-or-record (CLI contract SPEC §4, §8):
 * `shutdown-drain.ts`. start.ts wires it to the hub and `managers.liveRuns`.
 */
import { describe, expect, it } from "vitest";
import {
  describeShutdown,
  describeShutdownStart,
  drainInFlight,
  recordInterruptedRuns,
  type InFlight,
} from "../../src/shutdown-drain.js";

const noSleep = async () => undefined;

describe("drainInFlight", () => {
  it("does not wait at all when nothing is in flight", async () => {
    let reads = 0;
    const d = await drainInFlight(
      () => {
        reads++;
        return { turns: 0, runs: 0 };
      },
      { sleep: async () => expect.fail("an idle stop must not sleep") },
    );
    expect(d).toEqual({ before: { turns: 0, runs: 0 }, after: { turns: 0, runs: 0 }, polls: 0 });
    expect(reads).toBe(1);
  });

  it("waits until the work ends by itself", async () => {
    const readings: InFlight[] = [
      { turns: 1, runs: 1 },
      { turns: 1, runs: 1 },
      { turns: 0, runs: 1 }, // the turn ended; its run record is being committed
      { turns: 0, runs: 0 },
    ];
    const d = await drainInFlight(() => readings.shift() ?? { turns: 0, runs: 0 }, { sleep: noSleep });
    expect(d.before).toEqual({ turns: 1, runs: 1 });
    expect(d.after).toEqual({ turns: 0, runs: 0 });
    expect(d.polls).toBe(3);
  });

  /**
   * Bounded by a COUNT of polls, not a wall-clock deadline: with an injected
   * no-op sleep a deadline would spin for the whole window instead.
   */
  it("gives up after drainMs / pollMs polls, however fast the clock", async () => {
    let reads = 0;
    const d = await drainInFlight(
      () => {
        reads++;
        return { turns: 2, runs: 0 };
      },
      { drainMs: 1_000, pollMs: 250, sleep: noSleep },
    );
    expect(d.polls).toBe(4);
    expect(reads).toBe(5);
    expect(d.after).toEqual({ turns: 2, runs: 0 });
  });

  it("reads a throwing source as nothing in flight, and never a negative count", async () => {
    const d = await drainInFlight(
      () => {
        throw new Error("no hub");
      },
      { sleep: noSleep },
    );
    expect(d.before).toEqual({ turns: 0, runs: 0 });
    const neg = await drainInFlight(() => ({ turns: -3, runs: -1 }), { sleep: noSleep });
    expect(neg.before).toEqual({ turns: 0, runs: 0 });
  });
});

describe("recordInterruptedRuns", () => {
  it("interrupts every live run with the reason, and counts the ones that landed", async () => {
    const seen: string[] = [];
    const runs = new Map<string, (reason: string) => Promise<void>>([
      ["r-1", async (reason) => void seen.push(`r-1 ${reason}`)],
      ["r-2", async (reason) => void seen.push(`r-2 ${reason}`)],
      ["r-3", async () => Promise.reject(new Error("store is read-only"))],
    ]);
    expect(await recordInterruptedRuns(runs, "interrupted by shutdown")).toBe(2);
    expect(seen.sort()).toEqual(["r-1 interrupted by shutdown", "r-2 interrupted by shutdown"]);
  });

  it("is bounded: a run that never finishes recording does not hold the stop", async () => {
    const runs = new Map<string, (reason: string) => Promise<void>>([
      ["r-1", () => new Promise<void>(() => undefined)],
      ["r-2", async () => undefined],
    ]);
    const t0 = Date.now();
    expect(await recordInterruptedRuns(runs, "x", 50)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("is a no-op with no runs, or no Managers state", async () => {
    expect(await recordInterruptedRuns(new Map(), "x")).toBe(0);
    expect(await recordInterruptedRuns(undefined, "x")).toBe(0);
  });
});

describe("describeShutdown", () => {
  const z = { turns: 0, runs: 0 };
  it("says so when nothing was in flight", () => {
    expect(describeShutdown("SIGTERM", { before: z, after: z, polls: 0 }, 0)).toBe(
      "SIGTERM: shutting down, nothing in flight.",
    );
  });
  it("says what it waited for when everything finished", () => {
    expect(describeShutdown("SIGTERM", { before: { turns: 1, runs: 1 }, after: z, polls: 3 }, 0)).toBe(
      "SIGTERM: shutting down; waited for 1 chat turn and 1 trigger run to finish, and they did.",
    );
  });
  it("names what was cut short, and how many run records it marked", () => {
    const line = describeShutdown(
      "SIGINT",
      { before: { turns: 2, runs: 2 }, after: { turns: 2, runs: 2 }, polls: 32 },
      2,
    );
    expect(line).toContain("SIGINT: shutting down with 2 chat turns and 2 trigger runs still in flight");
    expect(line).toContain("2 of 2 run records marked failed (interrupted by shutdown)");
    expect(line).toContain("managers busy");
  });
});

describe("describeShutdownStart", () => {
  it("says nothing when idle, and names what is in flight before the wait otherwise", () => {
    expect(describeShutdownStart("SIGTERM", { turns: 0, runs: 0 })).toBeUndefined();
    expect(describeShutdownStart("SIGTERM", { turns: 1, runs: 0 })).toBe(
      "SIGTERM: 1 chat turn in flight; waiting up to 8s for it to finish.",
    );
    expect(describeShutdownStart("SIGINT", { turns: 2, runs: 1 })).toBe(
      "SIGINT: 2 chat turns and 1 trigger run in flight; waiting up to 8s for them to finish.",
    );
  });
});

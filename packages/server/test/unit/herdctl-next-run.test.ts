/**
 * Managers M15: a cron schedule that has never fired has no herdctl `nextRunAt`;
 * `withProjectedNextRun` projects it from the expression so the briefing and the
 * Triggers tab do not say "nothing scheduled" for an enabled daily wake.
 */
import { describe, it, expect } from "vitest";
import type { ScheduleInfo } from "@herdctl/core";
import { withProjectedNextRun } from "../../src/herdctl.js";

const base = (over: Partial<ScheduleInfo>): ScheduleInfo =>
  ({
    name: "wake",
    agentName: "keeper-acme",
    type: "cron",
    cron: "0 7 * * *",
    status: "idle",
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    ...over,
  }) as ScheduleInfo;

describe("withProjectedNextRun", () => {
  const now = new Date("2026-09-27T12:00:00Z");

  it("projects the next fire of an idle, never-fired cron schedule", () => {
    const out = withProjectedNextRun(base({}), now);
    expect(out.nextRunAt).not.toBeNull();
    const t = Date.parse(out.nextRunAt!);
    expect(t).toBeGreaterThan(now.getTime());
    expect(t - now.getTime()).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("keeps herdctl's own nextRunAt, and leaves disabled / running / interval / bad-cron schedules alone", () => {
    expect(withProjectedNextRun(base({ nextRunAt: "2026-09-28T07:00:00Z" }), now).nextRunAt).toBe("2026-09-28T07:00:00Z");
    expect(withProjectedNextRun(base({ status: "disabled" }), now).nextRunAt).toBeNull();
    expect(withProjectedNextRun(base({ status: "running" }), now).nextRunAt).toBeNull();
    expect(withProjectedNextRun(base({ type: "interval", cron: undefined, interval: "1h" }), now).nextRunAt).toBeNull();
    expect(withProjectedNextRun(base({ cron: "not a cron" }), now).nextRunAt).toBeNull();
  });
});

/**
 * Managers M6: `computeAlerts` is pure and deterministic. A fixed `now`, a table
 * of triggers/runs/schedules, and every alert kind plus the ordering.
 */
import { describe, it, expect } from "vitest";
import {
  computeAlerts,
  monthsToRead,
  alertTriggers,
  type AlertTrigger,
  type AlertSchedule,
} from "../../../src/managers/alerts.js";
import { evaluateExpect, withinMs } from "../../../src/managers/expect.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

type R = Parameters<typeof computeAlerts>[0]["runs"][number];
let n = 0;
function run(trigger: string, startedHoursAgo: number, over: Partial<R> = {}): R {
  n += 1;
  return {
    id: `r-260926-0000-${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`,
    trigger,
    status: "succeeded",
    started: hoursAgo(startedHoursAgo),
    finished: hoursAgo(startedHoursAgo - 0.1),
    expectResult: "n/a",
    error: null,
    ...over,
  };
}
const trig = (name: string, over: Partial<AlertTrigger> = {}): AlertTrigger => ({
  name,
  type: "schedule",
  enabled: true,
  expect: null,
  ...over,
});
const alerts = (triggers: AlertTrigger[], runs: R[], schedules: AlertSchedule[] = []) =>
  computeAlerts({ triggers, runs, schedules, now: NOW });

describe("computeAlerts — one case per kind", () => {
  it("nothing configured and nothing run → []", () => {
    expect(alerts([], [])).toEqual([]);
  });

  it("run-failed: the LAST finished run failed (an older failure followed by a success is not)", () => {
    const got = alerts([trig("a"), trig("b")], [
      run("a", 5, { status: "failed", error: "boom" }),
      run("a", 30),
      run("b", 30, { status: "failed" }),
      run("b", 5),
    ]);
    expect(got.map((x) => x.id)).toEqual(["run-failed:a"]);
    expect(got[0]).toMatchObject({ severity: "error", message: expect.stringContaining("boom") });
  });

  it("artifact-missing: last finished run succeeded with expectResult missing; a failed one reports run-failed only", () => {
    const got = alerts([trig("a"), trig("b")], [
      run("a", 3, { expectResult: "missing" }),
      run("b", 3, { status: "failed", expectResult: "missing" }),
    ]);
    expect(got.map((x) => x.id)).toEqual(["run-failed:b", "artifact-missing:a"]);
    expect(got[1]!.severity).toBe("warning");
  });

  it("stale: an enabled trigger with expect.within and no met run inside the window", () => {
    const exp = { kind: "episode", within: "48h" };
    const got = alerts(
      [
        trig("old", { expect: exp }), // last met 96h ago → stale
        trig("fresh", { expect: exp }), // met 10h ago → fine
        trig("never", { expect: exp }), // never met → stale
        trig("off", { expect: exp, enabled: false }), // disabled → never stale
        trig("nowin", { expect: { kind: "episode" } }), // no window → never stale
        trig("none", { expect: { kind: "none", within: "1h" } }), // kind none → never stale
      ],
      [run("old", 100, { expectResult: "met" }), run("fresh", 10, { expectResult: "met" }), run("off", 200, { expectResult: "met" })],
    );
    expect(got.map((x) => x.id)).toEqual(["stale:never", "stale:old"]);
    expect(got.find((x) => x.id === "stale:old")!.message).toMatch(/4 days/);
    expect(got.find((x) => x.id === "stale:never")!.runId).toBeNull();
  });

  it("stale catches 'fires but produces nothing': recent runs, all missing", () => {
    const got = alerts([trig("a", { expect: { kind: "episode", within: "24h" } })], [
      run("a", 2, { expectResult: "missing" }),
      run("a", 20, { expectResult: "missing" }),
      run("a", 50, { expectResult: "met" }),
    ]);
    expect(got.map((x) => x.id)).toEqual(["stale:a", "artifact-missing:a"]);
  });

  it("schedule-stalled: an enabled schedule whose nextRunAt is > 15 min past", () => {
    const got = alerts(
      [trig("late"), trig("ok"), trig("edge"), trig("off", { enabled: false }), trig("ev", { type: "event" })],
      [],
      [
        { name: "late", nextRunAt: hoursAgo(1) },
        { name: "ok", nextRunAt: hoursAgo(-1) },
        { name: "edge", nextRunAt: hoursAgo(0.2) }, // 12 minutes: under the bound
        { name: "off", nextRunAt: hoursAgo(5) },
        { name: "ev", nextRunAt: hoursAgo(5) },
      ],
    );
    expect(got.map((x) => x.id)).toEqual(["schedule-stalled:late"]);
    expect(got[0]!.severity).toBe("error");
  });

  it("a herdctl-disabled schedule is not stalled", () => {
    expect(alerts([trig("a")], [], [{ name: "a", status: "disabled", nextRunAt: hoursAgo(3) }])).toEqual([]);
  });

  it("run-stuck: running for more than 2 hours (the oldest one is named)", () => {
    const stuckOld = run("a", 5, { status: "running", finished: null });
    const got = alerts([trig("a"), trig("b")], [
      run("a", 3, { status: "running", finished: null }),
      stuckOld,
      run("b", 1, { status: "running", finished: null }),
    ]);
    expect(got.map((x) => x.id)).toEqual(["run-stuck:a"]);
    expect(got[0]!.runId).toBe(stuckOld.id);
  });

  it("a deleted trigger's last failure still shows; its stale/schedule checks do not", () => {
    expect(alerts([], [run("gone", 2, { status: "failed" })]).map((x) => x.id)).toEqual(["run-failed:gone"]);
  });
});

describe("computeAlerts — ordering and determinism", () => {
  const triggers = [
    trig("zeta", { expect: { kind: "episode", within: "1d" } }),
    trig("alpha", { expect: { kind: "episode", within: "1d" } }),
    trig("mid"),
  ];
  const runs = [
    run("zeta", 1, { status: "failed" }),
    run("alpha", 1, { expectResult: "missing" }),
    run("mid", 4, { status: "running", finished: null }),
  ];
  const schedules = [{ name: "mid", nextRunAt: hoursAgo(2) }];

  it("errors first, then by kind, then by trigger name", () => {
    expect(alerts(triggers, runs, schedules).map((x) => x.id)).toEqual([
      "run-failed:zeta",
      "schedule-stalled:mid",
      "run-stuck:mid",
      "stale:alpha",
      "stale:zeta",
      "artifact-missing:alpha",
    ]);
  });

  it("is byte-identical whatever order the inputs arrive in", () => {
    const a = JSON.stringify(alerts(triggers, runs, schedules));
    const b = JSON.stringify(alerts([...triggers].reverse(), [...runs].reverse(), schedules));
    expect(b).toBe(a);
  });
});

describe("expect helpers", () => {
  const base = { episodes: [] as string[], reports: [] as string[], artifacts: [] as { kind: string; ref: string; at: string }[] };
  it("evaluateExpect per kind", () => {
    expect(evaluateExpect({ ...base, expect: null })).toBe("n/a");
    expect(evaluateExpect({ ...base, expect: { kind: "none" } })).toBe("n/a");
    expect(evaluateExpect({ ...base, expect: { kind: "episode" } })).toBe("missing");
    expect(evaluateExpect({ ...base, episodes: ["ep-260926-0700-aa"], expect: { kind: "episode" } })).toBe("met");
    expect(evaluateExpect({ ...base, reports: ["digest"], expect: { kind: "report", report: "status" } })).toBe("missing");
    expect(evaluateExpect({ ...base, reports: ["status"], expect: { kind: "report", report: "status" } })).toBe("met");
    expect(evaluateExpect({ ...base, reports: ["digest"], expect: { kind: "report" } })).toBe("met");
    expect(evaluateExpect({ ...base, expect: { kind: "artifact" } })).toBe("missing");
    expect(
      evaluateExpect({ ...base, artifacts: [{ kind: "commit", ref: "abc", at: "2026-09-26T07:00:00Z" }], expect: { kind: "artifact" } }),
    ).toBe("met");
  });
  it("withinMs and monthsToRead", () => {
    expect(withinMs("48h")).toBe(48 * 3_600_000);
    expect(withinMs("7d")).toBe(7 * 86_400_000);
    expect(withinMs("7w")).toBeNull();
    expect(withinMs(null)).toBeNull();
    expect(monthsToRead([])).toBe(3);
    expect(monthsToRead([trig("a", { expect: { kind: "episode", within: "90d" } })])).toBe(5);
    expect(monthsToRead([trig("a", { expect: { kind: "episode", within: "9999d" } })])).toBe(24);
  });
  it("alertTriggers projects a project.yaml trigger map", () => {
    expect(
      alertTriggers({
        p: {
          trigger: { type: "schedule", cron: "0 7 * * *" },
          run: { prompt: "x", session: "new", tools: [], expect: { kind: "episode", within: "48h" } },
          enabled: true,
        },
      }),
    ).toEqual([{ name: "p", type: "schedule", enabled: true, expect: { kind: "episode", within: "48h" } }]);
  });
});

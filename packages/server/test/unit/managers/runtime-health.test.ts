/**
 * #11: Home's instance-level `runtime-unavailable` alert, derived from every
 * workspace's run records (`managers/runtime-health.ts`). One red item for a
 * fleet-wide runtime outage instead of a run-failed (and a stale) per trigger.
 */
import { describe, it, expect } from "vitest";
import { foldRuntimeAlerts, runtimeAlert, type HealthRun } from "../../../src/managers/runtime-health.js";
import type { Alert } from "../../../src/managers/alerts.js";

const AUTH = "Not logged in · Please run /login (authentication_failed)";
let n = 0;
const run = (slug: string, trigger: string, finished: string, over: Partial<HealthRun> = {}): HealthRun => ({
  id: `r-261016-${String(1000 + n++)}-ab`,
  slug,
  trigger,
  status: "failed",
  started: finished,
  finished,
  error: AUTH,
  errorKind: "runtime",
  ...over,
});

describe("runtimeAlert", () => {
  it("runtime failures across two workspaces raise ONE error alert naming the message, the count and the start", () => {
    const runs = [
      run("acme", "wake", "2026-10-04T11:15:00Z"),
      run("", "consolidate", "2026-10-05T03:30:00Z"),
      run("blog", "roadmap", "2026-10-06T09:00:00Z"),
      run("acme", "wake", "2026-10-07T11:15:00Z"),
    ];
    const h = runtimeAlert(runs)!;
    expect(h.alert).toMatchObject({ id: "runtime-unavailable:", kind: "runtime-unavailable", severity: "error" });
    expect(h.alert.message).toBe(
      "Claude runtime is failing: Not logged in · Please run /login (authentication_failed). " +
        "4 runs failed across 3 workspaces since 2026-10-04 11:15 UTC. It clears on the next run that succeeds.",
    );
    expect(h.alert.runId).toBe(runs[3]!.id);
    expect(h.triggers.get("acme")).toEqual(new Set(["wake"]));
    expect(h.triggers.get("blog")).toEqual(new Set(["roadmap"]));
  });

  it("the same error repeating in ONE workspace raises it too", () => {
    expect(runtimeAlert([run("acme", "a", "2026-10-04T11:00:00Z"), run("acme", "b", "2026-10-04T12:00:00Z")])).not.toBeNull();
  });

  it("a later successful run anywhere clears it", () => {
    const runs = [
      run("acme", "wake", "2026-10-04T11:15:00Z"),
      run("blog", "roadmap", "2026-10-05T11:15:00Z"),
      run("blog", "roadmap", "2026-10-16T15:00:00Z", { status: "succeeded", error: null, errorKind: null }),
    ];
    expect(runtimeAlert(runs)).toBeNull();
  });

  it("only failures AFTER the last success count", () => {
    const runs = [
      run("acme", "wake", "2026-10-01T00:00:00Z"),
      run("blog", "x", "2026-10-02T00:00:00Z", { status: "succeeded", error: null, errorKind: null }),
      run("acme", "wake", "2026-10-03T00:00:00Z"),
    ];
    expect(runtimeAlert(runs)).toBeNull();
  });

  it("other failures neither count nor break the streak; running runs are ignored", () => {
    const runs = [
      run("acme", "wake", "2026-10-04T11:15:00Z"),
      run("acme", "wake", "2026-10-04T12:00:00Z", { error: "interrupted by restart", errorKind: null }),
      run("blog", "roadmap", "2026-10-04T13:00:00Z", { errorKind: "no-output", error: "The agent produced no output" }),
      run("blog", "roadmap", "2026-10-04T14:00:00Z", { status: "running", finished: null, error: null, errorKind: null }),
    ];
    const h = runtimeAlert(runs)!;
    expect(h.runs.map((r) => r.errorKind)).toEqual(["no-output", "runtime"]);
  });

  it("CONTROL: one failed run is that project's run-failed, not an instance alert", () => {
    expect(runtimeAlert([run("acme", "wake", "2026-10-04T11:15:00Z")])).toBeNull();
  });

  it("CONTROL: two DIFFERENT runtime errors in one workspace are not yet systemic", () => {
    expect(
      runtimeAlert([run("acme", "a", "2026-10-04T11:00:00Z"), run("acme", "b", "2026-10-04T12:00:00Z", { error: "other" })]),
    ).toBeNull();
  });

  it("CONTROL: ordinary failures (no errorKind) never raise it", () => {
    const runs = [run("a", "x", "2026-10-04T11:00:00Z", { errorKind: null }), run("b", "y", "2026-10-04T12:00:00Z", { errorKind: null })];
    expect(runtimeAlert(runs)).toBeNull();
  });

  it("CONTROL: no runs, no alert", () => {
    expect(runtimeAlert([])).toBeNull();
  });
});

describe("foldRuntimeAlerts", () => {
  const a = (kind: Alert["kind"], trigger: string): Alert => ({
    id: `${kind}:${trigger}`,
    kind,
    trigger,
    severity: "error",
    message: "",
    runId: null,
    at: null,
  });

  it("drops the run-failed and stale alerts of explained triggers and counts them", () => {
    const alerts = [a("run-failed", "wake"), a("stale", "wake"), a("schedule-stalled", "wake"), a("run-failed", "other")];
    const out = foldRuntimeAlerts(alerts, new Set(["wake"]));
    expect(out.folded).toBe(2);
    expect(out.alerts.map((x) => x.id)).toEqual(["schedule-stalled:wake", "run-failed:other"]);
  });

  it("CONTROL: nothing explained, nothing folded", () => {
    const alerts = [a("run-failed", "wake")];
    expect(foldRuntimeAlerts(alerts, undefined)).toEqual({ alerts, folded: 0 });
  });
});

describe("runtimeAlert's message", () => {
  it("quotes the error most of the streak shares, not just the newest", () => {
    const h = runtimeAlert([
      run("a", "x", "2026-10-04T10:00:00Z"),
      run("b", "y", "2026-10-04T11:00:00Z"),
      run("c", "z", "2026-10-04T12:00:00Z", { errorKind: "no-output", error: "The agent produced no output." }),
    ])!;
    expect(h.alert.message).toContain("Claude runtime is failing: Not logged in · Please run /login");
  });
});

describe("runtimeAlert on a same-second tie", () => {
  it("a success finishing in the same second as the failures counts as newer, so it clears", () => {
    const at = "2026-10-04T11:00:00Z";
    const runs = [run("a", "x", at), run("b", "y", at), run("c", "z", at, { status: "succeeded", error: null, errorKind: null })];
    expect(runtimeAlert(runs)).toBeNull();
  });
});

/**
 * t-261001-5ti7: `resolveWakeTarget` (the asking trigger, else `wake`, gated by
 * behaviours) and `raisedRunFromLog` (the run that raised a pre-`raisedBy` task).
 */
import { describe, it, expect } from "vitest";
import { raisedRunFromLog, resolveWakeTarget } from "../../../src/managers/wake-target.js";
import type { EffectiveBehaviour } from "../../../src/managers/behaviours.js";
import type { PaddockTrigger } from "../../../src/trigger-config.js";

const trig = (enabled: boolean, behaviour?: string) =>
  ({
    trigger: { type: "schedule", cron: "0 0 * * *" },
    run: { prompt: "Go.", ...(behaviour ? { behaviour } : {}) },
    enabled,
  }) as unknown as PaddockTrigger;
const beh = (name: string, enabled: boolean): EffectiveBehaviour =>
  ({ name, enabled, description: "", triggers: [], tools: [], instructions: "", config: {} }) as unknown as EffectiveBehaviour;

describe("resolveWakeTarget", () => {
  it("a project whose only trigger is roadmap: the roadmap-raised task wakes roadmap", () => {
    expect(resolveWakeTarget({ roadmap: trig(true) }, [], "roadmap")).toEqual({
      available: true,
      reason: null,
      trigger: "roadmap",
    });
  });

  it("no asker → wake, with the reasons it had before", () => {
    expect(resolveWakeTarget({ wake: trig(true) }, [])).toEqual({ available: true, reason: null, trigger: "wake" });
    expect(resolveWakeTarget({ wake: trig(false) }, [])).toEqual({
      available: false,
      reason: "the wake trigger is disabled",
      trigger: null,
    });
    expect(resolveWakeTarget({ roadmap: trig(true) }, [])).toEqual({
      available: false,
      reason: "this project has no wake trigger",
      trigger: null,
    });
    expect(resolveWakeTarget(undefined, []).available).toBe(false);
  });

  it("falls back to wake when the asker is disabled, gone, or behind an off behaviour", () => {
    const wake = trig(true);
    expect(resolveWakeTarget({ roadmap: trig(false), wake }, [], "roadmap").trigger).toBe("wake");
    expect(resolveWakeTarget({ wake }, [], "roadmap").trigger).toBe("wake");
    const gated = { roadmap: trig(true, "roadmap-work"), wake };
    expect(resolveWakeTarget(gated, [beh("roadmap-work", false)], "roadmap").trigger).toBe("wake");
    // An undefined behaviour fails closed too.
    expect(resolveWakeTarget(gated, [], "roadmap").trigger).toBe("wake");
    // …and on, it is the asker.
    expect(resolveWakeTarget(gated, [beh("roadmap-work", true)], "roadmap").trigger).toBe("roadmap");
  });

  it("never wakes a gated trigger: nothing to wake says why for both", () => {
    expect(resolveWakeTarget({ roadmap: trig(true, "roadmap-work") }, [beh("roadmap-work", false)], "roadmap")).toEqual({
      available: false,
      reason: 'the roadmap trigger\'s behaviour "roadmap-work" is off, and this project has no wake trigger',
      trigger: null,
    });
  });

  it("never targets a derived trigger (report-*, consolidate)", () => {
    const t = { "report-status": trig(true), consolidate: trig(true), wake: trig(true) };
    expect(resolveWakeTarget(t, [], "report-status").trigger).toBe("wake");
    expect(resolveWakeTarget(t, [], "consolidate").trigger).toBe("wake");
  });

  it("an asker named wake is just wake", () => {
    expect(resolveWakeTarget({ wake: trig(false) }, [], "wake")).toEqual({
      available: false,
      reason: "the wake trigger is disabled",
      trigger: null,
    });
  });
});

describe("raisedRunFromLog", () => {
  const R = "r-261001-0900-ab12";
  it("finds the run that moved the task to awaiting-ed, or created it so", () => {
    expect(raisedRunFromLog([`2026-10-01T08:00Z manager: created, open`, `2026-10-01T09:00Z manager (run ${R}): open → awaiting-ed`])).toBe(R);
    expect(raisedRunFromLog([`2026-10-01T09:00Z manager (run ${R}): created, awaiting-ed`])).toBe(R);
  });

  it("the NEWEST raise wins; one without a run (a chat, Ed) means no run asked", () => {
    expect(
      raisedRunFromLog([
        `2026-10-01T09:00Z manager (run ${R}): created, awaiting-ed`,
        `2026-10-01T10:00Z ed: answered "ship", awaiting-ed → open`,
        `2026-10-01T11:00Z manager: open → awaiting-ed`,
      ]),
    ).toBeNull();
  });

  it("ignores lines that are not a raise, and an empty log", () => {
    expect(raisedRunFromLog([`2026-10-01T09:00Z manager (run ${R}): updated notes`])).toBeNull();
    expect(raisedRunFromLog([])).toBeNull();
  });
});

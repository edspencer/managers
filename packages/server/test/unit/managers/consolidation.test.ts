/**
 * Managers M14: the consolidation behaviour, its derived trigger, the early-fire
 * rule, the run marker and the reflection episode — all pure.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_BEHAVIOURS,
  effectiveBehaviours,
  sanitizeBehaviours,
  triggerGate,
} from "../../../src/managers/behaviours.js";
import {
  ConsolidationTracker,
  consolidationBehaviour,
  consolidationSettings,
  consolidationWindow,
  earlyFireDecision,
  importanceSum,
  reflectionEpisodeText,
  type ConsolidationHistory,
} from "../../../src/managers/consolidation.js";
import {
  CONSOLIDATE_TRIGGER_MAX_TURNS,
  CONSOLIDATE_TRIGGER_NAME,
  effectiveTriggers,
} from "../../../src/managers/effective-triggers.js";
import { runKindOf } from "../../../src/managers/trigger-runs.js";
import { sanitizeTriggers } from "../../../src/trigger-config.js";
import { isKnownModel } from "../../../src/models.js";
import type { RunSummary } from "../../../src/managers/runs-store.js";

const run = (over: Partial<RunSummary>): RunSummary =>
  ({
    id: "r-260926-0330-aa",
    trigger: "consolidate",
    kind: "consolidation",
    status: "succeeded",
    started: "2026-09-26T03:30:00Z",
    finished: "2026-09-26T03:31:00Z",
    file: "runs/2026-09/r-260926-0330-aa.yaml",
    ...over,
  }) as RunSummary;
const none: ConsolidationHistory = { last: null, lastSucceeded: null, running: null };
const eps = (...imps: number[]) => imps.map((importance) => ({ importance, tags: [] as string[] }));
const NOW = new Date("2026-09-27T12:00:00Z");

describe("the consolidate-memory behaviour", () => {
  it("is built in, OFF, gates `consolidate`, gates no tools, and has the plan's defaults", () => {
    const b = consolidationBehaviour(effectiveBehaviours({ slug: "p" }, null))!;
    expect(b).toMatchObject({ enabled: false, triggers: ["consolidate"], tools: [], origin: "builtin" });
    expect(consolidationSettings(b)).toEqual({
      schedule: "30 3 * * *",
      threshold: 40,
      minGapHours: 6,
      model: "claude-sonnet-5",
      promptFile: null,
    });
    expect(isKnownModel(BUILTIN_BEHAVIOURS["consolidate-memory"]!.config!.model!)).toBe(true);
  });

  it("config merges key by key (built-in < Home < project); bad keys are dropped, not the entry", () => {
    const home = sanitizeBehaviours({ "consolidate-memory": { config: { threshold: 20, schedule: "0 2 * * *" } } });
    const own = sanitizeBehaviours({
      "consolidate-memory": {
        enabled: true,
        config: { minGapHours: 12, threshold: "lots", promptFile: "../escape.md", model: "claude-haiku-4-5-20251001" },
      },
    });
    expect(own?.["consolidate-memory"]?.config).toEqual({ minGapHours: 12, model: "claude-haiku-4-5-20251001" });
    const b = consolidationBehaviour(effectiveBehaviours({ slug: "p", behaviours: own }, { slug: "", behaviours: home }))!;
    expect(b.enabled).toBe(true);
    expect(b.overridden).toBe(true);
    expect(consolidationSettings(b)).toMatchObject({ schedule: "0 2 * * *", threshold: 20, minGapHours: 12, promptFile: null });
  });
});

describe("the derived consolidate trigger", () => {
  it("exists everywhere with a fixed capability, armed only on the workspace's OWN flag", () => {
    const off = effectiveTriggers({ slug: "p" }, null)[CONSOLIDATE_TRIGGER_NAME]!;
    expect(off).toMatchObject({
      enabled: false,
      trigger: { type: "schedule", cron: "30 3 * * *" },
      run: { tools: ["Read", "Grep", "Glob"], maxTurns: CONSOLIDATE_TRIGGER_MAX_TURNS, expect: { kind: "none" }, session: "new" },
      derived: { kind: "consolidation" },
    });
    expect(runKindOf({ name: "consolidate", agentName: "x", ...off })).toBe("consolidation");
    const on = effectiveTriggers({ slug: "p", behaviours: { "consolidate-memory": { enabled: true } } }, null);
    expect(on[CONSOLIDATE_TRIGGER_NAME]!.enabled).toBe(true);
    // Home's own flag is Home's: it never arms a project.
    const homeOn = effectiveTriggers({ slug: "p" }, { slug: "", behaviours: { "consolidate-memory": { enabled: true } } });
    expect(homeOn[CONSOLIDATE_TRIGGER_NAME]!.enabled).toBe(false);
    // An unreadable project file arms nothing.
    const broken = effectiveTriggers({ slug: "p", configError: "bad", behaviours: { "consolidate-memory": { enabled: true } } }, null);
    expect(broken[CONSOLIDATE_TRIGGER_NAME]!.enabled).toBe(false);
  });

  it("uses config.promptFile, schedule and model", () => {
    const t = effectiveTriggers(
      { slug: "p", behaviours: { "consolidate-memory": { config: { promptFile: "consolidate.md", schedule: "0 1 * * *", model: "claude-sonnet-5" } } } },
      null,
    )[CONSOLIDATE_TRIGGER_NAME]!;
    expect(t.run.promptFile).toBe("consolidate.md");
    expect(t.run.prompt).toBeUndefined();
    expect(t.trigger).toMatchObject({ cron: "0 1 * * *" });
    expect(t.run.model).toBe("claude-sonnet-5");
  });

  it("is gated by the behaviour at every fire, and a hand-written `consolidate` cannot claim the run kind", () => {
    const t = effectiveTriggers({ slug: "p" }, null)[CONSOLIDATE_TRIGGER_NAME]!;
    expect(triggerGate(CONSOLIDATE_TRIGGER_NAME, t, effectiveBehaviours({ slug: "p" }, null)).open).toBe(false);
    const onList = effectiveBehaviours({ slug: "p", behaviours: { "consolidate-memory": { enabled: true } } }, null);
    expect(triggerGate(CONSOLIDATE_TRIGGER_NAME, t, onList).open).toBe(true);
    // Home broken → every behaviour off → the gate closes.
    const brokenRoot = effectiveBehaviours({ slug: "p", behaviours: { "consolidate-memory": { enabled: true } } }, { slug: "", configError: "x" });
    expect(triggerGate(CONSOLIDATE_TRIGGER_NAME, t, brokenRoot).open).toBe(false);
    // A declared trigger that tries to pose as derived: the marker is stripped on read…
    const declared = sanitizeTriggers({
      consolidate: { trigger: { type: "schedule", cron: "* * * * *" }, run: { prompt: "x" }, enabled: true, derived: { kind: "consolidation" } },
      sneaky: { trigger: { type: "schedule", cron: "* * * * *" }, run: { prompt: "x" }, enabled: true, derived: { kind: "consolidation" } },
    } as never)!;
    expect(runKindOf({ name: "sneaky", agentName: "x", ...declared.sneaky! })).toBe("wake");
    // …and the derived one replaces a declared `consolidate` (keeping only its run.behaviour gate).
    const eff = effectiveTriggers({ slug: "p", triggers: declared }, null);
    expect(eff[CONSOLIDATE_TRIGGER_NAME]!.trigger).toMatchObject({ cron: "30 3 * * *" });
    expect(eff[CONSOLIDATE_TRIGGER_NAME]!.enabled).toBe(false);
  });
});

describe("the early-fire rule", () => {
  const settings = { threshold: 40, minGapHours: 6 };
  const table: { name: string; in: Partial<Parameters<typeof earlyFireDecision>[0]>; fire: boolean; reason: RegExp }[] = [
    { name: "off", in: { enabled: false, episodes: eps(50) }, fire: false, reason: /off/ },
    { name: "below the threshold", in: { episodes: eps(10, 29) }, fire: false, reason: /39 is below the threshold 40/ },
    { name: "at the threshold, never consolidated", in: { episodes: eps(20, 20) }, fire: true, reason: /40 .* reached/ },
    {
      name: "inside the minimum gap",
      in: { episodes: eps(50), history: { last: run({ started: "2026-09-27T08:00:00Z" }), lastSucceeded: null, running: null } },
      fire: false,
      reason: /4\.0h ago \(minimum gap 6h\)/,
    },
    {
      name: "past the gap (measured from the last run of ANY status)",
      in: { episodes: eps(50), history: { last: run({ status: "failed", started: "2026-09-27T05:00:00Z" }), lastSucceeded: null, running: null } },
      fire: true,
      reason: /reached/,
    },
    { name: "a run in flight in this process", in: { episodes: eps(50), inFlight: true }, fire: false, reason: /in flight/ },
    {
      name: "a run still running on disk",
      in: { episodes: eps(50), history: { last: null, lastSucceeded: null, running: run({ status: "running" }) } },
      fire: false,
      reason: /in flight/,
    },
    { name: "reflections do not count", in: { episodes: [{ importance: 45, tags: ["reflection"] }, ...eps(5)] }, fire: false, reason: /5 is below/ },
  ];
  for (const c of table) {
    it(c.name, () => {
      const d = earlyFireDecision({ settings, enabled: true, episodes: [], history: none, inFlight: false, now: NOW, ...c.in });
      expect(d.fire).toBe(c.fire);
      expect(d.reason).toMatch(c.reason);
    });
  }

  it("the window starts at the last SUCCEEDED run, else 30 days back", () => {
    expect(consolidationWindow({ lastSucceeded: run({}) }, NOW).sinceIso).toBe("2026-09-26T03:30:00.000Z");
    // Floored to the minute: episodes carry minute precision.
    expect(consolidationWindow({ lastSucceeded: run({ started: "2026-09-26T03:30:41Z" }) }, NOW).sinceIso).toBe("2026-09-26T03:30:00.000Z");
    expect(consolidationWindow({ lastSucceeded: null }, NOW).sinceIso).toBe("2026-08-28T12:00:00.000Z");
    expect(importanceSum([{ importance: 3, tags: [] }, { importance: 9, tags: ["reflection"] }])).toBe(3);
  });
});

describe("the run marker", () => {
  it("is per run AND per workspace, and ends once", () => {
    const t = new ConsolidationTracker();
    t.begin("r-1", "acme");
    expect(t.isActive("r-1", "acme")).toBe(true);
    expect(t.isActive("r-1", "widget")).toBe(false);
    expect(t.isActive(null, "acme")).toBe(false);
    expect(t.hasActive("acme")).toBe(true);
    t.note("r-1", { op: "add", name: "a", type: "pattern" });
    t.note("r-2", { op: "add", name: "ignored" });
    expect(t.end("r-1")).toEqual([{ op: "add", name: "a", type: "pattern" }]);
    expect(t.end("r-1")).toEqual([]);
    expect(t.isActive("r-1", "acme")).toBe(false);
  });

  it("the early-fire claim debounces", () => {
    const t = new ConsolidationTracker();
    expect(t.claim("acme")).toBe(true);
    expect(t.claim("acme")).toBe(false);
    expect(t.claim("widget")).toBe(true);
    t.release("acme");
    expect(t.claim("acme")).toBe(true);
  });
});

describe("the reflection episode", () => {
  it("lists every op in order, deterministically", () => {
    const text = reflectionEpisodeText(
      "r-260927-0330-aa",
      [
        { op: "add", name: "qa-pattern", type: "pattern" },
        { op: "update", name: "pricing-owner" },
        { op: "supersede", name: "old-way" },
        { op: "noop", name: "house-style" },
      ],
      "succeeded",
    );
    expect(text).toBe(
      "Consolidation run r-260927-0330-aa performed 4 memory ops: add qa-pattern (pattern); update pricing-owner; supersede old-way; noop house-style.",
    );
    expect(reflectionEpisodeText("r-x", [], "succeeded")).toBe("Consolidation run r-x performed no memory ops.");
    expect(reflectionEpisodeText("r-x", [{ op: "add", name: "a" }], "failed")).toBe(
      "Consolidation run r-x performed 1 memory op (the run failed): add a.",
    );
  });

  it("stays inside the episode limit with a +N more tail", () => {
    const ops = Array.from({ length: 200 }, (_, i) => ({ op: "add" as const, name: `fact-number-${i}` }));
    const text = reflectionEpisodeText("r-x", ops, "succeeded");
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toMatch(/\+\d+ more\.$/);
  });
});

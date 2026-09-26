/**
 * Managers M8: behaviours and binary autonomy — the pure half.
 *
 * The merge rule (built-in < Home < project, `enabled` only from the workspace's
 * own entry), the trigger gate, the tool denial, schedule arming, the briefing
 * section, the fingerprint and the out-of-UI baseline.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentConfigSchema, toSDKOptions } from "@herdctl/core";
import {
  BEHAVIOUR_TAMPER_DENIED_TOOLS,
  BUILTIN_BEHAVIOURS,
  BehaviourOffError,
  behaviourFingerprint,
  behavioursBriefingBody,
  disabledBehaviourTools,
  effectiveBehaviours,
  sanitizeBehaviours,
  triggerGate,
  type BehaviourConfig,
} from "../../../src/managers/behaviours.js";
import {
  adoptBaselineIfAbsent,
  behaviourDriftAlert,
  readBaseline,
  writeBaseline,
} from "../../../src/managers/behaviour-state.js";
import { alertTriggers, computeAlerts } from "../../../src/managers/alerts.js";
import { buildAgentConfig, buildTriggerConfig } from "../../../src/herdctl-agent-config.js";
import { DENIED_TOOLS } from "../../../src/herdctl-agent-names.js";
import { sanitizeTrigger, triggersToHerdctlSchedules, type PaddockTrigger } from "../../../src/trigger-config.js";
import type { PaddockConfig } from "../../../src/config.js";
import type { Project } from "../../../src/projects.js";

const ws = (slug: string, behaviours?: Record<string, BehaviourConfig>) => ({ slug, behaviours });
const find = (list: ReturnType<typeof effectiveBehaviours>, name: string) => list.find((b) => b.name === name)!;

const ROOT = ws("", {
  "triage-external-prs": {
    enabled: true, // Home's own switch: must NOT reach any project
    description: "Triage outside PRs.",
    triggers: ["triage-prs"],
    tools: ["mcp__paddock__create_chat"],
    instructions: "By number only.",
  },
  "post-pr-comments": { description: "Post PR comments.", tools: ["mcp__github__add_comment"] },
});

describe("effectiveBehaviours — the merge rule table (M8)", () => {
  const cases: {
    name: string;
    project: Record<string, BehaviourConfig> | undefined;
    behaviour: string;
    enabled: boolean;
    origin: string;
    inherited: boolean;
    overridden: boolean;
  }[] = [
    { name: "root definition, no project entry → off", project: undefined, behaviour: "triage-external-prs", enabled: false, origin: "home", inherited: true, overridden: false },
    { name: "root `enabled: true` is ignored for a project", project: {}, behaviour: "triage-external-prs", enabled: false, origin: "home", inherited: true, overridden: false },
    { name: "root definition + project enable → on", project: { "triage-external-prs": { enabled: true } }, behaviour: "triage-external-prs", enabled: true, origin: "home", inherited: true, overridden: false },
    { name: "project `enabled: false` → off", project: { "triage-external-prs": { enabled: false } }, behaviour: "triage-external-prs", enabled: false, origin: "home", inherited: true, overridden: false },
    { name: "a non-boolean enabled never switches on", project: { "triage-external-prs": { enabled: "yes" as unknown as boolean } }, behaviour: "triage-external-prs", enabled: false, origin: "home", inherited: true, overridden: false },
    { name: "project-only definition, off by default", project: { "draft-notes": { description: "Draft." } }, behaviour: "draft-notes", enabled: false, origin: "project", inherited: false, overridden: false },
    { name: "project override of an inherited definition", project: { "post-pr-comments": { tools: [] } }, behaviour: "post-pr-comments", enabled: false, origin: "home", inherited: true, overridden: true },
    { name: "a built-in is off until the project enables it", project: undefined, behaviour: "consolidate-memory", enabled: false, origin: "builtin", inherited: true, overridden: false },
    { name: "a built-in switched on by the project", project: { "consolidate-memory": { enabled: true } }, behaviour: "consolidate-memory", enabled: true, origin: "builtin", inherited: true, overridden: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const b = find(effectiveBehaviours(ws("widget-lib", c.project), ROOT), c.behaviour);
      expect({ enabled: b.enabled, origin: b.origin, inherited: b.inherited, overridden: b.overridden }).toEqual({
        enabled: c.enabled,
        origin: c.origin,
        inherited: c.inherited,
        overridden: c.overridden,
      });
    });
  }

  it("merges definitions field by field: project fields win, the rest are inherited", () => {
    const b = find(
      effectiveBehaviours(ws("widget-lib", { "triage-external-prs": { instructions: "Mine." } }), ROOT),
      "triage-external-prs",
    );
    expect(b).toMatchObject({
      description: "Triage outside PRs.",
      triggers: ["triage-prs"],
      tools: ["mcp__paddock__create_chat"],
      instructions: "Mine.",
    });
  });

  it("Home's own `enabled` applies to Home, and Home's definitions are its own there", () => {
    const home = effectiveBehaviours(ROOT, ROOT);
    expect(find(home, "triage-external-prs")).toMatchObject({ enabled: true, origin: "home", inherited: false });
    expect(find(home, "post-pr-comments").enabled).toBe(false);
  });

  it("an unreadable root means no Home definitions, only built-ins and the project's own", () => {
    const list = effectiveBehaviours(ws("x", { mine: {} }), null);
    expect(list.map((b) => b.name)).toEqual(["consolidate-memory", "mine"]);
  });

  it("is sorted by name and defaults everything off (an empty project)", () => {
    const list = effectiveBehaviours(ws("empty-project"), ROOT);
    expect(list.map((b) => b.name)).toEqual(["consolidate-memory", "post-pr-comments", "triage-external-prs"]);
    expect(list.every((b) => b.enabled === false)).toBe(true);
  });

  it("the built-in consolidate-memory gates no tools (memory_op is also Ed's)", () => {
    expect(BUILTIN_BEHAVIOURS["consolidate-memory"]!.tools).toEqual([]);
  });
});

describe("sanitizeBehaviours (M8)", () => {
  it("drops bad names and bad fields, never a whole entry (fail closed)", () => {
    expect(
      sanitizeBehaviours({
        "Bad Name": { enabled: true },
        good: { enabled: "true", tools: ["x", 3, " y ", "x"], triggers: "nope", description: 7, extra: 1 },
        bare: null,
      }),
    ).toEqual({ good: { tools: ["x", "y"] }, bare: {} });
  });
  it("undefined when nothing survives (behaviour-less files round-trip unchanged)", () => {
    expect(sanitizeBehaviours(undefined)).toBeUndefined();
    expect(sanitizeBehaviours({ "NO!": {} })).toBeUndefined();
    expect(sanitizeBehaviours([])).toBeUndefined();
  });
});

describe("triggerGate (M8)", () => {
  const list = effectiveBehaviours(ws("widget-lib", { "post-pr-comments": { enabled: true } }), ROOT);
  const t = (behaviour?: string) => ({ run: behaviour ? { behaviour } : {} }) as Pick<PaddockTrigger, "run">;

  it("a trigger gated by nothing is open", () => {
    expect(triggerGate("wake", t(), list)).toEqual({ open: true, behaviours: [], off: [], unknown: [] });
  });
  it("a behaviour's triggers: list gates by name", () => {
    expect(triggerGate("triage-prs", t(), list)).toMatchObject({ open: false, off: ["triage-external-prs"] });
  });
  it("run.behaviour gates, and an ON behaviour opens it", () => {
    expect(triggerGate("comment", t("post-pr-comments"), list)).toMatchObject({ open: true, behaviours: ["post-pr-comments"] });
  });
  it("run.behaviour naming no defined behaviour fails closed", () => {
    expect(triggerGate("x", t("nope"), list)).toEqual({ open: false, behaviours: ["nope"], off: ["nope"], unknown: ["nope"] });
  });
  it("gated by several: every one must be on", () => {
    expect(triggerGate("triage-prs", t("post-pr-comments"), list)).toMatchObject({
      open: false,
      behaviours: ["post-pr-comments", "triage-external-prs"],
      off: ["triage-external-prs"],
    });
  });
  it("the refusal names the behaviour and says where to switch it", () => {
    const e = new BehaviourOffError("triage-prs", triggerGate("triage-prs", t(), list), "widget-lib");
    expect(e.code).toBe("behaviour_off");
    expect(e.message).toContain('"triage-external-prs"');
    expect(e.message).toContain("widget-lib");
    expect(e.message).toContain("Settings → Behaviours");
  });
});

describe("tool denial and schedule arming (M8)", () => {
  const cfg = { dataDir: "/tmp/data", nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
  const trig = (behaviour?: string): PaddockTrigger =>
    sanitizeTrigger({
      trigger: { type: "schedule", cron: "0 7 * * *" },
      run: { prompt: "go", ...(behaviour ? { behaviour } : {}) },
      enabled: true,
    })!;
  const project = (behaviours?: Record<string, BehaviourConfig>) =>
    ({
      slug: "widget-lib",
      name: "Widget Lib",
      dir: "/tmp/data/projects/widget-lib",
      workingDir: "/tmp/data/projects/widget-lib",
      triggers: { "triage-prs": trig(), wake: trig(), bound: trig("post-pr-comments") },
      behaviours,
    }) as unknown as Project;

  it("disabledBehaviourTools: the tools of OFF behaviours only, deduped and sorted", () => {
    const list = effectiveBehaviours(ws("w", { "post-pr-comments": { enabled: true } }), ROOT);
    expect(disabledBehaviourTools(list)).toEqual(["mcp__paddock__create_chat"]);
    expect(disabledBehaviourTools(effectiveBehaviours(ws("w"), ROOT))).toEqual([
      "mcp__github__add_comment",
      "mcp__paddock__create_chat",
    ]);
  });

  it("the keeper's denied_tools restate the fleet defaults, add the anti-tamper rules and every off tool", () => {
    const p = project();
    const c = buildAgentConfig(cfg, p, undefined, undefined, undefined, effectiveBehaviours(p, ROOT));
    const denied = c.denied_tools as string[];
    for (const d of DENIED_TOOLS) expect(denied).toContain(d);
    for (const d of BEHAVIOUR_TAMPER_DENIED_TOOLS) expect(denied).toContain(d);
    expect(denied).toContain("Edit(project.yaml)");
    expect(denied).toContain("Write(.managers/**)");
    expect(denied).toContain("mcp__paddock__create_chat");
    expect(denied).toContain("mcp__github__add_comment");
    // Survives herdctl's schema and reaches the SDK options (session drive mode).
    const parsed = AgentConfigSchema.parse(c);
    expect(parsed.denied_tools).toEqual(denied);
    expect(toSDKOptions({ ...parsed, qualifiedName: c.name } as never).disallowedTools).toEqual(denied);
  });

  it("switching a behaviour on removes its tools from denied_tools", () => {
    const p = project({ "triage-external-prs": { enabled: true } });
    const denied = buildAgentConfig(cfg, p, undefined, undefined, undefined, effectiveBehaviours(p, ROOT))
      .denied_tools as string[];
    expect(denied).not.toContain("mcp__paddock__create_chat");
    expect(denied).toContain("mcp__github__add_comment");
  });

  it("a scoped trigger agent carries the same denials", () => {
    const p = project();
    const c = buildTriggerConfig(cfg, p, "triage-prs", trig(), effectiveBehaviours(p, ROOT));
    expect(c.denied_tools).toEqual(
      buildAgentConfig(cfg, p, undefined, undefined, undefined, effectiveBehaviours(p, ROOT)).denied_tools,
    );
  });

  it("a schedule whose behaviour is off is not armed; ungated and ON-gated ones are", () => {
    const off = project();
    const s = buildAgentConfig(cfg, off, undefined, undefined, undefined, effectiveBehaviours(off, ROOT))
      .schedules as Record<string, { enabled: boolean }>;
    expect(s["triage-prs"]!.enabled).toBe(false);
    expect(s.bound!.enabled).toBe(false);
    expect(s.wake!.enabled).toBe(true);
    const on = project({ "triage-external-prs": { enabled: true }, "post-pr-comments": { enabled: true } });
    const s2 = buildAgentConfig(cfg, on, undefined, undefined, undefined, effectiveBehaviours(on, ROOT))
      .schedules as Record<string, { enabled: boolean }>;
    expect(s2["triage-prs"]!.enabled).toBe(true);
    expect(s2.bound!.enabled).toBe(true);
  });

  it("triggersToHerdctlSchedules without a gate is unchanged", () => {
    expect(triggersToHerdctlSchedules({ a: trig() })!.a!.enabled).toBe(true);
    expect(triggersToHerdctlSchedules({ a: trig() }, () => false)!.a!.enabled).toBe(false);
  });

  it("a gated-off trigger is not stale in the alerts (it cannot fire)", () => {
    const expecting = sanitizeTrigger({
      trigger: { type: "schedule", cron: "0 7 * * *" },
      run: { prompt: "go", expect: { kind: "episode", within: "48h" } },
      enabled: true,
    })!;
    const now = new Date("2026-09-26T12:00:00Z");
    const map = { "triage-prs": expecting };
    expect(computeAlerts({ triggers: alertTriggers(map), runs: [], schedules: [], now }).map((a) => a.id)).toEqual([
      "stale:triage-prs",
    ]);
    const list = effectiveBehaviours(ws("w"), ROOT);
    const gate = (n: string, t: PaddockTrigger) => triggerGate(n, t, list).open;
    expect(computeAlerts({ triggers: alertTriggers(map, gate), runs: [], schedules: [], now })).toEqual([]);
  });
});

describe("the briefing's Behaviours section (M8)", () => {
  it("lists ON behaviours with instructions, then the OFF ones as not permitted", () => {
    const body = behavioursBriefingBody(
      effectiveBehaviours(ws("w", { "triage-external-prs": { enabled: true } }), ROOT),
    );
    const on = body.indexOf("ON (you may act");
    const off = body.indexOf("Not permitted");
    expect(on).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(on);
    expect(body.slice(on, off)).toContain("**triage-external-prs**");
    expect(body.slice(on, off)).toContain("instructions: By number only.");
    expect(body.slice(off)).toContain("- post-pr-comments — Post PR comments.");
    expect(body.slice(off)).toContain("do not propose them");
    expect(body.slice(off)).not.toContain("triage-external-prs");
  });
  it("with nothing on, says so", () => {
    expect(behavioursBriefingBody(effectiveBehaviours(ws("w"), null))).toContain("ON: none.");
  });
});

describe("the out-of-UI fingerprint and baseline (M8)", () => {
  const trig = { t: { run: { behaviour: "post-pr-comments" } } } as unknown as Record<string, PaddockTrigger>;
  it("is stable for the same state and moves with a flag, a tool list or a binding", () => {
    const a = effectiveBehaviours(ws("w"), ROOT);
    expect(behaviourFingerprint(a, trig)).toBe(behaviourFingerprint(effectiveBehaviours(ws("w"), ROOT), trig));
    const flipped = effectiveBehaviours(ws("w", { "post-pr-comments": { enabled: true } }), ROOT);
    expect(behaviourFingerprint(flipped, trig)).not.toBe(behaviourFingerprint(a, trig));
    const narrowed = effectiveBehaviours(ws("w", { "post-pr-comments": { tools: [] } }), ROOT);
    expect(behaviourFingerprint(narrowed, trig)).not.toBe(behaviourFingerprint(a, trig));
    expect(behaviourFingerprint(a, {})).not.toBe(behaviourFingerprint(a, trig));
    // A description is not autonomy.
    const reworded = effectiveBehaviours(ws("w", { "post-pr-comments": { description: "Other words." } }), ROOT);
    expect(behaviourFingerprint(reworded, trig)).toBe(behaviourFingerprint(a, trig));
  });

  it("adopts the first state silently, alerts on a change, and a re-recorded state clears it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "m8-baseline-"));
    try {
      const before = effectiveBehaviours(ws("w"), ROOT);
      expect(await behaviourDriftAlert(dir, before, trig)).toBeNull(); // adopts
      expect((await readBaseline(dir))?.by).toBe("adopted");
      await adoptBaselineIfAbsent(dir, effectiveBehaviours(ws("w", { x: {} }), ROOT), trig); // no-op now
      expect(await behaviourDriftAlert(dir, before, trig)).toBeNull();

      const after = effectiveBehaviours(ws("w", { "triage-external-prs": { enabled: true } }), ROOT);
      const alert = await behaviourDriftAlert(dir, after, trig);
      expect(alert).toMatchObject({
        id: "behaviours-changed-outside-ui",
        kind: "behaviours-changed-outside-ui",
        severity: "info",
        trigger: "",
      });
      await writeBaseline(dir, after, trig, "ed");
      expect(await behaviourDriftAlert(dir, after, trig)).toBeNull();
      // Gitignored location.
      await fs.access(path.join(dir, ".managers", "state", "behaviours.json"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

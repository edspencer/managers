/**
 * Managers M10: the report primitive, pure parts and the writer.
 *
 *   • `reports:` sanitising and the definition merge (the §2.2 rule);
 *   • derived `report-<type>` triggers: shape, arming only when enabled, the
 *     reserved names, gates kept on a name collision, the `derived` marker never
 *     read from project.yaml;
 *   • `write_report` composition: model-written "Needs you" / "Alerts" removed,
 *     the server sections rendered, dated + current written, `previous` linked,
 *     an unknown type refused with nothing written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUILTIN_REPORT_TYPES,
  composeReport,
  effectiveReportTypes,
  renderAlerts,
  renderNeedsYou,
  reportTypeTitle,
  sanitizeReports,
  stripServerSections,
} from "../../../src/managers/reports.js";
import {
  derivedTriggers,
  effectiveTriggers,
  isReservedTriggerName,
  REPORT_TRIGGER_TOOLS,
} from "../../../src/managers/effective-triggers.js";
import { sanitizeTrigger, sanitizeTriggers, triggersToHerdctlSchedules } from "../../../src/trigger-config.js";
import { effectiveBehaviours, triggerGate, triggerGatePredicate } from "../../../src/managers/behaviours.js";
import { agentTriggerGuard, GatedTriggerError } from "../../../src/managers/trigger-guard.js";
import { runKindOf } from "../../../src/managers/trigger-runs.js";
import { ManagersState } from "../../../src/managers/state.js";
import { StateWriter } from "../../../src/managers/state-writes.js";
import { EpisodesStore } from "../../../src/managers/episodes-store.js";
import { workspaceLayout } from "../../../src/managers/layout.js";
import { buildStateOps } from "../../../src/managers/state-ops.js";
import { parseFrontmatter } from "../../../src/managers/frontmatter.js";
import { toTriggerDto } from "../../../src/triggers.js";
import type { TaskSummary } from "../../../src/managers/tasks-store.js";
import type { Alert } from "../../../src/managers/alerts.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

const task = (over: Partial<TaskSummary>): TaskSummary =>
  ({
    id: "t-260926-aaaa",
    title: "A task",
    status: "awaiting-ed",
    objective: null,
    source: "manager",
    ask: "Merge?",
    options: [],
    answer: null,
    github: [],
    dispatched: [],
    shovel_ready: false,
    due: null,
    created: "2026-09-26T07:00:00Z",
    updated: "2026-09-26T07:00:00Z",
    location: "open",
    month: null,
    file: "tasks/open/t-260926-aaaa.md",
    ...over,
  }) as TaskSummary;

const alert: Alert = {
  id: "stale:publish-check",
  kind: "stale",
  trigger: "publish-check",
  severity: "warning",
  message: "No met run of publish-check in 48h.",
  runId: null,
  at: null,
};

describe("reports: sanitising", () => {
  it("drops a bad FIELD, never the entry; drops invalid type names; absent when empty", () => {
    expect(
      sanitizeReports({
        status: { enabled: "yes", schedule: { cron: "0 8 * * *", interval: "1h" }, promptFile: "../x.md", model: " m " },
        digest: { enabled: true, schedule: { interval: "6h" }, promptFile: "digest.md" },
        "Bad Name": { enabled: true },
        empty: null,
        list: [1],
      }),
    ).toEqual({
      status: { model: "m" },
      digest: { enabled: true, schedule: { interval: "6h" }, promptFile: "digest.md" },
      empty: {},
    });
    expect(sanitizeReports({})).toBeUndefined();
    expect(sanitizeReports("x")).toBeUndefined();
    expect(sanitizeReports({ s: { promptFile: "/abs.md" } })).toEqual({ s: {} });
    expect(sanitizeReports({ s: { promptFile: "notes.txt" } })).toEqual({ s: {} });
  });
});

describe("reports: the definition merge (§2.2)", () => {
  const root = {
    slug: "",
    reports: {
      status: { enabled: true, schedule: { cron: "0 6 * * *" } },
      digest: { enabled: true, description: "Weekly digest", schedule: { cron: "0 9 * * 1" } },
    },
  };
  const table: [string, { slug: string; reports?: Record<string, unknown>; configError?: string }, Record<string, boolean>][] = [
    ["nothing set: built-in status, off", { slug: "p" }, { status: false, digest: false }],
    ["Home's own enabled is ignored for a project", { slug: "p", reports: {} }, { status: false, digest: false }],
    ["a project enables an inherited type", { slug: "p", reports: { digest: { enabled: true } } }, { status: false, digest: true }],
    ["a project enables the built-in", { slug: "p", reports: { status: { enabled: true } } }, { status: true, digest: false }],
    ["a non-boolean enable is off", { slug: "p", reports: { status: { enabled: "true" } } }, { status: false, digest: false }],
    ["an unreadable project arms nothing", { slug: "p", reports: { status: { enabled: true } }, configError: "bad" }, { status: false, digest: false }],
  ];
  for (const [label, project, want] of table) {
    it(label, () => {
      const got = effectiveReportTypes(project as never, root as never);
      expect(Object.fromEntries(got.map((t) => [t.type, t.enabled]))).toEqual(want);
    });
  }

  it("merges field by field: built-in < Home < project; origin and inherited", () => {
    const got = effectiveReportTypes({ slug: "p", reports: { digest: { model: "m" }, own: { schedule: { interval: "1d" } } } }, root);
    expect(got.map((t) => t.type)).toEqual(["digest", "own", "status"]);
    const [digest, own, status] = got;
    expect(digest).toMatchObject({ origin: "home", inherited: true, schedule: { cron: "0 9 * * 1" }, model: "m", trigger: "report-digest" });
    expect(own).toMatchObject({ origin: "project", inherited: false, schedule: { interval: "1d" } });
    expect(status).toMatchObject({ origin: "builtin", inherited: true, schedule: { cron: "0 6 * * *" } });
  });

  it("Home's own switch applies to Home; an unreadable root leaves the built-ins", () => {
    const home = effectiveReportTypes(root, root);
    expect(home.find((t) => t.type === "status")).toMatchObject({ enabled: true, origin: "builtin" });
    expect(home.find((t) => t.type === "digest")).toMatchObject({ enabled: true, origin: "home", inherited: false });
    expect(effectiveReportTypes({ slug: "p" }, null).map((t) => t.type)).toEqual(Object.keys(BUILTIN_REPORT_TYPES));
  });
});

describe("derived triggers", () => {
  it("one report-<type> per effective type: fixed capability, expect report, prompt = template", () => {
    const d = derivedTriggers({ slug: "p" }, null);
    // M14: `consolidate` is derived everywhere too (unarmed while its behaviour is off).
    expect(Object.keys(d)).toEqual(["report-status", "consolidate"]);
    const t = d["report-status"]!;
    expect(t).toMatchObject({
      trigger: { type: "schedule", cron: "0 8 * * *" },
      enabled: false,
      run: { tools: [...REPORT_TRIGGER_TOOLS], maxTurns: 20, expect: { kind: "report", report: "status" }, session: "new" },
      derived: { kind: "report", report: "status" },
    });
    expect(t.run.prompt).toContain("write_report");
    expect(t.run.prompt).toContain('Do NOT write "Needs you" or "Alerts"');
    expect(t.run.permissionMode).toBeUndefined();
    // A promptFile replaces the inline prompt (the template stays as the fallback).
    const f = derivedTriggers({ slug: "p", reports: { status: { promptFile: "s.md", model: "m" } } }, null)["report-status"]!;
    expect(f.run).toMatchObject({ promptFile: "s.md", model: "m" });
    expect(f.run.prompt).toBeUndefined();
    expect(f.derived!.template).toContain("write_report");
  });

  it("is armed only when enabled (through the keeper schedules projection)", () => {
    const off = triggersToHerdctlSchedules(effectiveTriggers({ slug: "p" }, null));
    expect(off?.["report-status"]).toMatchObject({ enabled: false, cron: "0 8 * * *" });
    const on = triggersToHerdctlSchedules(effectiveTriggers({ slug: "p", reports: { status: { enabled: true } } }, null));
    expect(on?.["report-status"]).toMatchObject({ enabled: true });
  });

  it("a behaviour gating report-status gates it; the config-unreadable wildcard too", () => {
    const eff = effectiveTriggers({ slug: "p", reports: { status: { enabled: true } } }, null);
    const gated = effectiveBehaviours(
      { slug: "p", behaviours: { publish: { triggers: ["report-status"] } } },
      null,
    );
    expect(triggerGate("report-status", eff["report-status"], gated)).toMatchObject({ open: false, off: ["publish"] });
    expect(triggersToHerdctlSchedules(eff, triggerGatePredicate(gated))?.["report-status"]?.enabled).toBe(false);
    const broken = effectiveBehaviours({ slug: "p", configError: "bad", behavioursUnknown: true }, null);
    expect(triggerGate("report-status", eff["report-status"], broken).open).toBe(false);
  });

  it("a declared trigger under a derived name is replaced, keeping its behaviour binding", () => {
    const declared = sanitizeTrigger({
      trigger: { type: "schedule", cron: "* * * * *" },
      run: { prompt: "anything", tools: ["Bash"], behaviour: "publish" },
      enabled: true,
    })!;
    const eff = effectiveTriggers({ slug: "p", triggers: { "report-status": declared, wake: declared } }, null);
    expect(eff["report-status"]!.run.tools).toEqual([...REPORT_TRIGGER_TOOLS]);
    expect(eff["report-status"]!.run.behaviour).toBe("publish");
    expect(eff["report-status"]!.enabled).toBe(false);
    expect(eff.wake).toBe(declared);
  });

  it("the derived marker is never read from project.yaml (no declared trigger can pose as a report run)", () => {
    const fake = sanitizeTriggers({
      "report-status": {
        trigger: { type: "schedule", cron: "0 8 * * *" },
        run: { prompt: "x" },
        derived: { kind: "report", report: "status", template: "x" },
      },
    })!;
    expect((fake["report-status"] as { derived?: unknown }).derived).toBeUndefined();
    expect(runKindOf(toTriggerDto("p", "report-status", fake["report-status"]!))).toBe("wake");
    const real = derivedTriggers({ slug: "p" }, null)["report-status"]!;
    expect(runKindOf(toTriggerDto("p", "report-status", real))).toBe("report");
  });

  it("reserved names: report-* and consolidate", () => {
    for (const n of ["report-status", "report-x", "report-", "consolidate"]) expect([n, isReservedTriggerName(n)]).toEqual([n, true]);
    for (const n of ["wake", "reports", "status-report", "consolidate-memory", "Report-x"]) {
      expect([n, isReservedTriggerName(n)]).toEqual([n, false]);
    }
  });

  it("the agent trigger guard refuses set and remove on a reserved name", async () => {
    const store = { get: async (slug: string) => ({ slug }) };
    for (const op of ["set_trigger", "remove_trigger"] as const) {
      const guard = agentTriggerGuard(store, op, "report-status");
      await expect(guard({ slug: "p", dir: "/nonexistent" })).rejects.toBeInstanceOf(GatedTriggerError);
      await expect(guard({ slug: "p", dir: "/nonexistent" })).rejects.toThrow(/reserved/);
    }
    await expect(agentTriggerGuard(store, "set_trigger", "consolidate")({ slug: "p", dir: "/nonexistent" })).rejects.toThrow(/reserved/);
  });
});

describe("write_report composition", () => {
  it("strips model-written Needs you / Alerts sections and a leading title, fence-aware", () => {
    const body = [
      "# Status: my own title",
      "",
      "## Needs you",
      "- fake ask",
      "",
      "## In flight",
      "- x",
      "```md",
      "## Alerts",
      "```",
      "## ALERTS:",
      "- fake alert",
      "# Needs You",
      "- another",
      "## Notes",
      "- y",
    ].join("\n");
    expect(stripServerSections(body)).toBe(["## In flight", "- x", "```md", "## Alerts", "```", "## Notes", "- y"].join("\n"));
    expect(stripServerSections("## Needs you\n- only this")).toBe("");
  });

  it("renders Needs you (awaiting-ed only, linked, oldest first) and Alerts; empty states", () => {
    const tasks = [
      task({ id: "t-260926-bbbb", title: "Second [draft]", created: "2026-09-26T08:00:00Z", options: ["merge", "skip"] }),
      task({ id: "t-260926-aaaa", title: "First" }),
      task({ id: "t-260926-cccc", title: "Open one", status: "open" }),
    ];
    expect(renderNeedsYou("acme", tasks)).toBe(
      [
        "- [First](/projects/acme/tasks#t-260926-aaaa) — Merge?",
        "- [Second \\[draft\\]](/projects/acme/tasks#t-260926-bbbb) — Merge? (options: merge / skip)",
      ].join("\n"),
    );
    expect(renderNeedsYou("", [task({})])).toContain("](/tasks#t-260926-aaaa)");
    expect(renderNeedsYou("acme", [])).toBe("Nothing needs you right now.");
    expect(renderAlerts([alert])).toBe("- **warning** `stale:publish-check` — No met run of publish-check in 48h.");
    expect(renderAlerts([])).toBe("No alerts.");
    expect(reportTypeTitle("weekly-digest")).toBe("Weekly digest");
  });

  it("composes frontmatter, title, the server sections, then the body", () => {
    const c = composeReport({
      type: "status",
      slug: "acme",
      projectName: "Acme Site",
      date: "2026-09-26",
      generated: "2026-09-26T08:00:00Z",
      runId: "r-260926-0800-aa",
      previous: "2026-09-25",
      body: "## In flight\n- x",
      tasks: [task({})],
      alerts: [alert],
    });
    expect(c.frontmatter).toEqual({ type: "status", generated: "2026-09-26T08:00:00Z", run: "r-260926-0800-aa", previous: "2026-09-25" });
    expect(c.body).toBe(
      [
        "# Status: Acme Site, 2026-09-26",
        "",
        "## Needs you",
        "- [A task](/projects/acme/tasks#t-260926-aaaa) — Merge?",
        "",
        "## Alerts",
        "- **warning** `stale:publish-check` — No met run of publish-check in 48h.",
        "",
        "## In flight",
        "- x",
        "",
      ].join("\n"),
    );
  });
});

describe("write_report: the writer and the state op", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpDir("managers-reports-");
    await fs.mkdir(path.join(root, "acme"), { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("writes dated + current and links the previous dated report (not today's)", async () => {
    let now = new Date("2026-09-25T08:00:00Z");
    const writer = new StateWriter(new EpisodesStore(), () => now);
    const ws = { key: "acme", layout: workspaceLayout(path.join(root, "acme")) };
    const actor = { kind: "agent" as const, name: "manager", author: { name: "b", email: "b@x" } };
    const first = await writer.writeReport(ws, { type: "status", body: "## Notes\n- one" }, actor);
    expect(first).toMatchObject({ date: "2026-09-25", previous: null, file: "reports/status/2026-09-25.md", currentFile: "reports/status/current.md" });
    now = new Date("2026-09-26T08:00:00Z");
    const second = await writer.writeReport(ws, { type: "status", body: "## Notes\n- two" }, actor);
    expect(second.previous).toBe("2026-09-25");
    now = new Date("2026-09-26T09:00:00Z");
    const third = await writer.writeReport(ws, { type: "status", body: "## Notes\n- three" }, actor);
    expect(third.previous).toBe("2026-09-25");
    const dir = path.join(root, "acme", "reports", "status");
    expect((await fs.readdir(dir)).sort()).toEqual(["2026-09-25.md", "2026-09-26.md", "current.md"]);
    const cur = await fs.readFile(path.join(dir, "current.md"), "utf8");
    expect(cur).toBe(await fs.readFile(path.join(dir, "2026-09-26.md"), "utf8"));
    expect(parseFrontmatter(cur).data).toMatchObject({ type: "status", generated: "2026-09-26T09:00:00Z", previous: "2026-09-25" });
    expect(cur).toContain("- three");
  });

  const opsFor = (types: string[]) => {
    const state = new ManagersState(root);
    return buildStateOps({
      state,
      resolveDir: async (slug) => (slug === "" ? root : path.join(root, slug)),
      currentProjectSlug: "acme",
      currentSessionId: () => null,
      currentRunId: () => null,
      origin: "scheduled",
      botAuthor: { name: "managers-bot", email: "b@x" },
      loadAlerts: async () => [alert],
      loadBriefing: async () => {
        throw new Error("unused");
      },
      loadReportContext: async () => ({ name: "Acme Site", types }),
    });
  };

  it("an unknown type is refused and nothing is written", async () => {
    const ops = opsFor(["status"]);
    await expect(ops.writeReport("acme", { type: "bogus", body: "## Notes\n- x" })).rejects.toThrow(/Unknown report type "bogus"/);
    await expect(ops.writeReport("acme", { type: "Not Kebab", body: "x" })).rejects.toThrow(/kebab-case/);
    await expect(fs.stat(path.join(root, "acme", "reports"))).rejects.toThrow();
  });

  it("a body that is only server sections is refused; otherwise the server sections replace the model's", async () => {
    const ops = opsFor(["status"]);
    await expect(ops.writeReport("acme", { type: "status", body: "## Needs you\n- fake\n## Alerts\n- fake" })).rejects.toThrow(
      /empty once the server-rendered/,
    );
    await fs.mkdir(path.join(root, "acme", "tasks", "open"), { recursive: true });
    const r = await ops.writeReport("acme", { type: "status", body: "## Needs you\n- fake\n\n## In flight\n- real" });
    const text = await fs.readFile(path.join(root, "acme", r.currentFile), "utf8");
    expect(text).not.toContain("- fake");
    expect(text).toContain("## Needs you\nNothing needs you right now.");
    expect(text).toContain("`stale:publish-check`");
    expect(text).toContain("## In flight\n- real");
    expect(text).toMatch(/^---\ntype: status\n/);
  });
});

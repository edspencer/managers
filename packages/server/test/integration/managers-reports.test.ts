/**
 * Managers M10: the report primitive on the real app.
 *
 * Every project has the built-in `status` report type, so every project has a
 * DERIVED trigger `report-status`: registered as its own scoped agent (Read,
 * Grep, Glob + the injected managers tools), forwarded into the keeper's
 * schedules but armed only when `reports.status.enabled` is true in the
 * project's own file. The Refresh route fires it regardless of `enabled`, the
 * fake `claude` calls `write_report` from the prompt file, and the server writes
 * the dated + current report with its own "Needs you" and "Alerts" sections.
 *
 * Also: derived names are reserved (Triggers REST and set_trigger), a behaviour
 * gating `report-status` gates the Refresh and the arming too, an unknown report
 * type is an error tool result that writes nothing, and the `reports:` block
 * survives an unrelated PATCH and a Triggers-tab PUT (the §4 round trip).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { keeperAgentName, triggerAgentName } from "../../src/herdctl-agent-names.js";
import { parseFrontmatter } from "../../src/managers/frontmatter.js";
import type { Project } from "../../src/projects.js";

type Block = { type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Line = { type: string; message?: { content?: string | Block[] } };

async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === `${sessionId}.jsonl`) return path.join((e as unknown as { parentPath: string }).parentPath, e.name);
  }
  return null;
}

async function finishedTranscript(root: string, sessionId: string, timeoutMs = 30_000): Promise<Line[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await findTranscript(root, sessionId);
    if (file) {
      const lines = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Line);
      if (lines.some((l) => l.type === "result")) return lines;
    }
    if (Date.now() > deadline) throw new Error(`no finished transcript for ${sessionId}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Every tool call in a transcript with its result. */
function toolCalls(lines: Line[]) {
  const results = new Map<string, Block>();
  for (const l of lines) {
    if (l.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
  }
  const calls: { name: string; content: string; isError: boolean }[] = [];
  for (const l of lines) {
    if (l.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id!);
      calls.push({ name: b.name!, content: JSON.stringify(r?.content ?? ""), isError: r?.is_error === true });
    }
  }
  return calls;
}

type Run = {
  id: string;
  trigger: string;
  kind: string;
  status: string;
  sessionId: string | null;
  reports: string[];
  expect: { kind: string; report?: string | null } | null;
  expectResult: string | null;
  error: string | null;
};

const STATUS_BODY =
  "## Needs you\\n- the model's own list, which the server drops\\n\\n## In flight\\n- Pricing rewrite: waiting on Ed.\\n\\n## Notes\\n- Quiet week.";

describe("integration: the report primitive (M10)", () => {
  let t: TestApp;
  let acme: Project;
  const api = (slug: string) => `/api/projects/${slug}/managers`;
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const agent = (name: string) =>
    t.herdctl.manager.getAgents().find((a) => a.name === name) as unknown as
      | { allowed_tools?: string[]; max_turns?: number; schedules?: Record<string, { enabled?: boolean; cron?: string }> }
      | undefined;
  const yamlFile = (slug: string) => path.join(t.projectsRoot, slug, "project.yaml");

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const waitRun = (slug: string, id: string) =>
    waitFor(async () => {
      const r = (await inject("GET", `${api(slug)}/runs/${id}`)).json() as { run?: Run };
      return r.run && r.run.status !== "running" ? r.run : null;
    });

  /** Edit a workspace's project.yaml by hand (`reports:` is file-only), then re-register. */
  async function editYaml(slug: string, fn: (doc: Record<string, unknown>) => void): Promise<void> {
    const file = slug === "" ? path.join(t.projectsRoot, "project.yaml") : yamlFile(slug);
    const doc = ((await fs.readFile(file, "utf8").then((r) => YAML.parse(r)).catch(() => null)) ?? {}) as Record<string, unknown>;
    fn(doc);
    await fs.writeFile(file, YAML.stringify(doc), "utf8");
    await t.herdctl.ensureProjectAgent(await t.projects.get(slug === "" ? "" : slug));
    if (slug === "" && acme) await t.herdctl.ensureProjectAgent(await t.projects.get(acme.slug));
  }

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      gitRepo: true,
      // Agents get the trigger tools, so the reserved-name refusal is exercised for real.
      env: { MANAGERS_SELF_MCP_WRITE: "1", MANAGERS_HOOKS_MCP: "1" },
    });
    acme = ((await inject("POST", "/api/projects", { name: "Acme Site" })).json() as { project: Project }).project;
    const dir = path.join(t.projectsRoot, acme.slug, ".managers", "triggers");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "status.md"),
      `Write the status report. [[MCP managers.write_report {"type":"status","body":"${STATUS_BODY}"}]]\n`,
      "utf8",
    );
    for (const [title, ask] of [
      ["Pick the post title", "Which title?"],
      ["Decide the enterprise price", "Contact us, or a price?"],
    ]) {
      const res = await inject("POST", `${api(acme.slug)}/tasks`, { title, status: "awaiting-ed", ask, options: ["a", "b"] });
      expect(res.statusCode).toBe(201);
    }
    await inject("POST", `${api(acme.slug)}/tasks`, { title: "An open task", status: "open" });
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("empty state: every project lists the built-in status type, unscheduled, with no report yet", async () => {
    const other = ((await inject("POST", "/api/projects", { name: "Empty Project" })).json() as { project: Project }).project;
    const body = (await inject("GET", `${api(other.slug)}/reports`)).json() as { reports: Record<string, unknown>[] };
    expect(body.reports).toEqual([
      expect.objectContaining({
        type: "status",
        defined: true,
        enabled: false,
        origin: "builtin",
        inherited: true,
        trigger: "report-status",
        current: null,
        dates: [],
      }),
    ]);
    const cur = await inject("GET", `${api(other.slug)}/reports/status`);
    expect(cur.statusCode).toBe(200);
    expect(cur.json()).toMatchObject({ type: "status", current: null, dates: [] });
    expect((await inject("GET", `${api(other.slug)}/reports/nope`)).statusCode).toBe(404);
    // Home too.
    const home = (await inject("GET", `/api/root/managers/reports`)).json() as { reports: { type: string }[] };
    expect(home.reports.map((r) => r.type)).toEqual(["status"]);
  });

  it("the derived trigger: its own scoped agent (Read/Grep/Glob), forwarded but NOT armed while disabled", async () => {
    const scoped = agent(triggerAgentName(acme.slug, "report-status"));
    expect(scoped).toBeTruthy();
    expect(scoped!.allowed_tools).toEqual(["Read", "Grep", "Glob"]);
    expect(scoped!.max_turns).toBe(20);
    const k = agent(keeperAgentName(acme.slug))!;
    expect(k.schedules?.["report-status"]).toMatchObject({ enabled: false, cron: "0 8 * * *" });
    // Never persisted.
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).triggers?.["report-status"]).toBeUndefined();
  });

  it("a derived trigger is armed only when the project enables it", async () => {
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { enabled: true, schedule: { cron: "0 3 1 1 *" }, promptFile: "status.md" } };
    });
    expect(agent(keeperAgentName(acme.slug))!.schedules?.["report-status"]).toMatchObject({ enabled: true, cron: "0 3 1 1 *" });
    const list = (await inject("GET", `${api(acme.slug)}/reports`)).json() as { reports: Record<string, unknown>[] };
    expect(list.reports[0]).toMatchObject({ type: "status", enabled: true, origin: "builtin", promptFile: "status.md" });
    // Home's own `enabled` never reaches a project.
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { promptFile: "status.md" } };
    });
    await editYaml("", (d) => {
      d.reports = { status: { enabled: true } };
    });
    expect(agent(keeperAgentName(acme.slug))!.schedules?.["report-status"]?.enabled).toBe(false);
    expect(agent(keeperAgentName(""))!.schedules?.["report-status"]?.enabled).toBe(true);
    await editYaml("", (d) => {
      delete d.reports;
    });
  });

  it("Refresh fires while disabled: dated + current written, server sections composed, expect met", async () => {
    await fs.mkdir(path.join(t.projectsRoot, acme.slug, "reports", "status"), { recursive: true });
    await fs.writeFile(
      path.join(t.projectsRoot, acme.slug, "reports", "status", "2020-01-01.md"),
      "---\ntype: status\ngenerated: 2020-01-01T08:00:00Z\n---\n# Old\n",
      "utf8",
    );
    const res = await inject("POST", `${api(acme.slug)}/reports/status/refresh`);
    expect(res.statusCode).toBe(202);
    const body = res.json() as { runId: string; sessionId: string; trigger: string };
    expect(body.trigger).toBe("report-status");
    expect(body.runId).toMatch(/^r-/);
    expect(body.sessionId).toBeTruthy();
    const run = await waitRun(acme.slug, body.runId);
    expect(run).toMatchObject({ trigger: "report-status", kind: "report", status: "succeeded", reports: ["status"], expectResult: "met" });
    expect(run.expect).toMatchObject({ kind: "report", report: "status" });

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(t.projectsRoot, acme.slug, "reports", "status");
    const dated = await fs.readFile(path.join(dir, `${today}.md`), "utf8");
    const current = await fs.readFile(path.join(dir, "current.md"), "utf8");
    expect(current).toBe(dated);
    const doc = parseFrontmatter(current);
    expect(doc.data).toMatchObject({ type: "status", run: body.runId, previous: "2020-01-01" });
    expect(typeof doc.data.generated).toBe("string");
    expect(doc.body).toMatch(new RegExp(`^# Status: Acme Site, ${today}\\n`));
    // Server sections, in order, before the model's body.
    const order = ["## Needs you", "## Alerts", "## In flight", "## Notes"].map((h) => doc.body.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(doc.body.match(/## Needs you/g)).toHaveLength(1);
    expect(doc.body).not.toContain("the model's own list");
    expect(doc.body).toContain(`](/projects/${acme.slug}/tasks#t-`);
    expect(doc.body).toContain("Pick the post title");
    expect(doc.body).toContain("Decide the enterprise price");
    expect(doc.body).not.toContain("An open task");

    const list = (await inject("GET", `${api(acme.slug)}/reports`)).json() as {
      reports: { type: string; enabled: boolean; current: { generated: string | null } | null; dates: string[] }[];
    };
    expect(list.reports[0]).toMatchObject({ type: "status", enabled: false });
    expect(list.reports[0]!.current?.generated).toBe(doc.data.generated);
    expect(list.reports[0]!.dates).toEqual([today, "2020-01-01"]);
  });

  it("the report run was briefed as a report (previous report + changes), with the template's fallback", async () => {
    const { runs } = (await inject("GET", `${api(acme.slug)}/runs?trigger=report-status`)).json() as { runs: Run[] };
    const detail = (await inject("GET", `${api(acme.slug)}/runs/${runs[0]!.id}`)).json() as { briefingText: string | null };
    expect(detail.briefingText).toContain("- Kind: report");
    expect(detail.briefingText).toContain("## Previous status report");
    expect(detail.briefingText).toContain("## Changed since the previous report");
    expect(detail.briefingText).toContain("## Schedule");
  });

  it("Refresh: 404 for an undefined type, 400 for a malformed one", async () => {
    expect((await inject("POST", `${api(acme.slug)}/reports/digest/refresh`)).statusCode).toBe(404);
    expect((await inject("POST", `${api(acme.slug)}/reports/Not_Kebab/refresh`)).statusCode).toBe(400);
  });

  it("derived names are reserved: the Triggers REST refuses report-* and consolidate", async () => {
    for (const name of ["report-status", "report-anything", "consolidate"]) {
      const res = await inject("PUT", `/api/projects/${acme.slug}/triggers/${name}`, {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: { prompt: "x" },
        enabled: true,
      });
      expect([name, res.statusCode]).toEqual([name, 400]);
      expect((res.json() as { error: string }).error).toContain("reserved");
    }
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).triggers?.consolidate).toBeUndefined();
  });

  it("an agent's set_trigger / remove_trigger on a derived name is refused", async () => {
    await t.triggers.set(acme.slug, "reserver", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: {
        prompt:
          `[[MCP managers.set_trigger {"project":"${acme.slug}","name":"report-status","type":"schedule","cron":"* * * * *","prompt":"x","enabled":true}]] ` +
          `[[MCP managers.remove_trigger {"project":"${acme.slug}","name":"report-status"}]]`,
      },
      enabled: false,
    });
    const res = await inject("POST", `/api/projects/${acme.slug}/triggers/reserver/run`);
    expect(res.statusCode).toBe(202);
    const calls = toolCalls(await finishedTranscript(t.cfg.dataDir, (res.json() as { sessionId: string }).sessionId));
    expect(calls.map((c) => [c.name, c.isError])).toEqual([
      ["mcp__managers__set_trigger", true],
      ["mcp__managers__remove_trigger", true],
    ]);
    expect(calls[0]!.content).toContain("reserved");
    expect(calls[1]!.content).toContain("remove_trigger refused");
    const k = agent(keeperAgentName(acme.slug))!;
    expect(k.schedules?.["report-status"]).toMatchObject({ enabled: false, cron: "0 8 * * *" });
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).triggers?.["report-status"]).toBeUndefined();
  });

  it("a behaviour gating report-status gates the Refresh (409, nothing runs) and the arming", async () => {
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { enabled: true, promptFile: "status.md" } };
      d.behaviours = { "publish-status": { description: "Publish the status report", triggers: ["report-status"] } };
    });
    expect(agent(keeperAgentName(acme.slug))!.schedules?.["report-status"]?.enabled).toBe(false);
    const before = ((await inject("GET", `${api(acme.slug)}/runs?trigger=report-status`)).json() as { runs: Run[] }).runs.length;
    const res = await inject("POST", `${api(acme.slug)}/reports/status/refresh`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "behaviour_off", behaviours: ["publish-status"] });
    // Run now on the derived name is refused the same way.
    expect((await inject("POST", `/api/projects/${acme.slug}/triggers/report-status/run`)).statusCode).toBe(409);
    const after = ((await inject("GET", `${api(acme.slug)}/runs?trigger=report-status`)).json() as { runs: Run[] }).runs.length;
    expect(after).toBe(before);
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { promptFile: "status.md" } };
      delete d.behaviours;
    });
  });

  it("a hand-written trigger under a derived name is replaced, but keeps its behaviour gate", async () => {
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { enabled: true, promptFile: "status.md" } };
      d.behaviours = { "publish-status": { description: "x" } };
      d.triggers = {
        ...(d.triggers as Record<string, unknown>),
        "report-status": {
          trigger: { type: "schedule", cron: "* * * * *" },
          run: { prompt: "Do anything.", tools: ["Bash"], behaviour: "publish-status" },
          enabled: true,
        },
      };
    });
    const k = agent(keeperAgentName(acme.slug))!;
    expect(k.schedules?.["report-status"]).toMatchObject({ enabled: false, cron: "0 8 * * *" });
    expect(agent(triggerAgentName(acme.slug, "report-status"))!.allowed_tools).toEqual(["Read", "Grep", "Glob"]);
    expect((await inject("POST", `${api(acme.slug)}/reports/status/refresh`)).statusCode).toBe(409);
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { promptFile: "status.md" } };
      delete d.behaviours;
      const tr = { ...(d.triggers as Record<string, unknown>) };
      delete tr["report-status"];
      d.triggers = tr;
    });
  });

  it("unhappy path: write_report with an unknown type is an error tool result and writes nothing", async () => {
    await t.triggers.set(acme.slug, "bogus-report", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: '[[MCP managers.write_report {"type":"bogus","body":"## Notes\\n- x"}]]' },
      enabled: false,
    });
    const res = await inject("POST", `/api/projects/${acme.slug}/triggers/bogus-report/run`);
    expect(res.statusCode).toBe(202);
    const run = await waitFor(async () => {
      const { runs } = (await inject("GET", `${api(acme.slug)}/runs?trigger=bogus-report`)).json() as { runs: Run[] };
      return runs.find((r) => r.status !== "running") ?? null;
    });
    expect(run.reports).toEqual([]);
    await expect(fs.stat(path.join(t.projectsRoot, acme.slug, "reports", "bogus"))).rejects.toThrow();
    const calls = toolCalls(await finishedTranscript(t.cfg.dataDir, run.sessionId!));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "mcp__managers__write_report", isError: true });
    expect(calls[0]!.content).toContain("Unknown report type");
  });

  it("§4 round trip: an unrelated PATCH and a Triggers-tab PUT keep the reports: block", async () => {
    await editYaml(acme.slug, (d) => {
      d.reports = { status: { enabled: true, schedule: { interval: "6h" }, promptFile: "status.md", model: "claude-sonnet-4-5" } };
    });
    const want = { status: { enabled: true, schedule: { interval: "6h" }, promptFile: "status.md", model: "claude-sonnet-4-5" } };
    expect((await inject("PATCH", `/api/projects/${acme.slug}`, { summary: "Changed" })).statusCode).toBe(200);
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).reports).toEqual(want);
    const put = await inject("PUT", `/api/projects/${acme.slug}/triggers/wake`, {
      trigger: { type: "schedule", cron: "0 7 * * *" },
      run: { promptFile: "wake.md" },
      enabled: false,
    });
    expect(put.statusCode).toBe(200);
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).reports).toEqual(want);
    // The generic PATCH cannot write it.
    await inject("PATCH", `/api/projects/${acme.slug}`, { reports: { status: { enabled: false } } });
    expect(YAML.parse(await fs.readFile(yamlFile(acme.slug), "utf8")).reports).toEqual(want);
  });
});

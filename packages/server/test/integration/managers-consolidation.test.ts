/**
 * Managers M14: consolidation ("reflection") and the real `memory_op`, on the real
 * app with the fake `claude` and a git projects root.
 *
 *   • it ships OFF: nothing is armed, "Run consolidation now" is a 409;
 *   • switched on (Settings → Behaviours), the derived `consolidate` trigger is
 *     armed, and a run's `memory_op add` writes the fact, the regenerated
 *     MEMORY.md (Ed's preamble intact), and the server's #reflection episode,
 *     committed by managers-bot;
 *   • a pattern with ONE evidence id is an error tool result and writes nothing;
 *   • `memory_op` in a scheduled wake is refused ("not available in this turn"),
 *     and allowed in a turn Ed's own message drives;
 *   • no agent can `run_trigger consolidate`;
 *   • the early fire: an agent's episode pushing the importance past the
 *     threshold starts a consolidation run by itself;
 *   • switched off again, nothing is armed and the `config:` block survives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
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
async function transcript(root: string, sessionId: string, timeoutMs = 30_000): Promise<Line[]> {
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

type Run = { id: string; trigger: string; kind: string; status: string; sessionId: string | null; episodes: string[] };

describe("integration: consolidation and memory_op (M14)", () => {
  let t: TestApp;
  let acme: Project;
  let ws: WsClient;
  let ids: string[] = [];
  const api = (slug: string) => `/api/projects/${slug}/managers`;
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();
  const dir = () => path.join(t.projectsRoot, acme.slug);
  const read = (rel: string) => fs.readFile(path.join(dir(), rel), "utf8");
  const exists = (rel: string) =>
    fs
      .access(path.join(dir(), rel))
      .then(() => true)
      .catch(() => false);
  const keeper = () =>
    t.herdctl.manager.getAgents().find((a) => a.name === keeperAgentName(acme.slug)) as unknown as {
      schedules?: Record<string, { enabled?: boolean; cron?: string }>;
    };
  const prompt = (name: string, text: string) =>
    fs.writeFile(path.join(dir(), ".managers", "triggers", name), text, "utf8");

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const waitRun = (id: string) =>
    waitFor(async () => {
      const r = (await inject("GET", `${api(acme.slug)}/runs/${id}`)).json() as { run?: Run };
      return r.run && r.run.status !== "running" ? r.run : null;
    });
  const consolidationRuns = async () =>
    ((await inject("GET", `${api(acme.slug)}/runs?trigger=consolidate`)).json() as { runs: Run[] }).runs;
  const toggle = (enabled: boolean) =>
    inject("PATCH", `${api(acme.slug)}/behaviours/consolidate-memory`, { enabled });
  async function editYaml(fn: (doc: Record<string, unknown>) => void): Promise<void> {
    const file = path.join(dir(), "project.yaml");
    const doc = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    fn(doc);
    await fs.writeFile(file, YAML.stringify(doc), "utf8");
    await t.herdctl.ensureProjectAgent(await t.projects.get(acme.slug));
  }
  async function runNow(trigger: string): Promise<{ run: Run; calls: ReturnType<typeof toolCalls> }> {
    const res = await inject("POST", `/api/projects/${acme.slug}/triggers/${trigger}/run`);
    expect(res.statusCode).toBe(202);
    const sessionId = (res.json() as { sessionId: string }).sessionId;
    const lines = await transcript(t.tmp, sessionId);
    const run = await waitFor(async () => {
      const runs = ((await inject("GET", `${api(acme.slug)}/runs?trigger=${trigger}`)).json() as { runs: Run[] }).runs;
      const r = runs.find((x) => x.sessionId === sessionId && x.status !== "running");
      return r ?? null;
    });
    return { run, calls: toolCalls(lines) };
  }

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      gitRepo: true,
      // Agents get the trigger tools, so `run_trigger consolidate` is refused for real.
      env: { MANAGERS_SELF_MCP_WRITE: "1", MANAGERS_HOOKS_MCP: "1", MANAGERS_AUTOCOMMIT_DEBOUNCE_MS: "200" },
    });
    acme = ((await inject("POST", "/api/projects", { name: "Acme Site" })).json() as { project: Project }).project;
    await fs.mkdir(path.join(dir(), ".managers", "triggers"), { recursive: true });
    // Two journal-free log episodes to cite (written as Ed, so no early-fire check runs).
    const w = { key: acme.slug, layout: t.managers.layout(dir()) };
    const ed = { kind: "ed" as const, name: "ed", author: { name: "Ed", email: "ed@example.test" } };
    ids = [];
    for (const text of ["Review stalled the draft for five days.", "Review stalled the next draft too."]) {
      ids.push((await t.managers.writer.recordEpisode(w, { text, importance: 3 }, ed)).id);
    }
    // Ed's own MEMORY.md preamble, which every regeneration must keep.
    await fs.mkdir(path.join(dir(), "memory"), { recursive: true });
    await fs.writeFile(path.join(dir(), "memory", "MEMORY.md"), "# Acme memory\n\nEd wrote this line.\n", "utf8");
    await prompt(
      "consolidate.md",
      `Consolidate. [[MCP managers.memory_op {"op":"add","name":"qa-pattern","type":"pattern","description":"Reviews stall drafts.","evidence":["${ids[0]}","${ids[1]}"]}]]\n`,
    );
    const { port } = await listen(t.app);
    ws = await connectWs(port);
  }, 60_000);
  afterAll(async () => {
    ws?.close();
    await t?.teardown();
  });

  it("ships OFF: not armed, and Run consolidation now is a 409 behaviour_off", async () => {
    const state = (await inject("GET", `${api(acme.slug)}/consolidation`)).json() as Record<string, unknown>;
    expect(state).toMatchObject({ enabled: false, trigger: "consolidate", running: false, lastRun: null });
    expect(keeper().schedules?.consolidate).toMatchObject({ enabled: false, cron: "30 3 * * *" });
    // Its scoped agent exists (Read/Grep/Glob), like report-status.
    const scoped = t.herdctl.manager.getAgents().find((a) => a.name === triggerAgentName(acme.slug, "consolidate")) as unknown as
      | { allowed_tools?: string[]; max_turns?: number }
      | undefined;
    expect(scoped?.allowed_tools).toEqual(["Read", "Grep", "Glob"]);
    expect(scoped?.max_turns).toBe(30);
    const run = await inject("POST", `${api(acme.slug)}/consolidation/run`);
    expect(run.statusCode).toBe(409);
    expect(run.json()).toMatchObject({ code: "behaviour_off", behaviours: ["consolidate-memory"] });
    expect(await consolidationRuns()).toEqual([]);
  });

  it("switched on in Settings (keeping a hand-written config), it arms, and a run writes the fact, index, reflection and a bot commit", async () => {
    await editYaml((d) => {
      d.behaviours = { "consolidate-memory": { config: { promptFile: "consolidate.md", minGapHours: 0 } } };
    });
    expect((await toggle(true)).statusCode).toBe(200);
    const doc = YAML.parse(await read("project.yaml")) as { behaviours: Record<string, unknown> };
    expect(doc.behaviours["consolidate-memory"]).toEqual({ config: { promptFile: "consolidate.md", minGapHours: 0 }, enabled: true });
    expect(keeper().schedules?.consolidate).toMatchObject({ enabled: true, cron: "30 3 * * *" });
    const behaviours = (await inject("GET", `${api(acme.slug)}/behaviours`)).json() as {
      behaviours: { name: string; config: Record<string, unknown>; boundTriggers: { name: string; exists: boolean }[] }[];
    };
    const cm = behaviours.behaviours.find((b) => b.name === "consolidate-memory")!;
    expect(cm.config).toMatchObject({ schedule: "30 3 * * *", threshold: 40, minGapHours: 0, promptFile: "consolidate.md" });
    expect(cm.boundTriggers).toEqual([expect.objectContaining({ name: "consolidate", exists: true })]);

    const res = await inject("POST", `${api(acme.slug)}/consolidation/run`);
    expect(res.statusCode).toBe(202);
    const { runId, sessionId } = res.json() as { runId: string; sessionId: string };
    const run = await waitRun(runId);
    expect(run).toMatchObject({ kind: "consolidation", trigger: "consolidate", status: "succeeded" });
    const calls = toolCalls(await transcript(t.tmp, sessionId));
    const op = calls.find((c) => c.name === "mcp__managers__memory_op")!;
    expect(op.isError).toBe(false);

    const fact = parseFrontmatter(await read("memory/facts/qa-pattern.md"));
    expect(fact.data).toMatchObject({ type: "pattern", evidence: ids });
    expect(fact.body).toContain(`added by consolidation run ${runId}`);
    const index = await read("memory/MEMORY.md");
    expect(index.startsWith("# Acme memory\n\nEd wrote this line.\n\n<!-- managers:index -->\n")).toBe(true);
    expect(index).toMatch(/## pattern\n- \[\[qa-pattern\]\]: Reviews stall drafts\./);

    const log = await read(`log/${new Date().toISOString().slice(0, 7)}.md`);
    expect(log).toMatch(new RegExp(`run ${runId} · #reflection\\nConsolidation run ${runId} performed 1 memory op: add qa-pattern \\(pattern\\)\\.`));
    expect(run.episodes.length).toBe(1);

    // The briefing was the consolidation one.
    const detail = (await inject("GET", `${api(acme.slug)}/runs/${runId}`)).json() as { briefingText?: string };
    expect(detail.briefingText).toContain("## Memory protocol");
    expect(detail.briefingText).toContain(ids[0]!);
    expect(detail.briefingText).toContain("- Kind: consolidation");

    // Committed by the bot at run end: the fact, the index and the log together.
    await waitFor(async () => (git("log", "-1", "--format=%an", "--", `${acme.slug}/memory`) === "managers-bot" ? true : null));
    const files = git("log", "-1", "--name-only", "--format=", "--", `${acme.slug}/memory`).split("\n");
    expect(files).toEqual(expect.arrayContaining([`${acme.slug}/memory/facts/qa-pattern.md`, `${acme.slug}/memory/MEMORY.md`]));

    const state = (await inject("GET", `${api(acme.slug)}/consolidation`)).json() as Record<string, unknown>;
    expect(state).toMatchObject({ enabled: true, lastSucceeded: expect.objectContaining({ id: runId }) });
  });

  it("unhappy: a pattern with ONE evidence id is an error tool block, and no fact is written", async () => {
    await prompt(
      "consolidate.md",
      `Consolidate. [[MCP managers.memory_op {"op":"add","name":"qa-single","type":"pattern","description":"x","evidence":["${ids[0]}"]}]]\n`,
    );
    const res = await inject("POST", `${api(acme.slug)}/consolidation/run`);
    const { runId, sessionId } = res.json() as { runId: string; sessionId: string };
    await waitRun(runId);
    const op = toolCalls(await transcript(t.tmp, sessionId)).find((c) => c.name === "mcp__managers__memory_op")!;
    expect(op.isError).toBe(true);
    expect(op.content).toContain("a pattern needs at least 2 evidence episodes");
    expect(await exists("memory/facts/qa-single.md")).toBe(false);
    const log = await read(`log/${new Date().toISOString().slice(0, 7)}.md`);
    expect(log).toContain(`Consolidation run ${runId} performed no memory ops.`);
  });

  it("gate: a scheduled wake calling memory_op is refused with 'not available in this turn'", async () => {
    const put = await inject("PUT", `/api/projects/${acme.slug}/triggers/wake-mem`, {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: `Wake. [[MCP managers.memory_op {"op":"add","name":"from-wake","type":"user","description":"x"}]]`, session: "new" },
      enabled: false,
    });
    expect(put.statusCode).toBeLessThan(300);
    const { run, calls } = await runNow("wake-mem");
    expect(run.kind).toBe("wake");
    const op = calls.find((c) => c.name === "mcp__managers__memory_op")!;
    expect(op.isError).toBe(true);
    expect(op.content).toContain("not available in this turn");
    expect(await exists("memory/facts/from-wake.md")).toBe(false);
  });

  it("no agent may run_trigger consolidate (report triggers stay runnable)", async () => {
    await inject("PUT", `/api/projects/${acme.slug}/triggers/sneak`, {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: {
        prompt: `Sneak. [[MCP managers.run_trigger {"project":"${acme.slug}","name":"consolidate"}]] [[MCP managers.run_trigger {"project":"${acme.slug}","name":"report-status"}]]`,
        session: "new",
      },
      enabled: false,
    });
    const before = (await consolidationRuns()).length;
    const { calls } = await runNow("sneak");
    const [c, r] = calls.filter((x) => x.name === "mcp__managers__run_trigger");
    expect(c!.isError).toBe(true);
    expect(c!.content).toContain("the consolidate trigger cannot be run by an agent");
    expect(r!.isError).toBe(false);
    expect((await consolidationRuns()).length).toBe(before);
  });

  it("allowed in a turn Ed's own message drives (the WS chat:send path)", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: acme.slug,
        sessionId: null,
        message: `Please remember this. [[MCP managers.memory_op {"op":"add","name":"ed-said","type":"user","description":"Ed prefers Tuesday releases."}]]`,
      },
    });
    const done = await ws.waitFor(
      (e: WsEvent) => e.type === "chat:complete" && e.payload?.projectSlug === acme.slug,
      { from: mark, timeoutMs: 30_000 },
    );
    const sessionId = done.payload!.sessionId as string;
    const op = toolCalls(await transcript(t.tmp, sessionId)).find((c) => c.name === "mcp__managers__memory_op")!;
    expect(op.isError).toBe(false);
    const fact = await read("memory/facts/ed-said.md");
    expect(fact).toContain(`as Ed asked (chat ${sessionId})`);
    expect(await read("memory/MEMORY.md")).toMatch(/## user\n- \[\[ed-said\]\]/);
  });

  it("early fire: an agent's episode past the threshold starts a consolidation run by itself", async () => {
    await editYaml((d) => {
      d.behaviours = { "consolidate-memory": { enabled: true, config: { promptFile: "consolidate.md", minGapHours: 0, threshold: 1 } } };
    });
    await prompt("consolidate.md", "Consolidate: nothing to do.\n");
    const seen = new Set((await consolidationRuns()).map((r) => r.id));
    const before = seen.size;
    await inject("PUT", `/api/projects/${acme.slug}/triggers/busy`, {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: `Busy. [[MCP managers.record_episode {"text":"A lot happened.","importance":9}]]`, session: "new" },
      enabled: false,
    });
    await runNow("busy");
    const early = await waitFor(async () => {
      const fresh = (await consolidationRuns()).find((r) => !seen.has(r.id));
      return fresh && fresh.status !== "running" ? fresh : null;
    });
    expect(early.kind).toBe("consolidation");
    const detail = (await inject("GET", `${api(acme.slug)}/runs/${early.id}`)).json() as { briefingText?: string };
    expect(detail.briefingText).toContain("Why: Early consolidation: importance");
    // Its own #reflection episode does not fire another.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await consolidationRuns()).length).toBe(before + 1);
  });

  it("switched off: not armed, the Run button route refuses, and the config block survives", async () => {
    expect((await toggle(false)).statusCode).toBe(200);
    expect(keeper().schedules?.consolidate).toMatchObject({ enabled: false });
    expect((await inject("POST", `${api(acme.slug)}/consolidation/run`)).statusCode).toBe(409);
    const doc = YAML.parse(await read("project.yaml")) as { behaviours: Record<string, { config?: unknown; enabled?: boolean }> };
    expect(doc.behaviours["consolidate-memory"]).toMatchObject({ enabled: false, config: { promptFile: "consolidate.md" } });
    // An unrelated PATCH keeps it (the §4 round trip).
    await inject("PATCH", `/api/projects/${acme.slug}`, { summary: "Changed." });
    const again = YAML.parse(await read("project.yaml")) as { behaviours: Record<string, { config?: unknown }> };
    expect(again.behaviours["consolidate-memory"]!.config).toMatchObject({ promptFile: "consolidate.md", threshold: 1 });
  });
});

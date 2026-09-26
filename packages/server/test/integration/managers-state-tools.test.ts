/**
 * Managers M5: the `managers` MCP state tools, end to end, plus the write REST
 * routes and autocommit.
 *
 * Boots the REAL app with the projects root as a git repo and — deliberately —
 * with `MANAGERS_SELF_MCP=0` (the default `balanced` profile turns the chat-read
 * block ON): the state tools must be injected on every trigger turn regardless
 * (plan §2.3), while the switched-off chat-read block stays absent. A
 * trigger's "Run now" spawns the fake `claude`, whose `[[MCP managers.*]]`
 * directives call the state tools over herdctl's localhost bridge.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type Block = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
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
      calls.push({ name: b.name!, content: String(r?.content ?? ""), isError: r?.is_error === true });
    }
  }
  return calls;
}

const WRITER = "pdk_testinstance_statewriter000000000000000";
const READER = "pdk_testinstance_statereader000000000000000";

describe("integration: Managers state tools, write REST and autocommit (M5)", () => {
  let t: TestApp;
  let acme: Project;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();
  const botCommits = () => git("log", "--format=%an", "--author=managers-bot").split("\n").filter(Boolean).length;

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      gitRepo: true,
      configFile: {
        managementApi: {
          publicUrl: "https://managers.example.test",
          clients: {
            // An operator's `list_*` + read_chat: state READS, but no record_episode.
            reader: { auth: { ref: "env:MCP_STATE_READER" }, scope: { projects: ["*"], allow: ["list_*", "read_chat"] } },
            writer: {
              auth: { ref: "env:MCP_STATE_WRITER" },
              scope: { projects: ["*"], allow: ["list_tasks", "record_episode"] },
            },
          },
        },
      },
      env: { MCP_STATE_READER: READER, MCP_STATE_WRITER: WRITER, MANAGERS_SELF_MCP: "0" },
    });
    acme = ((await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme Site" } })).json() as {
      project: Project;
    }).project;
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function runPrompt(name: string, prompt: string): Promise<Line[]> {
    await t.triggers.set(acme.slug, name, {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt },
      enabled: false,
    });
    const res = await t.app.inject({ method: "POST", url: `/api/projects/${acme.slug}/triggers/${name}/run` });
    expect(res.statusCode).toBe(202);
    const { sessionId } = res.json() as { sessionId: string };
    return finishedTranscript(t.cfg.dataDir, sessionId);
  }

  async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("a trigger's record_episode + upsert_task write the files and ONE managers-bot commit", async () => {
    expect(t.cfg.selfMcpEnabled).toBe(false);
    const before = botCommits();
    const lines = await runPrompt(
      "qa-state",
      'QA [[MCP managers.record_episode {"text":"QA wrote this","importance":5,"tags":["qa"]}]] ' +
        '[[MCP managers.upsert_task {"title":"QA ask","status":"awaiting-ed","ask":"?"}]] ' +
        "[[MCP managers.list_projects {}]]",
    );
    const calls = toolCalls(lines);
    expect(calls.map((c) => c.name)).toEqual([
      "mcp__managers__record_episode",
      "mcp__managers__upsert_task",
      "mcp__managers__list_projects",
    ]);
    const [ep, task, lp] = calls;
    expect(ep!.isError).toBe(false);
    expect(task!.isError).toBe(false);
    // The chat-read block keeps its own gate: with MANAGERS_SELF_MCP=0 it is absent.
    expect(lp!.isError).toBe(true);

    const epOut = JSON.parse(ep!.content) as { id: string; file: string };
    const taskOut = JSON.parse(task!.content) as { id: string; file: string; status: string };
    expect(epOut.file).toMatch(/^log\/\d{4}-\d{2}\.md$/);
    expect(taskOut).toMatchObject({ status: "awaiting-ed", file: `tasks/open/${taskOut.id}.md` });
    expect(await fs.readFile(path.join(acme.dir, epOut.file), "utf8")).toContain("QA wrote this");
    expect(await fs.readFile(path.join(acme.dir, taskOut.file), "utf8")).toMatch(/^ask: "?\?"?$/m);

    // The turn ending flushes the debounce: one commit, by the bot, owned paths only.
    await waitFor(() => botCommits() === before + 1);
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n").sort();
    expect(files).toEqual([`${acme.slug}/${epOut.file}`, `${acme.slug}/${taskOut.file}`].sort());
    expect(git("status", "--porcelain", "--", `${acme.slug}/log`, `${acme.slug}/tasks`)).toBe("");
  });

  it("upsert_task awaiting-ed without an ask is an error tool result, and no file is written", async () => {
    const open = path.join(acme.dir, "tasks", "open");
    const before = await fs.readdir(open).catch(() => []);
    const lines = await runPrompt("qa-noask", '[[MCP managers.upsert_task {"title":"x","status":"awaiting-ed"}]]');
    const [call] = toolCalls(lines);
    expect(call!.isError).toBe(true);
    expect(call!.content).toMatch(/awaiting-ed requires an ask/);
    expect(await fs.readdir(open).catch(() => [])).toEqual(before);
    expect(lines.some((l) => l.type === "result")).toBe(true);
  });

  it("a trigger may not write another project's state", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Other One" } });
    const lines = await runPrompt(
      "qa-cross",
      '[[MCP managers.record_episode {"text":"sneaky","importance":1,"project":"other-one"}]]',
    );
    const [call] = toolCalls(lines);
    expect(call!.isError).toBe(true);
    expect(call!.content).toMatch(/not permitted/);
    await expect(fs.readdir(path.join(t.projectsRoot, "other-one", "log"))).rejects.toThrow();
  });

  // --- the external /mcp ------------------------------------------------------------

  async function rpc(token: string, body: unknown) {
    const res = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: body as Record<string, unknown>,
    });
    const line = res.body.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice("data: ".length)) : undefined;
  }
  const toolNames = async (token: string) =>
    ((await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools as { name: string }[]).map(
      (x) => x.name,
    );

  it("an external token lacking record_episode is not offered it; one granted it can write", async () => {
    const reader = await toolNames(READER);
    expect(reader).not.toContain("record_episode");
    expect(reader).not.toContain("upsert_task");
    expect(reader).toContain("list_tasks");

    const writer = await toolNames(WRITER);
    expect(writer.sort()).toEqual(["list_tasks", "record_episode"]);
    const r = await rpc(WRITER, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "record_episode", arguments: { text: "From CI", importance: 2, project: acme.slug } },
    });
    expect(r.result.isError).toBeFalsy();
    const out = JSON.parse(r.result.content[0].text) as { id: string };
    const log = await t.app.inject({ method: "GET", url: `/api/projects/${acme.slug}/managers/log` });
    expect((log.json() as { log: { entries: { id: string }[] } }).log.entries.map((e) => e.id)).toContain(out.id);
  });

  // --- the write REST -------------------------------------------------------------------

  const api = (method: "POST" | "PATCH", url: string, payload: unknown) =>
    t.app.inject({ method, url: `/api/projects/${acme.slug}/managers${url}`, payload: payload as object });

  it("POST/PATCH tasks: create, validate, move to done", async () => {
    const bad = await api("POST", "/tasks", { title: "x", status: "awaiting-ed" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid" });

    const c = await api("POST", "/tasks", { title: "From the UI", options: ["a", "b"] });
    expect(c.statusCode).toBe(201);
    const task = (c.json() as { task: { id: string; source: string; status: string } }).task;
    expect(task).toMatchObject({ source: "ed", status: "open" });

    const d = await api("PATCH", `/tasks/${task.id}`, { status: "done" });
    expect(d.statusCode).toBe(200);
    expect((d.json() as { task: { location: string; file: string } }).task).toMatchObject({ location: "done" });

    expect((await api("PATCH", "/tasks/t-260101-none", { status: "done" })).statusCode).toBe(404);
    expect((await api("PATCH", "/tasks/garbage", { status: "done" })).statusCode).toBe(400);
    expect((await api("PATCH", `/tasks/${task.id}`, { options: "a,b" })).statusCode).toBe(400);
  });

  it("POST tasks/:id/answer sets the answer, reopens, records an #answer episode, and reports the wake", async () => {
    const c = await api("POST", "/tasks", { title: "Merge #88?", status: "awaiting-ed", ask: "Merge?", options: ["merge", "skip"] });
    const id = (c.json() as { task: { id: string } }).task.id;

    const res = await api("POST", `/tasks/${id}/answer`, { choice: "merge", wake: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      task: { status: string; answer: { choice: string; by: string } };
      episode: { id: string; file: string };
      wake: { fired: boolean; reason?: string };
    };
    expect(body.task).toMatchObject({ status: "open", answer: { choice: "merge", by: "ed" } });
    // The seeded wake trigger ships disabled, so wake:true reports why it didn't fire.
    expect(body.wake).toEqual({ fired: false, reason: "the wake trigger is disabled" });
    const log = (await t.app.inject({ method: "GET", url: `/api/projects/${acme.slug}/managers/log` })).json() as {
      log: { entries: { id: string; tags: string[]; source: string | null; refs: string[] }[] };
    };
    expect(log.log.entries.find((e) => e.id === body.episode.id)).toMatchObject({
      tags: ["answer"],
      source: "ed",
      refs: [id],
    });

    const again = await api("POST", `/tasks/${id}/answer`, { choice: "skip" });
    expect(again.statusCode).toBe(409);
    expect((await api("POST", `/tasks/${id}/answer`, {})).statusCode).toBe(400);
  });

  it("POST/PATCH objectives", async () => {
    const c = await api("POST", "/objectives", { id: "grow", title: "Grow", success: "Known", whereWeAre: "Start." });
    expect(c.statusCode).toBe(201);
    expect((c.json() as { objective: { whereWeAre: string } }).objective.whereWeAre).toBe("Start.");
    expect((await api("POST", "/objectives", { id: "grow", title: "Grow", success: "Known" })).statusCode).toBe(409);
    expect((await api("POST", "/objectives", { id: "nope", title: "No success" })).statusCode).toBe(400);
    const p = await api("PATCH", "/objectives/grow", { status: "paused", strategy: "Wait." });
    expect(p.statusCode).toBe(200);
    expect((p.json() as { objective: { status: string; strategy: string } }).objective).toMatchObject({
      status: "paused",
      strategy: "Wait.",
    });
    expect((await api("PATCH", "/objectives/absent", { status: "paused" })).statusCode).toBe(404);
  });

  it("UI writes commit as the configured author, not the bot", async () => {
    await t.autocommit.flush(acme.dir);
    const last = git("log", "-1", "--format=%an", "--", `${acme.slug}/objectives`);
    expect(last).toBe(t.cfg.gitAuthor.name);
    expect(last).not.toBe("managers-bot");
  });
});

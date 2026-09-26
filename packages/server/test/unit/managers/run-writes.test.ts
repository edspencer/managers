/**
 * Managers M6: run records through the serialised writer — start, the run's own
 * writes noted on it, finish with `expect` evaluated, and the refusals.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ManagersState } from "../../../src/managers/state.js";
import { StateWriteError, type WriteActor, type WriteWorkspace } from "../../../src/managers/state-writes.js";
import { isRunId } from "../../../src/managers/layout.js";
import { beginTriggerRun } from "../../../src/managers/trigger-runs.js";
import { countMcpCall } from "../../../src/managers/mcp-calls.js";
import type { TriggerDto } from "../../../src/trigger-config.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let state: ManagersState;
let ws: WriteWorkspace;
const bot = { name: "managers-bot", email: "managers-bot@localhost" };
const actor = (runId: string | null = null): WriteActor => ({ kind: "agent", name: "manager", author: bot, runId });

beforeEach(async () => {
  root = await makeTmpDir("managers-runs-");
  const dir = path.join(root, "acme");
  await fs.mkdir(dir, { recursive: true });
  state = new ManagersState(root);
  ws = { key: "acme", layout: state.layout(dir) };
});
afterEach(async () => {
  await rmTmpDir(root);
});

const rawRun = async (file: string) => YAML.parse(await fs.readFile(path.join(ws.layout.dir, file), "utf8"));

describe("startRun / finishRun", () => {
  it("writes a running record, notes the run's writes on it, and finishes with expect met", async () => {
    const { id, file } = await state.writer.startRun(
      ws,
      { trigger: "wake", kind: "wake", expect: { kind: "episode", within: "48h" } },
      actor(),
    );
    expect(isRunId(id)).toBe(true);
    expect(file).toMatch(new RegExp(`^runs/\\d{4}-\\d{2}/${id}\\.yaml$`));
    expect(await rawRun(file)).toMatchObject({ id, status: "running", finished: null, expectResult: null });

    const ep = await state.writer.recordEpisode(ws, { text: "did a thing", importance: 3 }, actor(id));
    const task = await state.writer.upsertTask(ws, { title: "t", status: "open" }, actor(id));
    await state.writer.upsertTask(ws, { id: task.id, status: "doing" }, actor(id)); // same id once
    await state.writer.writeReport(ws, { type: "status", body: "fine" }, actor(id));
    // A write outside the run is not noted on it.
    await state.writer.recordEpisode(ws, { text: "human chat", importance: 1 }, actor(null));

    const done = await state.writer.finishRun(
      ws,
      id,
      {
        status: "succeeded",
        sessionId: "sess-1",
        model: "claude-x",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
        mcpCalls: { paddock: { list_chats: 2 } },
      },
      actor(id),
    );
    expect(done).toMatchObject({
      status: "succeeded",
      sessionId: "sess-1",
      episodes: [ep.id],
      tasksTouched: [task.id],
      reports: ["status"],
      mcpCalls: { paddock: { list_chats: 2 } },
      expectResult: "met",
      error: null,
    });
    expect(done.finished).not.toBeNull();
    // And the read store agrees with the file.
    const read = (await state.runs.get(ws.layout, id)) as Record<string, unknown>;
    expect(read).toMatchObject({ status: "succeeded", expectResult: "met", usage: { outputTokens: 2 } });
  });

  it("no episode → missing; a failure carries its error; no expect → n/a", async () => {
    const a = await state.writer.startRun(ws, { trigger: "a", kind: "wake", expect: { kind: "episode" } }, actor());
    expect((await state.writer.finishRun(ws, a.id, { status: "succeeded" }, actor(a.id))).expectResult).toBe("missing");
    const b = await state.writer.startRun(ws, { trigger: "b", kind: "event" }, actor());
    const fb = await state.writer.finishRun(ws, b.id, { status: "failed", error: "API\nerror" }, actor(b.id));
    expect(fb).toMatchObject({ status: "failed", expectResult: "n/a", error: "API error", kind: "event" });
  });

  it("record_artifact works inside the run and meets an artifact expectation", async () => {
    const r = await state.writer.startRun(ws, { trigger: "ship", kind: "wake", expect: { kind: "artifact" } }, actor());
    await state.writer.recordArtifact(ws, { kind: "commit", ref: "abc123" }, actor(r.id));
    expect((await state.writer.finishRun(ws, r.id, { status: "succeeded" }, actor(r.id))).expectResult).toBe("met");
  });

  it("a run is finished once: a second finish is a 409 and leaves the record alone", async () => {
    const r = await state.writer.startRun(ws, { trigger: "a", kind: "wake" }, actor());
    await state.writer.finishRun(ws, r.id, { status: "succeeded" }, actor(r.id));
    const before = await fs.readFile(path.join(ws.layout.dir, r.file), "utf8");
    await expect(state.writer.finishRun(ws, r.id, { status: "failed" }, actor(r.id))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await fs.readFile(path.join(ws.layout.dir, r.file), "utf8")).toBe(before);
  });

  it("finishing an unknown run is 404; a hand-broken run record never fails the write being noted", async () => {
    await expect(state.writer.finishRun(ws, "r-260926-0700-zz", { status: "succeeded" }, actor())).rejects.toBeInstanceOf(
      StateWriteError,
    );
    const r = await state.writer.startRun(ws, { trigger: "a", kind: "wake" }, actor());
    await fs.writeFile(path.join(ws.layout.dir, r.file), "id: [unclosed\n", "utf8");
    const ep = await state.writer.recordEpisode(ws, { text: "still lands", importance: 2 }, actor(r.id));
    expect(ep.id).toMatch(/^ep-/);
  });

  it("keeps hand-added keys on the record through the run's writes", async () => {
    const r = await state.writer.startRun(ws, { trigger: "a", kind: "wake" }, actor());
    const abs = path.join(ws.layout.dir, r.file);
    await fs.appendFile(abs, "edNote: looked at this\n", "utf8");
    await state.writer.recordEpisode(ws, { text: "x", importance: 1 }, actor(r.id));
    await state.writer.finishRun(ws, r.id, { status: "succeeded" }, actor(r.id));
    expect(await rawRun(r.file)).toMatchObject({ edNote: "looked at this", status: "succeeded" });
  });
});

describe("beginTriggerRun", () => {
  const dto = (over: Partial<TriggerDto["run"]> = {}, type: "schedule" | "event" = "schedule"): TriggerDto => ({
    name: "publish-check",
    agentName: "trigger-acme-publish-check",
    trigger: type === "schedule" ? { type, cron: "0 3 1 1 *" } : { type, on: "onArchive" },
    run: { prompt: "x", session: "new", tools: [], expect: { kind: "episode", within: "48h" }, ...over },
    enabled: true,
  });

  it("starts the record with the trigger's expect and bound objective, finishes it, then flushes", async () => {
    await fs.mkdir(path.join(ws.layout.dir, "objectives", "blog"), { recursive: true });
    await fs.writeFile(
      path.join(ws.layout.dir, "objectives", "blog", "objective.md"),
      "---\ntitle: Blog\nstatus: active\nsuccess: posts\ntriggers: [publish-check]\n---\n## Where we are\nx\n",
    );
    const flushed: string[] = [];
    const h = await beginTriggerRun({
      state,
      slug: "acme",
      dir: ws.layout.dir,
      trigger: dto(),
      author: bot,
      flush: async (d) => flushed.push(d),
    });
    expect(h).not.toBeNull();
    const started = (await state.runs.get(ws.layout, h!.runId)) as Record<string, unknown>;
    expect(started).toMatchObject({ trigger: "publish-check", kind: "wake", objective: "blog", status: "running" });
    await state.writer.recordEpisode(ws, { text: "checked", importance: 2 }, actor(h!.runId));
    await h!.onComplete({ success: true, sessionId: "s1", mcpCalls: {} });
    const fin = (await state.runs.get(ws.layout, h!.runId)) as Record<string, unknown>;
    expect(fin).toMatchObject({ status: "succeeded", expectResult: "met", sessionId: "s1" });
    expect(flushed).toEqual([ws.layout.dir]);
  });

  it("an event trigger's run is kind event; a failed turn is recorded failed with its error", async () => {
    const h = await beginTriggerRun({ state, slug: "acme", dir: ws.layout.dir, trigger: dto({}, "event"), author: bot });
    await h!.onComplete({ success: false, sessionId: null, error: "overloaded", mcpCalls: {} });
    expect(await state.runs.get(ws.layout, h!.runId)).toMatchObject({
      kind: "event",
      status: "failed",
      error: "overloaded",
      expectResult: "missing",
    });
  });

  it("returns null (and reports) when the record can't be written; never throws", async () => {
    const errors: string[] = [];
    // A file where the runs directory should be makes every run write fail.
    await fs.writeFile(path.join(ws.layout.dir, "runs"), "not a dir");
    const h = await beginTriggerRun({
      state,
      slug: "acme",
      dir: ws.layout.dir,
      trigger: dto(),
      author: bot,
      onError: (what) => errors.push(what),
    });
    expect(h).toBeNull();
    expect(errors).toEqual(["starting the run record"]);
  });
});

describe("countMcpCall", () => {
  it("counts mcp__<server>__<tool> and skips Managers' own servers and plain tools", () => {
    const c: Record<string, Record<string, number>> = {};
    for (const t of [
      "mcp__paddock__list_chats",
      "mcp__paddock__list_chats",
      "mcp__paddock__create_chat",
      "mcp__plugin_gh_github__get_issue",
      "mcp__managers__list_projects",
      "mcp__managers__record_episode",
      "mcp__managers_files__send_file",
      "Bash",
      "mcp__broken",
    ]) {
      countMcpCall(c, t);
    }
    expect(c).toEqual({ paddock: { list_chats: 2, create_chat: 1 }, plugin_gh_github: { get_issue: 1 } });
  });
});

/**
 * t-261001-5ti7: "Answer & wake" wakes the trigger that ASKED, not only `wake`.
 *
 * On the real app: a project whose only trigger is `roadmap`. A `roadmap` run
 * (the fake `claude` calling `managers.upsert_task`) raises an awaiting-ed task,
 * which records `raisedBy: {trigger: roadmap, run}`. Then `GET …/managers/wake`
 * (per task, and `?task=`) and `POST …/tasks/:id/answer {wake: true}` both
 * target — and the answer fires — `roadmap`. Also: a task from before
 * `raisedBy` (run id only in its log), the fallback to `wake`, an asker whose
 * behaviour is off (never woken), and nothing to wake at all.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type Run = { id: string; trigger: string; status: string; sessionId: string | null };
type Target = { available: boolean; reason: string | null; trigger: string | null };
type WakeBody = Target & { tasks: Record<string, Target> };
type Task = { id: string; status: string; raisedBy: { trigger: string; run: string } | null; file: string };

const RAISE =
  '[[MCP managers.upsert_task {"title":"Ship v2?","status":"awaiting-ed","ask":"Ship v2 now?","options":["ship","wait"]}]]';

describe("integration: answer & wake targets the asking trigger (t-261001-5ti7)", () => {
  let t: TestApp;
  let proj: Project;
  const api = () => `/api/projects/${proj.slug}/managers`;
  const inject = (method: "GET" | "POST", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const json = async <T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<T> => {
    const res = await inject(method, url, payload);
    expect(res.statusCode, res.body).toBe(method === "POST" && url.endsWith("/tasks") ? 201 : 200);
    return res.json() as T;
  };
  const runs = async (trigger: string) => (await json<{ runs: Run[] }>("GET", `${api()}/runs?trigger=${trigger}`)).runs;
  const wake = (q = "") => json<WakeBody>("GET", `${api()}/wake${q}`);
  const setRoadmap = (prompt: string, enabled = true, behaviour?: string) =>
    t.triggers.set(proj.slug, "roadmap", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt, ...(behaviour ? { behaviour } : {}) },
      enabled,
    });

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const finished = (trigger: string, before: Set<string>) =>
    waitFor(async () => (await runs(trigger)).find((r) => !before.has(r.id) && r.status !== "running") ?? null);

  /** Answer `id` with wake:true; returns the response's `wake`. */
  const answer = async (id: string) =>
    (await json<{ wake: { fired: boolean; trigger?: string; sessionId?: string; reason?: string } }>(
      "POST",
      `${api()}/tasks/${id}/answer`,
      { choice: "ship", wake: true },
    )).wake;

  /** A `roadmap` run raises a fresh awaiting-ed task; returns it and the run. */
  async function raiseByRoadmap(): Promise<{ task: Task; run: Run }> {
    await setRoadmap(RAISE);
    const asksBefore = new Set(
      (await json<{ tasks: Task[] }>("GET", `${api()}/tasks?status=awaiting-ed`)).tasks.map((x) => x.id),
    );
    const before = new Set((await runs("roadmap")).map((r) => r.id));
    expect((await inject("POST", `/api/projects/${proj.slug}/triggers/roadmap/run`)).statusCode).toBe(202);
    const run = await finished("roadmap", before);
    expect(run.status).toBe("succeeded");
    const { tasks } = await json<{ tasks: Task[] }>("GET", `${api()}/tasks?status=awaiting-ed`);
    const task = tasks.find((x) => !asksBefore.has(x.id));
    expect(task).toBeTruthy();
    // The next roadmap run (the wake) must not raise another one.
    await setRoadmap('Act on the answer. [[MCP managers.record_episode {"text":"Acted on the answer","importance":2}]]');
    return { task: task!, run };
  }

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    proj = ((await inject("POST", "/api/projects", { name: "Roadmap Proj" })).json() as { project: Project }).project;
    // The managers project's shape: its only trigger is `roadmap` (no `wake`).
    await t.triggers.remove(proj.slug, "wake");
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("a roadmap run's awaiting-ed task records raisedBy, and GET wake + answer & wake both resolve to roadmap", async () => {
    expect(Object.keys((await t.projects.get(proj.slug)).triggers ?? {})).toEqual([]);
    const { task, run } = await raiseByRoadmap();
    expect(Object.keys((await t.projects.get(proj.slug)).triggers ?? {})).toEqual(["roadmap"]);
    expect(task.raisedBy).toEqual({ trigger: "roadmap", run: run.id });
    const onDisk = await fs.readFile(path.join(proj.dir, task.file), "utf8");
    expect(YAML.parse(onDisk.split("---")[1]!).raisedBy).toEqual({ trigger: "roadmap", run: run.id });

    // Without a task the workspace has nothing named `wake`…
    const all = await wake();
    expect(all).toMatchObject({ available: false, trigger: null, reason: "this project has no wake trigger" });
    // …but this task's answer wakes roadmap, by the map and by ?task=.
    expect(all.tasks[task.id]).toEqual({ available: true, reason: null, trigger: "roadmap" });
    expect(await wake(`?task=${task.id}`)).toMatchObject({ available: true, reason: null, trigger: "roadmap" });

    const before = new Set((await runs("roadmap")).map((r) => r.id));
    const woke = await answer(task.id);
    expect(woke).toMatchObject({ fired: true, trigger: "roadmap" });
    expect(woke.sessionId).toBeTruthy();
    const wokeRun = await finished("roadmap", before);
    expect(wokeRun.status).toBe("succeeded");
    // The answer keeps raisedBy (provenance), and the task is open again.
    const after = (await json<{ task: Task }>("GET", `${api()}/tasks/${task.id}`)).task;
    expect(after).toMatchObject({ status: "open", raisedBy: { trigger: "roadmap", run: run.id } });
  });

  it("a task from before raisedBy: the run id in its log still resolves to roadmap", async () => {
    const { run } = await raiseByRoadmap();
    const id = "t-261001-aaaa";
    await fs.writeFile(
      path.join(proj.dir, "tasks", "open", `${id}.md`),
      `---\nid: ${id}\ntitle: Legacy ask\nstatus: awaiting-ed\nask: Go?\ncreated: 2026-10-01T09:00:00Z\nupdated: 2026-10-01T09:00:00Z\n---\n## Log\n` +
        `- 2026-10-01T08:00Z manager: created, open\n- 2026-10-01T09:00Z manager (run ${run.id}): open → awaiting-ed\n`,
      "utf8",
    );
    expect((await wake()).tasks[id]).toEqual({ available: true, reason: null, trigger: "roadmap" });
    expect((await wake(`?task=${id}`)).trigger).toBe("roadmap");
  });

  it("an asker whose behaviour is off is never woken; with no wake either, nothing is", async () => {
    const { task } = await raiseByRoadmap();
    // Gate roadmap behind a behaviour that is off (behaviours default off).
    const yamlPath = path.join(proj.dir, "project.yaml");
    const doc = YAML.parse(await fs.readFile(yamlPath, "utf8")) as Record<string, unknown>;
    doc.behaviours = { "roadmap-work": { description: "Work the roadmap." } };
    await fs.writeFile(yamlPath, YAML.stringify(doc), "utf8");
    await setRoadmap("Should never run.", true, "roadmap-work");

    const reason = 'the roadmap trigger\'s behaviour "roadmap-work" is off, and this project has no wake trigger';
    expect((await wake()).tasks[task.id]).toEqual({ available: false, reason, trigger: null });
    const before = (await runs("roadmap")).length;
    expect(await answer(task.id)).toEqual({ fired: false, reason });
    expect((await runs("roadmap")).length).toBe(before);
  });

  it("falls back to wake: when the asker cannot fire, and for a task no run raised", async () => {
    await t.triggers.set(proj.slug, "wake", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: 'Wake. [[MCP managers.record_episode {"text":"Woke","importance":1}]]' },
      enabled: true,
    });
    // roadmap is still gated off (previous test): its ask falls back to wake.
    const gated = (await json<{ tasks: Task[] }>("GET", `${api()}/tasks?status=awaiting-ed`)).tasks.find(
      (x) => x.raisedBy?.trigger === "roadmap",
    );
    // Ed's own awaiting-ed task (no run): wake.
    const mine = (await json<{ task: Task }>("POST", `${api()}/tasks`, { title: "Mine", status: "awaiting-ed", ask: "Ok?" })).task;
    expect(mine.raisedBy).toBeNull();
    const w = await wake();
    expect(w).toMatchObject({ available: true, trigger: "wake" });
    expect(w.tasks[mine.id]).toEqual({ available: true, reason: null, trigger: "wake" });
    expect(gated).toBeTruthy();
    expect(w.tasks[gated!.id]).toEqual({ available: true, reason: null, trigger: "wake" });

    const before = new Set((await runs("wake")).map((r) => r.id));
    const woke = (await json<{ wake: { fired: boolean; trigger?: string } }>("POST", `${api()}/tasks/${mine.id}/answer`, {
      text: "ok",
      wake: true,
    })).wake;
    expect(woke).toMatchObject({ fired: true, trigger: "wake" });
    expect((await finished("wake", before)).status).toBe("succeeded");
  });

  it("a chat or Ed re-raising a run's task clears raisedBy", async () => {
    const { task } = await raiseByRoadmap();
    await json("POST", `${api()}/tasks/${task.id}/answer`, { choice: "wait" });
    const res = await t.app.inject({
      method: "PATCH",
      url: `${api()}/tasks/${task.id}`,
      payload: { status: "awaiting-ed", ask: "And now?" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const re = (res.json() as { task: Task }).task;
    expect(re.raisedBy).toBeNull();
  });

  it("400 for a malformed ?task=; an unknown task id falls back like no task", async () => {
    expect((await inject("GET", `${api()}/wake?task=nope`)).statusCode).toBe(400);
    expect((await wake("?task=t-990101-zzzz")).trigger).toBe("wake");
  });
});

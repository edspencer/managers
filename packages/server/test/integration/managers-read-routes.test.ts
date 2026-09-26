/**
 * Managers M4: the read-only REST surface over a seeded data dir, on the REAL app.
 *
 * Covers both workspace mounts (`/api/root/managers/…` for Home and
 * `/api/projects/:slug/managers/…`), 404s and 400s, a malformed task surfacing as
 * a `parseError`, the data-repo skeleton written at boot, and project creation
 * (reserved slugs refused, the seeded disabled `wake` trigger + its prompt file).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

let t: TestApp;

async function put(rel: string, text: string): Promise<void> {
  const abs = path.join(t.projectsRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
}

const get = async (url: string) => {
  const res = await t.app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

const TASK = (id: string, status: string, extra = "") =>
  `---\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\n${extra}created: 2026-09-20T00:00:00Z\nupdated: 2026-09-20T00:00:00Z\n---\nNotes for ${id}.\n## Log\n- 2026-09-20T00:00Z manager: created\n`;

beforeAll(async () => {
  t = await startTestApp();
  await put("acme/project.yaml", "name: Acme\nslug: acme\nstatus: active\n");
  await put("bare/project.yaml", "name: Bare\nslug: bare\nstatus: idea\n");

  // acme: an objective with a two-month journal, tasks (incl. a malformed one), a log, a run, a report.
  await put(
    "acme/objectives/grow/objective.md",
    "---\ntitle: Grow\nstatus: active\nsuccess: Known widely\ntriggers: [wake]\n---\n## Where we are\nEarly days.\n## Strategy\nPost weekly.\n## Lessons\n- [[slow-reviews]]\n",
  );
  await put("acme/objectives/grow/journal/2026-08.md", "## 2026-08-30 10:00Z · ep-260830-1000-aa · imp 2\nolder entry\n");
  await put(
    "acme/objectives/grow/journal/2026-09.md",
    "## 2026-09-02 10:00Z · ep-260902-1000-bb · imp 6 · run r-260902-0955-cc · #dispatch\nnewer entry\nrefs: acme/widget#4\n",
  );
  await put("acme/log/2026-09.md", "## 2026-09-03 10:00Z · ep-260903-1000-dd · imp 1\nproject note\n");
  await put("acme/tasks/open/t-260920-aaaa.md", TASK("t-260920-aaaa", "open", "objective: grow\n"));
  await put("acme/tasks/open/t-260920-bbbb.md", TASK("t-260920-bbbb", "awaiting-ed", 'ask: "Merge?"\noptions: [merge, skip]\n'));
  await put("acme/tasks/open/t-260920-cccc.md", "---\nid: t-260920-cccc\ntitle: broken\nstatus: someday\n---\n");
  await put("acme/tasks/done/2026-09/t-260901-dddd.md", TASK("t-260901-dddd", "done"));
  await put("acme/memory/facts/slow-reviews.md", "---\nname: slow-reviews\ndescription: Reviews take a week.\ntype: pattern\nsince: 2026-09-01\nevidence: [ep-260902-1000-bb]\n---\nBody.\n");
  await put(
    "acme/runs/2026-09/r-260902-0955-cc.yaml",
    "id: r-260902-0955-cc\ntrigger: wake\nkind: wake\nstatus: failed\nstarted: 2026-09-02T09:55:00Z\nerror: boom\n",
  );
  await put("acme/reports/status/current.md", "# Status\nFine.\n");
  await put("acme/reports/status/2026-09-02.md", "# Status\nFine.\n");

  // Home (the root workspace): its own task, and the SHARED memory.
  await put("tasks/open/t-260921-hhhh.md", TASK("t-260921-hhhh", "awaiting-ed", "ask: Which first?\n"));
  await put("memory/MEMORY.md", "Shared preamble.\n<!-- managers:index -->\n- [[house-style]]\n");
  await put("memory/facts/house-style.md", "---\nname: house-style\ndescription: Short sentences.\ntype: feedback\n---\nKeep it short.\n");
});
afterAll(async () => t.teardown());

describe("integration: Managers read routes", () => {
  it("boot wrote the data-repo skeleton", async () => {
    for (const f of [".managers-data", ".gitattributes", "README.md"]) {
      await expect(fs.stat(path.join(t.projectsRoot, f))).resolves.toBeTruthy();
    }
    const gi = await fs.readFile(path.join(t.projectsRoot, ".gitignore"), "utf8");
    expect(gi).toContain("**/.managers/briefings/");
    // The suite sets MANAGERS_DATA_GIT_INIT=0, so boot did not `git init`.
    await expect(fs.stat(path.join(t.projectsRoot, ".git"))).rejects.toThrow();
  });

  it("lists a project's tasks, awaiting-ed first, with the malformed one as a parseError", async () => {
    const { status, body } = await get("/api/projects/acme/managers/tasks");
    expect(status).toBe(200);
    expect(body.tasks.map((x: { id: string }) => x.id)).toEqual(["t-260920-bbbb", "t-260920-aaaa"]);
    expect(body.tasks[0]).toMatchObject({ status: "awaiting-ed", ask: "Merge?", options: ["merge", "skip"], file: "tasks/open/t-260920-bbbb.md" });
    expect(body.parseErrors).toEqual([{ file: "tasks/open/t-260920-cccc.md", error: expect.stringMatching(/status/) }]);
    expect(body.doneMonths).toEqual(["2026-09"]);
  });

  it("filters tasks and pages into a done month", async () => {
    expect((await get("/api/projects/acme/managers/tasks?status=awaiting-ed")).body.tasks).toHaveLength(1);
    expect((await get("/api/projects/acme/managers/tasks?objective=grow")).body.tasks).toHaveLength(1);
    const done = await get("/api/projects/acme/managers/tasks?month=2026-09");
    expect(done.body.tasks.map((x: { id: string }) => x.id)).toEqual(["t-260901-dddd"]);
    expect(done.body.tasks[0].location).toBe("done");
  });

  it("serves the root workspace from /api/root, separately from projects", async () => {
    const { status, body } = await get("/api/root/managers/tasks");
    expect(status).toBe(200);
    expect(body.tasks.map((x: { id: string }) => x.id)).toEqual(["t-260921-hhhh"]);
    expect(body).not.toHaveProperty("parseErrors");
  });

  it("reads one task, open or done; 404 unknown; 400 malformed; 422 unparseable", async () => {
    const open = await get("/api/projects/acme/managers/tasks/t-260920-aaaa");
    expect(open.status).toBe(200);
    expect(open.body.task).toMatchObject({ id: "t-260920-aaaa", notes: "Notes for t-260920-aaaa.", log: ["2026-09-20T00:00Z manager: created"] });
    expect((await get("/api/projects/acme/managers/tasks/t-260901-dddd")).body.task.month).toBe("2026-09");
    expect(await get("/api/projects/acme/managers/tasks/t-260920-zzzz")).toEqual({
      status: 404,
      body: { error: "No such task: t-260920-zzzz", code: "not_found" },
    });
    const bad = await get("/api/projects/acme/managers/tasks/not-an-id");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid");
    const broken = await get("/api/projects/acme/managers/tasks/t-260920-cccc");
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe("parse_error");
  });

  it("400s malformed query values", async () => {
    for (const url of [
      "/api/projects/acme/managers/tasks?status=later",
      "/api/projects/acme/managers/tasks?month=2026-9",
      "/api/projects/acme/managers/objectives/grow?before=last-week",
      "/api/projects/acme/managers/objectives/grow?months=0",
      "/api/projects/acme/managers/runs?status=exploded",
      "/api/projects/acme/managers/memory/facts/slow-reviews?scope=everywhere",
    ]) {
      const r = await get(url);
      expect([url, r.status, r.body.code]).toEqual([url, 400, "invalid"]);
    }
  });

  it("404s an unknown project on every route", async () => {
    for (const p of ["objectives", "tasks", "memory", "runs", "reports", "log"]) {
      const r = await get(`/api/projects/no-such-project/managers/${p}`);
      expect([p, r.status, r.body.code]).toEqual([p, 404, "not_found"]);
    }
  });

  it("an empty project returns exactly empty lists", async () => {
    expect((await get("/api/projects/bare/managers/objectives")).body).toEqual({ objectives: [] });
    expect((await get("/api/projects/bare/managers/tasks")).body).toEqual({ tasks: [], doneMonths: [] });
    expect((await get("/api/projects/bare/managers/runs")).body).toEqual({ runs: [], months: [], nextBefore: null });
    expect((await get("/api/projects/bare/managers/reports")).body).toEqual({ reports: [] });
  });

  it("objectives: list, detail with sections and a paged journal, 404", async () => {
    const list = await get("/api/projects/acme/managers/objectives");
    expect(list.body).toEqual({
      objectives: [
        expect.objectContaining({ id: "grow", title: "Grow", status: "active", triggers: ["wake"], file: "objectives/grow/objective.md" }),
      ],
    });
    const one = await get("/api/projects/acme/managers/objectives/grow?months=1");
    expect(one.status).toBe(200);
    expect(one.body.objective).toMatchObject({ whereWeAre: "Early days.", strategy: "Post weekly.", lessonLinks: ["slow-reviews"] });
    expect(one.body.objective.journal).toMatchObject({ months: ["2026-09"], nextBefore: "2026-09" });
    expect(one.body.objective.journal.entries[0]).toMatchObject({
      id: "ep-260902-1000-bb",
      importance: 6,
      run: "r-260902-0955-cc",
      tags: ["dispatch"],
      refs: ["acme/widget#4"],
    });
    const older = await get("/api/projects/acme/managers/objectives/grow?months=1&before=2026-09");
    expect(older.body.objective.journal.entries.map((e: { id: string }) => e.id)).toEqual(["ep-260830-1000-aa"]);
    const missing = await get("/api/projects/acme/managers/objectives/nope");
    expect(missing).toEqual({ status: 404, body: { error: "No such objective: nope", code: "not_found" } });
  });

  it("log: the project-level episodes", async () => {
    const { body } = await get("/api/projects/acme/managers/log");
    expect(body.log.entries.map((e: { id: string }) => e.id)).toEqual(["ep-260903-1000-dd"]);
  });

  it("memory: a project sees its own facts and the root's, tagged; the root sees only its own", async () => {
    const proj = await get("/api/projects/acme/managers/memory");
    expect(proj.body.facts.map((f: { scope: string; name: string }) => `${f.scope}:${f.name}`).sort()).toEqual([
      "project:slow-reviews",
      "root:house-style",
    ]);
    expect(proj.body.indexes.root).toMatchObject({ preamble: "Shared preamble.", index: "- [[house-style]]" });
    expect(proj.body.indexes.project).toBeNull();
    const root = await get("/api/root/managers/memory");
    expect(root.body.facts.map((f: { scope: string }) => f.scope)).toEqual(["root"]);
    const fact = await get("/api/projects/acme/managers/memory/facts/house-style");
    expect(fact.body.fact).toMatchObject({ scope: "root", body: "Keep it short." });
    expect((await get("/api/projects/acme/managers/memory/facts/house-style?scope=project")).status).toBe(404);
  });

  it("runs and reports", async () => {
    const runs = await get("/api/projects/acme/managers/runs");
    expect(runs.body.runs).toEqual([expect.objectContaining({ id: "r-260902-0955-cc", status: "failed", error: "boom", file: "runs/2026-09/r-260902-0955-cc.yaml" })]);
    expect((await get("/api/projects/acme/managers/runs/r-260902-0955-cc")).body.run.trigger).toBe("wake");
    expect((await get("/api/projects/acme/managers/runs/r-260101-0000-zz")).status).toBe(404);
    expect((await get("/api/projects/acme/managers/runs/nope")).status).toBe(400);

    const reports = await get("/api/projects/acme/managers/reports");
    expect(reports.body.reports).toEqual([expect.objectContaining({ type: "status", dates: ["2026-09-02"] })]);
    const cur = await get("/api/projects/acme/managers/reports/status");
    expect(cur.body.current).toMatchObject({ title: "Status", body: "# Status\nFine.\n" });
    expect((await get("/api/projects/acme/managers/reports/status/2026-09-02")).body.report.date).toBe("2026-09-02");
    expect((await get("/api/projects/acme/managers/reports/status/2026-09-03")).status).toBe(404);
    expect((await get("/api/projects/acme/managers/reports/status/yesterday")).status).toBe(400);
    expect((await get("/api/projects/acme/managers/reports/digest")).status).toBe(404);
  });

  it("refuses a reserved slug at project creation", async () => {
    for (const slug of ["tasks", "memory", "objectives"]) {
      const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid", error: expect.stringContaining("reserved") });
    }
    await expect(fs.stat(path.join(t.projectsRoot, "tasks", "project.yaml"))).rejects.toThrow();
  });

  it("seeds a new project with its wake prompt and a DISABLED wake trigger", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "QA Two", slug: "qa2" } });
    expect(res.statusCode).toBe(201);
    const prompt = await fs.readFile(path.join(t.projectsRoot, "qa2", ".managers", "triggers", "wake.md"), "utf8");
    expect(prompt).toMatch(/^# Wake/);
    const trig = (await get("/api/projects/qa2/triggers")).body.triggers as Array<Record<string, any>>;
    const wake = trig.find((x) => x.name === "wake");
    expect(wake).toMatchObject({ enabled: false, trigger: { type: "schedule", cron: "0 7 * * *" }, run: { promptFile: "wake.md" } });
    // The seeded block survives an unrelated PATCH (the writeYaml round-trip gotcha, plan §4).
    const patch = await t.app.inject({ method: "PATCH", url: "/api/projects/qa2", payload: { summary: "edited" } });
    expect(patch.statusCode).toBe(200);
    const again = (await get("/api/projects/qa2/triggers")).body.triggers as Array<{ name: string }>;
    expect(again.map((x) => x.name)).toContain("wake");
  });
});

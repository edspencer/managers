/**
 * Managers M5: the serialised state writer over a real temp dir.
 *
 * The load-bearing cases: 50 concurrent `record_episode`s produce 50 well-formed,
 * non-interleaved blocks with unique ids; tasks move to `done/<month>/` and back;
 * every write validates through the STRICT schema (and refuses without touching
 * the disk); hand-added frontmatter keys survive an update.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ManagersState } from "../../../src/managers/state.js";
import { parseEpisodeFile } from "../../../src/managers/episodes-store.js";
import { parseFrontmatter } from "../../../src/managers/frontmatter.js";
import { TASK_KEYS, StateWriteError, type WriteActor, type WriteWorkspace } from "../../../src/managers/state-writes.js";
import { taskWriteSchema } from "../../../src/managers/schemas.js";
import { WriteQueue } from "../../../src/managers/write-queue.js";
import { isEpisodeId, isTaskId } from "../../../src/managers/layout.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let state: ManagersState;
let ws: WriteWorkspace;

const bot = { name: "managers-bot", email: "managers-bot@localhost" };
const agent: WriteActor = { kind: "agent", name: "manager", author: bot, runId: null, sessionId: "sess-1" };
const ed: WriteActor = { kind: "ed", name: "ed", author: { name: "Ed", email: "ed@example.test" } };

async function put(rel: string, text: string): Promise<string> {
  const abs = path.join(ws.layout.dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
  return abs;
}
const read = (rel: string) => fs.readFile(path.join(ws.layout.dir, rel), "utf8");
async function exists(rel: string): Promise<boolean> {
  return fs
    .access(path.join(ws.layout.dir, rel))
    .then(() => true)
    .catch(() => false);
}
async function listRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(path.relative(ws.layout.dir, abs));
    }
  };
  await walk(path.join(ws.layout.dir, dir));
  return out.sort();
}

beforeEach(async () => {
  root = await makeTmpDir("managers-writes-");
  const dir = path.join(root, "acme");
  await fs.mkdir(dir, { recursive: true });
  state = new ManagersState(root);
  ws = { key: "acme", layout: state.layout(dir) };
});
afterEach(async () => {
  await rmTmpDir(root);
});

describe("WriteQueue", () => {
  it("runs same-key writes strictly in order and survives a failure", async () => {
    const q = new WriteQueue();
    const seen: number[] = [];
    const slow = (n: number, ms: number) => () => new Promise<void>((r) => setTimeout(() => (seen.push(n), r()), ms));
    const a = q.run("k", slow(1, 30));
    const b = q.run("k", async () => {
      throw new Error("boom");
    });
    const c = q.run("k", slow(3, 1));
    await expect(b).rejects.toThrow("boom");
    await Promise.all([a, c]);
    expect(seen).toEqual([1, 3]);
  });
});

describe("record_episode", () => {
  it("50 concurrent appends → 50 well-formed, non-interleaved blocks with unique ids", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        state.writer.recordEpisode(
          ws,
          { text: `Episode number ${i}\nsecond line ${i}`, importance: (i % 10) + 1, tags: ["qa", `n-${i}`] },
          agent,
        ),
      ),
    );
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(isEpisodeId(id)).toBe(true);
    const files = await listRel("log");
    expect(files).toHaveLength(1);
    const parsed = parseEpisodeFile(await read(files[0]!));
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(50);
    // Every block's text is intact — its two lines belong together.
    for (const e of parsed.entries) {
      const n = /Episode number (\d+)/.exec(e.text)![1];
      expect(e.text).toBe(`Episode number ${n}\nsecond line ${n}`);
      expect(e.tags).toEqual(["qa", `n-${n}`]);
      expect(e.chat).toBe("sess-1");
    }
    expect(new Set(parsed.entries.map((e) => e.id))).toEqual(new Set(ids));
  });

  it("files into an objective's journal, and refuses an unknown objective", async () => {
    await expect(
      state.writer.recordEpisode(ws, { text: "x", importance: 3, objective: "nope" }, agent),
    ).rejects.toMatchObject({ code: "not_found" });
    await state.writer.updateObjective(ws, { id: "grow", title: "Grow", success: "Grown" }, agent);
    const r = await state.writer.recordEpisode(
      ws,
      { text: "Journalled", importance: 5, refs: ["widget/lib#12", "t-260926-abcd"], objective: "grow" },
      agent,
    );
    expect(r.file).toMatch(/^objectives\/grow\/journal\/\d{4}-\d{2}\.md$/);
    const got = await state.episodes.get(ws.layout, r.id);
    expect(got).toMatchObject({ objective: "grow", refs: ["widget/lib#12", "t-260926-abcd"], importance: 5 });
  });

  it.each([
    [{ text: "", importance: 3 }, /text is required/],
    [{ text: "x".repeat(1201), importance: 3 }, /limit is 1200/],
    [{ text: "ok", importance: 11 }, /importance/],
    [{ text: "ok", importance: 3, tags: ["Bad Tag"] }, /tags/],
    [{ text: "ok", importance: 3, refs: ["https://evil.example/x"] }, /refs/],
    [{ text: "a\n## injected header", importance: 3 }, /"## "/],
    [{ text: "a\nrefs: t-1", importance: 3 }, /refs:/],
  ])("refuses %j without writing anything", async (input, msg) => {
    await expect(state.writer.recordEpisode(ws, input, agent)).rejects.toThrow(msg);
    expect(await listRel("log")).toEqual([]);
  });

  it("marks an Ed-sourced episode `source ed`", async () => {
    const r = await state.writer.recordEpisode(ws, { text: "Ed said so", importance: 6 }, ed);
    expect((await state.episodes.get(ws.layout, r.id))?.source).toBe("ed");
  });
});

describe("upsert_task", () => {
  it("creates, updates, moves to done/<month>/ on done, and back to open/ on reopen", async () => {
    const c = await state.writer.upsertTask(ws, { title: "Ship it", status: "open" }, agent);
    expect(c.created).toBe(true);
    expect(isTaskId(c.id)).toBe(true);
    expect(c.file).toBe(`tasks/open/${c.id}.md`);

    const u = await state.writer.upsertTask(ws, { id: c.id, status: "doing", notes: "Working on it." }, agent);
    expect(u.file).toBe(c.file);

    const d = await state.writer.upsertTask(ws, { id: c.id, status: "done" }, agent);
    expect(d.file).toMatch(new RegExp(`^tasks/done/\\d{4}-\\d{2}/${c.id}\\.md$`));
    expect(d.movedFrom).toBe(c.file);
    expect(await exists(c.file)).toBe(false);

    const detail = await state.tasks.get(ws.layout, c.id);
    expect(detail).toMatchObject({ status: "done", location: "done", notes: "Working on it." });
    const log = (detail as { log: string[] }).log;
    expect(log).toHaveLength(3);
    expect(log[0]).toMatch(/manager: created, open$/);
    expect(log[1]).toMatch(/manager: open → doing$/);
    expect(log[2]).toMatch(/manager: doing → done$/);

    const o = await state.writer.upsertTask(ws, { id: c.id, status: "open" }, agent);
    expect(o.file).toBe(c.file);
    expect(await exists(d.file)).toBe(false);
  });

  it("awaiting-ed requires an ask — refused with a validation message, and no file created", async () => {
    await expect(state.writer.upsertTask(ws, { title: "x", status: "awaiting-ed" }, agent)).rejects.toThrow(
      /awaiting-ed requires an ask/,
    );
    expect(await listRel("tasks")).toEqual([]);
  });

  it("an update validates through the strict schema, not the lenient read", async () => {
    // A hand-written file the READ schema accepts (no created/updated, scalar github).
    await put(
      "tasks/open/t-260101-hand.md",
      "---\nid: t-260101-hand\ntitle: Hand made\nstatus: open\ngithub: widget/lib#3\nowner_note: keep me\n---\nMine.\n",
    );
    const r = await state.writer.upsertTask(ws, { id: "t-260101-hand", status: "blocked" }, agent);
    const doc = parseFrontmatter(await read(r.file));
    // Strictly valid on the known keys…
    const known = Object.fromEntries(Object.entries(doc.data).filter(([k]) => (TASK_KEYS as readonly string[]).includes(k)));
    expect(taskWriteSchema.safeParse(known).success).toBe(true);
    expect(doc.data.github).toEqual(["widget/lib#3"]);
    // …and Ed's own key survives.
    expect(doc.data.owner_note).toBe("keep me");
    expect(doc.body).toMatch(/^Mine\.\n\n## Log\n- .* manager: open → blocked\n$/);

    // A hand edit the strict schema rejects is refused, and the file is untouched.
    const before = await put(
      "tasks/open/t-260101-badd.md",
      "---\nid: t-260101-badd\ntitle: Bad\nstatus: open\ngithub: [not a ref]\n---\n",
    );
    const text = await fs.readFile(before, "utf8");
    await expect(state.writer.upsertTask(ws, { id: "t-260101-badd", status: "doing" }, agent)).rejects.toThrow(/github/);
    expect(await fs.readFile(before, "utf8")).toBe(text);
  });

  it("refuses an unknown task, a bad id, and an agent claiming source ed", async () => {
    await expect(state.writer.upsertTask(ws, { id: "t-260101-none", title: "x" }, agent)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(state.writer.upsertTask(ws, { id: "nope", title: "x" }, agent)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(state.writer.upsertTask(ws, { title: "x", source: "ed" }, agent)).rejects.toThrow(/reserved/);
  });

  it("the TASK_KEYS list matches the strict schema's keys", () => {
    const shape = (taskWriteSchema as unknown as { def: { in?: { shape: object } }; shape?: object });
    const keys = Object.keys(shape.def.in?.shape ?? shape.shape ?? {});
    expect([...TASK_KEYS].sort()).toEqual(keys.sort());
  });
});

describe("answerTask", () => {
  it("records the answer, reopens the task, and journals an #answer episode", async () => {
    const t = await state.writer.upsertTask(
      ws,
      { title: "Merge #88?", status: "awaiting-ed", ask: "Merge renovate #88?", options: ["merge", "skip"] },
      agent,
    );
    await expect(state.writer.answerTask(ws, t.id, { choice: "later" }, ed)).rejects.toThrow(/choice must be one of/);
    await expect(state.writer.answerTask(ws, t.id, {}, ed)).rejects.toThrow(/choice or some text/);
    const r = await state.writer.answerTask(ws, t.id, { choice: "merge", text: "go ahead" }, ed);
    const task = (await state.tasks.get(ws.layout, t.id)) as Record<string, unknown>;
    expect(task.status).toBe("open");
    expect(task.answer).toMatchObject({ by: "ed", choice: "merge", text: "go ahead" });
    const ep = await state.episodes.get(ws.layout, r.episode.id);
    expect(ep).toMatchObject({ source: "ed", tags: ["answer"], refs: [t.id] });
    expect(ep!.text).toContain("merge");
    // Answering twice is a conflict: it is no longer awaiting-ed.
    await expect(state.writer.answerTask(ws, t.id, { choice: "skip" }, ed)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("update_objective", () => {
  it("creates only with title and success, then replaces sections in place", async () => {
    await expect(state.writer.updateObjective(ws, { id: "grow", title: "Grow" }, agent)).rejects.toMatchObject({
      code: "not_found",
    });
    const c = await state.writer.updateObjective(
      ws,
      { id: "grow", title: "Grow", success: "3 communities", whereWeAre: "Nowhere yet.", strategy: "Post." },
      agent,
    );
    expect(c).toMatchObject({ created: true, status: "active", file: "objectives/grow/objective.md" });
    // Ed adds his own section by hand; an update must keep it.
    const file = path.join(ws.layout.dir, c.file);
    await fs.appendFile(file, "\n## Ed's notes\nDon't spam.\n");
    await state.writer.updateObjective(ws, { id: "grow", whereWeAre: "Two communities.", status: "paused" }, agent);
    const got = (await state.objectives.get(ws.layout, "grow")) as Record<string, unknown>;
    expect(got).toMatchObject({ status: "paused", whereWeAre: "Two communities.", strategy: "Post.", success: "3 communities" });
    expect(got.otherSections).toEqual([{ heading: "Ed's notes", body: "Don't spam." }]);
    await expect(
      state.writer.updateObjective(ws, { id: "grow", strategy: "## sneaky" }, agent),
    ).rejects.toThrow(/"## "/);
  });
});

describe("write_report and record_artifact", () => {
  it("write_report writes the dated file and current.md", async () => {
    const r = await state.writer.writeReport(ws, { type: "status", body: "## In flight\n- x" }, agent);
    expect(r.file).toMatch(/^reports\/status\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(r.currentFile).toBe("reports/status/current.md");
    expect(await read(r.file)).toBe(await read(r.currentFile));
    await expect(state.writer.writeReport(ws, { type: "Bad Type", body: "x" }, agent)).rejects.toThrow(/type/);
  });

  it("record_artifact refuses outside a run, and appends to the current run otherwise", async () => {
    await expect(
      state.writer.recordArtifact(ws, { kind: "commit", ref: "abc123" }, agent),
    ).rejects.toBeInstanceOf(StateWriteError);
    const runId = "r-260926-0700-k3";
    await put(
      `runs/2026-09/${runId}.yaml`,
      YAML.stringify({
        id: runId,
        trigger: "wake",
        kind: "wake",
        objective: null,
        status: "running",
        started: "2026-09-26T07:00:02Z",
        finished: null,
        sessionId: null,
        model: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        episodes: [],
        tasksTouched: [],
        reports: [],
        artifacts: [],
        mcpCalls: {},
        expect: { kind: "artifact", within: "48h" },
        expectResult: null,
        briefing: null,
        error: null,
      }),
    );
    const r = await state.writer.recordArtifact(ws, { kind: "pull-request", ref: "widget/lib#90", note: "opened" }, {
      ...agent,
      runId,
    });
    expect(r.artifacts).toBe(1);
    const run = (await state.runs.get(ws.layout, runId)) as Record<string, unknown>;
    expect(run.artifacts).toMatchObject([{ kind: "pull-request", ref: "widget/lib#90", note: "opened" }]);
  });
});

describe("onWrite", () => {
  it("fires once per successful write with the workspace label and author, never on a refusal", async () => {
    const calls: unknown[] = [];
    state.writer.onWrite = (dir, label, author, reason) => calls.push({ dir, label, author: author.name, reason });
    await state.writer.recordEpisode(ws, { text: "x", importance: 1 }, agent);
    await state.writer.upsertTask(ws, { title: "x", status: "awaiting-ed" }, agent).catch(() => undefined);
    expect(calls).toEqual([{ dir: ws.layout.dir, label: "acme", author: "managers-bot", reason: "record_episode" }]);
  });
});

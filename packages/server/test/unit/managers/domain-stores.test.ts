/**
 * Managers M4: the read stores over a real temp dir — mtime cache invalidation,
 * lenient reads with `parseError`s, lazy done months, memory scopes — and
 * `ensureDataRepo` idempotency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ManagersState } from "../../../src/managers/state.js";
import { ensureDataRepo, DATA_REPO_GITIGNORE, dataGitInitEnabled } from "../../../src/managers/data-repo.js";
import { DATA_REPO_MARKER } from "../../../src/data-dir-guard.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let proj: string;
let state: ManagersState;

async function put(rel: string, text: string, base = proj): Promise<string> {
  const abs = path.join(base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
  return abs;
}

/** Bump a file's mtime without changing its size, as `touch` would after an edit. */
async function touchLater(abs: string): Promise<void> {
  const t = new Date(Date.now() + 5_000);
  await fs.utimes(abs, t, t);
}

const task = (id: string, status: string, extra = "") =>
  `---\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\n${extra}updated: 2026-09-2${id.slice(-1) === "a" ? 1 : 2}T00:00:00Z\n---\nNotes.\n## Log\n- 2026-09-20T00:00Z manager: created\n`;

beforeEach(async () => {
  root = await makeTmpDir("managers-store-");
  proj = path.join(root, "acme");
  await fs.mkdir(proj, { recursive: true });
  state = new ManagersState(root);
});
afterEach(async () => rmTmpDir(root));

describe("tasks-store", () => {
  it("lists open tasks, awaiting-ed first, and filters by status/objective", async () => {
    await put("tasks/open/t-260920-aaaa.md", task("t-260920-aaaa", "open", "objective: grow\n"));
    await put("tasks/open/t-260920-bbbb.md", task("t-260920-bbbb", "awaiting-ed", "ask: ok?\n"));
    const l = state.layout(proj);
    const all = await state.tasks.list(l);
    expect(all.tasks.map((t) => t.id)).toEqual(["t-260920-bbbb", "t-260920-aaaa"]);
    expect(all.tasks[0]).toMatchObject({ location: "open", month: null, file: "tasks/open/t-260920-bbbb.md" });
    expect((await state.tasks.list(l, { status: ["open"] })).tasks.map((t) => t.id)).toEqual(["t-260920-aaaa"]);
    expect((await state.tasks.list(l, { objective: "grow" })).tasks).toHaveLength(1);
  });

  it("picks up an edit on the next list (mtime cache invalidation)", async () => {
    const abs = await put("tasks/open/t-260920-aaaa.md", task("t-260920-aaaa", "open"));
    const l = state.layout(proj);
    expect((await state.tasks.list(l)).tasks[0]!.status).toBe("open");
    // Same size, different content — only the mtime says it changed.
    await fs.writeFile(abs, task("t-260920-aaaa", "done"), "utf8");
    await touchLater(abs);
    expect((await fs.stat(abs)).size).toBe(Buffer.byteLength(task("t-260920-aaaa", "open")));
    expect((await state.tasks.list(l)).tasks[0]!.status).toBe("done");
    // …and an unchanged file is served from the cache (stat only, no re-read).
    const reads = vi.spyOn(fs, "readFile");
    try {
      expect((await state.tasks.list(l)).tasks[0]!.status).toBe("done");
      expect(reads.mock.calls.filter((c) => String(c[0]) === abs)).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
  });

  it("skips a malformed file with a parseError instead of failing the list", async () => {
    await put("tasks/open/t-260920-aaaa.md", task("t-260920-aaaa", "open"));
    await put("tasks/open/t-260920-bad1.md", "---\nid: t-260920-bad1\ntitle: x\nstatus: someday\n---\n");
    await put("tasks/open/t-260920-bad2.md", "---\ntitle: [unclosed\n---\n");
    await put("tasks/open/t-260920-bad3.md", "---\nid: t-260920-zzzz\ntitle: x\nstatus: open\n---\n");
    const got = await state.tasks.list(state.layout(proj));
    expect(got.tasks.map((t) => t.id)).toEqual(["t-260920-aaaa"]);
    expect(got.parseErrors.map((e) => e.file)).toEqual([
      "tasks/open/t-260920-bad1.md",
      "tasks/open/t-260920-bad2.md",
      "tasks/open/t-260920-bad3.md",
    ]);
    expect(got.parseErrors[2]!.error).toMatch(/does not match the file name/);
  });

  it("reads done months lazily and finds a closed task by id", async () => {
    await put("tasks/done/2026-08/t-260801-dddd.md", task("t-260801-dddd", "done"));
    // Created in September, closed in October: not in its id's month.
    await put("tasks/done/2026-10/t-260915-eeee.md", task("t-260915-eeee", "dropped"));
    const l = state.layout(proj);
    const open = await state.tasks.list(l);
    expect(open.tasks).toEqual([]);
    expect(open.doneMonths).toEqual(["2026-10", "2026-08"]);
    expect((await state.tasks.list(l, { month: "2026-08" })).tasks[0]).toMatchObject({
      id: "t-260801-dddd",
      location: "done",
      month: "2026-08",
    });
    const detail = await state.tasks.get(l, "t-260915-eeee");
    expect(detail).toMatchObject({ status: "dropped", month: "2026-10", notes: "Notes.", log: ["2026-09-20T00:00Z manager: created"] });
    expect(await state.tasks.get(l, "t-260915-none")).toBeNull();
  });
});

describe("objectives + episodes", () => {
  beforeEach(async () => {
    await put(
      "objectives/grow/objective.md",
      "---\ntitle: Grow\nstatus: active\nsuccess: Known\n---\n## Where we are\nEarly.\n## Strategy\nPost.\n## Lessons\n- [[quota-overrun-prone]]\n## Aside\nkept\n",
    );
    await put("objectives/grow/journal/2026-08.md", "## 2026-08-30 10:00Z · ep-260830-1000-aa · imp 2\nold\n");
    await put(
      "objectives/grow/journal/2026-09.md",
      "# Journal\n\n## 2026-09-01 10:00Z · ep-260901-1000-bb · imp 5 · #x\none\n\n## 2026-09-02 10:00Z · ep-260902-1000-cc · imp 6\ntwo\nrefs: t-260920-aaaa\n",
    );
    await put("objectives/NotKebab/objective.md", "---\ntitle: x\n---\n");
    await put("objectives/empty-dir/.keep", "");
    await put("log/2026-09.md", "## 2026-09-03 10:00Z · ep-260903-1000-dd · imp 1\nproject-level\n");
  });

  it("lists objectives, reporting bad directories as parseErrors", async () => {
    const got = await state.objectives.list(state.layout(proj));
    expect(got.objectives.map((o) => o.id)).toEqual(["grow"]);
    expect(got.parseErrors.map((e) => e.file).sort()).toEqual(["objectives/NotKebab", "objectives/empty-dir/objective.md"]);
  });

  it("splits sections and pages the journal by month", async () => {
    const l = state.layout(proj);
    const o = await state.objectives.get(l, "grow", { months: 1 });
    expect(o).toMatchObject({
      whereWeAre: "Early.",
      strategy: "Post.",
      lessons: "- [[quota-overrun-prone]]",
      lessonLinks: ["quota-overrun-prone"],
      otherSections: [{ heading: "Aside", body: "kept" }],
    });
    if (!o || "parseError" in o) throw new Error("expected an objective");
    expect(o.journal.entries.map((e) => e.id)).toEqual(["ep-260902-1000-cc", "ep-260901-1000-bb"]);
    expect(o.journal.entries[0]).toMatchObject({ objective: "grow", file: "objectives/grow/journal/2026-09.md", refs: ["t-260920-aaaa"] });
    expect(o.journal.nextBefore).toBe("2026-09");
    const older = await state.episodes.page(l, "grow", { before: "2026-09", months: 1 });
    expect(older.entries.map((e) => e.id)).toEqual(["ep-260830-1000-aa"]);
    expect(older.nextBefore).toBeNull();
    expect(await state.objectives.get(l, "nope")).toBeNull();
  });

  it("indexes every episode id → file, and refreshes when a journal is appended", async () => {
    const l = state.layout(proj);
    const idx = await state.episodes.index(l);
    expect([...idx.keys()].sort()).toEqual([
      "ep-260830-1000-aa",
      "ep-260901-1000-bb",
      "ep-260902-1000-cc",
      "ep-260903-1000-dd",
    ]);
    expect(idx.get("ep-260903-1000-dd")).toEqual({ file: "log/2026-09.md", line: 1, anchor: "ep-260903-1000-dd" });
    const abs = path.join(proj, "log/2026-09.md");
    await fs.appendFile(abs, "\n## 2026-09-04 10:00Z · ep-260904-1000-ee · imp 3\nnew\n");
    expect((await state.episodes.index(l)).has("ep-260904-1000-ee")).toBe(true);
    expect(await state.episodes.get(l, "ep-260904-1000-ee")).toMatchObject({ objective: null, text: "new" });
  });
});

describe("memory-store scopes", () => {
  beforeEach(async () => {
    const fact = (name: string, d: string) => `---\nname: ${name}\ndescription: ${d}\ntype: pattern\nsince: 2026-09-01\n---\nBody.\n## History\n- created\n`;
    await put("memory/MEMORY.md", "# Shared\nEd's words.\n<!-- managers:index -->\n- [[shared-a]]\n", root);
    await put("memory/facts/shared-a.md", fact("shared-a", "root one"), root);
    await put("memory/facts/same-name.md", fact("same-name", "root copy"), root);
    await put("memory/facts/same-name.md", fact("same-name", "project copy"));
    await put("memory/facts/broken.md", "---\nname: broken\ntype: nonsense\n---\n");
    await put("memory/playbooks/release.md", "# Cut a release\nsteps\n");
  });

  it("a project sees its own memory plus the root's, tagged by scope", async () => {
    const v = await state.memory.view({ project: state.layout(proj), root: state.rootLayout });
    expect(v.indexes.project).toBeNull();
    expect(v.indexes.root).toMatchObject({ preamble: "# Shared\nEd's words.", index: "- [[shared-a]]", file: "memory/MEMORY.md" });
    expect(v.facts.map((f) => `${f.scope}:${f.name}`).sort()).toEqual(["project:same-name", "root:same-name", "root:shared-a"]);
    expect(v.playbooks).toEqual([{ name: "release", description: "Cut a release", scope: "project", file: "memory/playbooks/release.md" }]);
    expect(v.parseErrors).toEqual([expect.objectContaining({ scope: "project", file: "memory/facts/broken.md" })]);
  });

  it("the root workspace sees only root scope", async () => {
    const v = await state.memory.view({ project: null, root: state.rootLayout });
    expect(v.facts.every((f) => f.scope === "root")).toBe(true);
  });

  it("getFact prefers the project copy unless scope says otherwise", async () => {
    const scopes = { project: state.layout(proj), root: state.rootLayout };
    expect(await state.memory.getFact(scopes, "same-name")).toMatchObject({ scope: "project", description: "project copy", history: ["created"], body: "Body." });
    expect(await state.memory.getFact(scopes, "same-name", "root")).toMatchObject({ scope: "root", description: "root copy" });
    expect(await state.memory.getFact(scopes, "shared-a", "project")).toBeNull();
    expect(await state.memory.getFact(scopes, "broken")).toHaveProperty("parseError");
  });
});

describe("runs + reports", () => {
  it("lists runs newest first, filters, and finds one by id", async () => {
    await put("runs/2026-09/r-260926-0700-k3.yaml", "id: r-260926-0700-k3\ntrigger: wake\nstatus: failed\nstarted: 2026-09-26T07:00:02Z\nerror: boom\n");
    await put("runs/2026-09/r-260925-0700-aa.yaml", "trigger: wake\nstatus: succeeded\nstarted: 2026-09-25T07:00:02Z\nexpectResult: missing\n");
    await put("runs/2026-09/r-260924-0700-bb.yaml", "trigger: wake\nstatus: exploded\n");
    const l = state.layout(proj);
    const page = await state.runs.list(l);
    expect(page.runs.map((r) => r.id)).toEqual(["r-260926-0700-k3", "r-260925-0700-aa"]);
    expect(page.parseErrors).toHaveLength(1);
    expect((await state.runs.list(l, { status: "failed" })).runs).toHaveLength(1);
    expect(await state.runs.get(l, "r-260925-0700-aa")).toMatchObject({ expectResult: "missing", kind: "wake", usage: null });
    expect(await state.runs.get(l, "r-260101-0000-zz")).toBeNull();
  });

  it("reads current and dated reports", async () => {
    await put("reports/status/current.md", "---\nupdated: 2026-09-26T07:10:00Z\n---\n# Status\nAll good.\n");
    await put("reports/status/2026-09-26.md", "# Status\nAll good.\n");
    await put("reports/status/2026-09-25.md", "# Status\nMeh.\n");
    const l = state.layout(proj);
    const { reports } = await state.reports.list(l);
    expect(reports).toEqual([
      {
        type: "status",
        current: expect.objectContaining({ title: "Status", updated: "2026-09-26T07:10:00Z", date: null }),
        dates: ["2026-09-26", "2026-09-25"],
      },
    ]);
    expect(reports[0]!.current).not.toHaveProperty("body");
    expect(await state.reports.read(l, "status", "2026-09-25")).toMatchObject({ body: "# Status\nMeh.\n", date: "2026-09-25" });
    expect(await state.reports.read(l, "status", "2026-01-01")).toBeNull();
  });
});

describe("ensureDataRepo", () => {
  it("writes the skeleton and git-inits, and is idempotent", async () => {
    // M9.5: only an EMPTY root is claimed, so drop the shared fixture's project dir.
    await fs.rm(proj, { recursive: true, force: true });
    const r1 = await ensureDataRepo(root, { gitInit: true });
    expect(r1.changed.sort()).toEqual([".gitattributes", ".gitignore", ".managers-data", "README.md"]);
    expect(r1.gitInitialized).toBe(true);
    expect(execFileSync("git", ["-C", root, "symbolic-ref", "HEAD"], { encoding: "utf8" }).trim()).toBe("refs/heads/main");
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          [".gitignore", ".gitattributes", "README.md", DATA_REPO_MARKER].map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")]),
        ),
      );
    const before = await snapshot();
    for (const line of DATA_REPO_GITIGNORE) expect(before[".gitignore"]).toContain(line);
    expect(before[".gitattributes"]).toContain("**/journal/*.md merge=union");

    const r2 = await ensureDataRepo(root, { gitInit: true });
    expect(r2).toEqual({ changed: [], gitInitialized: false, marked: true });
    expect(await snapshot()).toEqual(before);
  });

  it("extends an existing .gitignore without duplicating equivalent lines", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n/.chats/", "utf8");
    await ensureDataRepo(root, { gitInit: false });
    const text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(text.startsWith("node_modules/\n/.chats/\n")).toBe(true);
    expect(text.split("\n").filter((l) => l === ".chats/")).toHaveLength(0);
    expect(text).toContain("**/.managers/briefings/");
    await expect(fs.stat(path.join(root, ".git"))).rejects.toThrow();
  });

  it("does not mark an adopted root that already holds projects", async () => {
    await put("project.yaml", "name: Acme\n");
    const r = await ensureDataRepo(root, { gitInit: false });
    expect(r.marked).toBe(false);
    expect(r.changed).not.toContain(".managers-data");
  });

  // M15: an unborn repo gets the skeleton as its first commit — and only the skeleton.
  it("makes the skeleton the first commit of an unborn repo, once", async () => {
    await fs.rm(proj, { recursive: true, force: true });
    // A marked root with a stray file of Ed's: the stray is never swept into the commit.
    await fs.writeFile(path.join(root, DATA_REPO_MARKER), "", "utf8");
    await fs.writeFile(path.join(root, "stray.txt"), "not ours\n", "utf8");
    const r1 = await ensureDataRepo(root, { gitInit: true, author: { name: "managers-bot", email: "bot@example.test" } });
    expect(r1.initialCommit).toMatch(/^[0-9a-f]{40}$/);
    const g = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
    expect(g("ls-tree", "--name-only", "HEAD").split("\n").sort()).toEqual(
      [".gitattributes", ".gitignore", ".managers-data", "README.md"].sort(),
    );
    expect(g("log", "-1", "--format=%an %s")).toBe("managers-bot managers: initialise data repo");
    expect(g("status", "--porcelain")).toBe("?? stray.txt");
    const r2 = await ensureDataRepo(root, { gitInit: true });
    expect(r2.initialCommit).toBeUndefined();
    expect(g("rev-list", "--count", "HEAD")).toBe("1");
  });

  it("first-commits into an empty clone (only .git) and never into a repo with history", async () => {
    await fs.rm(proj, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
    const parent = path.dirname(root);
    const bare = `${root}-remote.git`;
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["clone", "-q", bare, root], { cwd: parent, stdio: "ignore" });
    try {
      const r = await ensureDataRepo(root, { gitInit: true });
      expect(r.gitInitialized).toBe(false);
      expect(r.marked).toBe(true);
      expect(r.initialCommit).toMatch(/^[0-9a-f]{40}$/);
      // A repo with history: extending .gitignore is left to autocommit/the operator.
      await fs.writeFile(path.join(root, ".gitignore"), "", "utf8");
      const r2 = await ensureDataRepo(root, { gitInit: true });
      expect(r2.changed).toContain(".gitignore");
      expect(r2.initialCommit).toBeUndefined();
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it("MANAGERS_DATA_GIT_INIT=0 turns git init off", () => {
    expect(dataGitInitEnabled({})).toBe(true);
    expect(dataGitInitEnabled({ MANAGERS_DATA_GIT_INIT: "0" })).toBe(false);
    expect(dataGitInitEnabled({ MANAGERS_DATA_GIT_INIT: "1" })).toBe(true);
  });
});

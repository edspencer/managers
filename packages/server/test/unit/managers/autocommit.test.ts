/**
 * Managers M5: autocommit commits ONLY the Managers-owned state paths, as the
 * given author, debounced — over a real git repo in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { GitService } from "../../../src/git.js";
import { Autocommitter, ownedPathsPresent } from "../../../src/managers/autocommit.js";
import { ManagersState } from "../../../src/managers/state.js";
import type { WriteActor } from "../../../src/managers/state-writes.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const bot = { name: "managers-bot", email: "managers-bot@localhost" };
const agent: WriteActor = { kind: "agent", name: "manager", author: bot };

beforeEach(async () => {
  root = await makeTmpDir("managers-autocommit-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  await fs.writeFile(path.join(root, ".gitkeep"), "");
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(async () => {
  await rmTmpDir(root);
});

function setup(debounceMs = 60_000, enabled = true) {
  const state = new ManagersState(root);
  const ac = new Autocommitter({
    git: new GitService(root),
    enabled,
    debounceMs,
    lock: (dir, fn) => state.writer.queue.run(dir, fn),
  });
  state.writer.onWrite = (dir, label, author, reason) => ac.schedule(dir, label, author, reason);
  state.writer.beforeWrite = (dir, author) => ac.beforeWrite(dir, author);
  return { state, ac };
}

describe("Autocommitter", () => {
  it("commits only owned paths, as managers-bot; a dirty notes.md stays uncommitted", async () => {
    const { state, ac } = setup();
    const dir = path.join(root, "acme");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.md"), "Ed's scratch\n");
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Ed's instructions\n");
    const ws = { key: "acme", layout: state.layout(dir) };
    await state.writer.recordEpisode(ws, { text: "one", importance: 3 }, agent);
    await state.writer.upsertTask(ws, { title: "a task" }, agent);
    expect(ac.isPending(dir)).toBe(true);
    const r = await ac.flush(dir);
    expect(r?.committed).toBe(true);
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("managers-bot <managers-bot@localhost>");
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n").sort();
    expect(files.every((f) => f.startsWith("acme/log/") || f.startsWith("acme/tasks/"))).toBe(true);
    expect(files).toHaveLength(2);
    // Two writes, ONE commit (debounced); its body lists what happened.
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
    expect(git("log", "-1", "--format=%B")).toContain("record_episode");
    const status = git("status", "--porcelain");
    expect(status).toContain("acme/notes.md");
    expect(status).toContain("acme/CLAUDE.md");
    expect(status).not.toContain("acme/log");
  });

  it("at the root commits Home's own state dirs, never a project's", async () => {
    const { state, ac } = setup();
    await fs.mkdir(path.join(root, "acme", "log"), { recursive: true });
    await fs.writeFile(path.join(root, "acme", "log", "2026-09.md"), "stray\n");
    const home = { key: "", layout: state.layout(root) };
    await state.writer.upsertTask(home, { title: "home task" }, agent);
    await ac.flush(root);
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tasks\/open\/t-/);
    expect(git("log", "-1", "--format=%s")).toBe("managers: update Home state");
    expect(git("status", "--porcelain")).toContain("acme/");
  });

  it("commits after the debounce on its own", async () => {
    const { state, ac } = setup(50);
    const dir = path.join(root, "acme");
    await state.writer.recordEpisode({ key: "acme", layout: state.layout(dir) }, { text: "x", importance: 1 }, agent);
    for (let i = 0; i < 100 && ac.isPending(dir); i++) await new Promise((r) => setTimeout(r, 20));
    await ac.close();
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("does nothing when disabled (MANAGERS_AUTOCOMMIT=0)", async () => {
    const { state, ac } = setup(10, false);
    const dir = path.join(root, "acme");
    await state.writer.recordEpisode({ key: "acme", layout: state.layout(dir) }, { text: "x", importance: 1 }, agent);
    expect(ac.isPending(dir)).toBe(false);
    expect(await ac.flush(dir)).toBeNull();
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
  });

  it("a different author flushes the pending commit first, so attribution never merges", async () => {
    const { state, ac } = setup();
    const dir = path.join(root, "acme");
    const ws = { key: "acme", layout: state.layout(dir) };
    await state.writer.recordEpisode(ws, { text: "agent", importance: 1 }, agent);
    await state.writer.recordEpisode(
      ws,
      { text: "ed", importance: 1 },
      { kind: "ed", name: "ed", author: { name: "Ed", email: "ed@example.test" } },
    );
    await ac.flush(dir);
    await ac.close();
    expect(git("log", "-2", "--format=%an").split("\n")).toEqual(["Ed", "managers-bot"]);
  });

  it("ownedPathsPresent lists only what exists", async () => {
    await fs.mkdir(path.join(root, "p", "tasks"), { recursive: true });
    expect(await ownedPathsPresent(path.join(root, "p"))).toEqual(["tasks"]);
  });
});

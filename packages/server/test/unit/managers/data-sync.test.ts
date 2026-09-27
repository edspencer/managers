/**
 * Managers M15: the opt-in data-repo sync, against a local bare repo as the
 * remote — a clean push, pulling another clone's edit, a conflicting semantic
 * edit raising `data-sync-failed` (and the rebase aborted), and no remote at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  DataSync,
  dataSyncAlert,
  loadDataSyncConfig,
  parseSyncInterval,
  redactGitText,
  DEFAULT_SYNC_INTERVAL_MS,
} from "../../../src/managers/data-sync.js";
import { ensureDataRepo } from "../../../src/managers/data-repo.js";
import { ManagersState } from "../../../src/managers/state.js";
import { loadAlerts } from "../../../src/managers/alerts.js";
import { Autocommitter } from "../../../src/managers/autocommit.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let base: string;
let bare: string;
let local: string;
let other: string;

const ID = ["-c", "user.name=Other", "-c", "user.email=other@example.test", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function write(dir: string, rel: string, text: string) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text, "utf8");
}

function commitAll(dir: string, msg: string) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
}

const on = { enabled: true, intervalMs: 60_000 };
const sync = (root = local) => new DataSync({ root, config: on, debounceMs: 10 });

beforeEach(async () => {
  base = await makeTmpDir("managers-sync-");
  bare = path.join(base, "remote.git");
  local = path.join(base, "local");
  other = path.join(base, "other");
  git(base, "init", "-q", "--bare", "--initial-branch=main", bare);
  git(base, "clone", "-q", bare, local);
  // Whatever init.defaultBranch this machine has, the branch under test is main.
  git(local, "symbolic-ref", "HEAD", "refs/heads/main");
  // The instance's skeleton commit, exactly as boot makes it.
  await ensureDataRepo(local, { gitInit: true, author: { name: "managers-bot", email: "bot@example.test" } });
});
afterEach(async () => rmTmpDir(base));

describe("DataSync", () => {
  it("pushes the local branch to an empty remote (and sets upstream)", async () => {
    const r = await sync().syncNow();
    expect(r).toEqual({ ok: true, pulled: false, pushed: true });
    expect(git(bare, "rev-parse", "main")).toBe(git(local, "rev-parse", "HEAD"));
    expect(git(local, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    // Nothing new: a second sync neither pulls nor pushes.
    expect(await sync().syncNow()).toEqual({ ok: true, pulled: false, pushed: false });
  });

  it("pulls another clone's edit and pushes its own on top (rebase, no merge commit)", async () => {
    const s = sync();
    await s.syncNow();
    git(base, "clone", "-q", bare, other);
    await write(other, "acme/objectives/o1.md", "---\nid: o1\n---\nEd's edit\n");
    commitAll(other, "ed: edit on github");
    git(other, "push", "-q", "origin", "main");

    await write(local, "acme/log/2026-09.md", "- local entry\n");
    commitAll(local, "managers: local");
    const r = await s.syncNow();
    expect(r).toEqual({ ok: true, pulled: true, pushed: true });
    expect(await fs.readFile(path.join(local, "acme/objectives/o1.md"), "utf8")).toContain("Ed's edit");
    expect(git(bare, "log", "--format=%s", "main").split("\n")).toEqual([
      "managers: local",
      "ed: edit on github",
      "managers: initialise data repo",
    ]);
    expect(s.status.failure).toBeNull();
  });

  it("autostashes dirty local files across the pull", async () => {
    const s = sync();
    await s.syncNow();
    git(base, "clone", "-q", bare, other);
    await write(other, "b.md", "remote\n");
    commitAll(other, "remote");
    git(other, "push", "-q", "origin", "main");
    await write(local, "README.md", "dirty, uncommitted\n");
    expect((await s.syncNow()).ok).toBe(true);
    expect(await fs.readFile(path.join(local, "README.md"), "utf8")).toBe("dirty, uncommitted\n");
    expect(await fs.readFile(path.join(local, "b.md"), "utf8")).toBe("remote\n");
  });

  it("union-merges concurrent journal appends", async () => {
    const s = sync();
    await write(local, "acme/log/2026-09.md", "- first\n");
    commitAll(local, "seed");
    await s.syncNow();
    git(base, "clone", "-q", bare, other);
    await write(other, "acme/log/2026-09.md", "- first\n- from other\n");
    commitAll(other, "other append");
    git(other, "push", "-q", "origin", "main");
    await write(local, "acme/log/2026-09.md", "- first\n- from local\n");
    commitAll(local, "local append");
    expect((await s.syncNow()).ok).toBe(true);
    const log = await fs.readFile(path.join(local, "acme/log/2026-09.md"), "utf8");
    expect(log).toContain("from other");
    expect(log).toContain("from local");
  });

  it("a conflicting semantic-file edit aborts the rebase and raises data-sync-failed on Home", async () => {
    const s = sync();
    await write(local, "acme/objectives/o1.md", "status: active\n");
    commitAll(local, "seed objective");
    await s.syncNow();
    git(base, "clone", "-q", bare, other);
    await write(other, "acme/objectives/o1.md", "status: paused\n");
    commitAll(other, "ed pauses it");
    git(other, "push", "-q", "origin", "main");
    await write(local, "acme/objectives/o1.md", "status: done\n");
    commitAll(local, "manager finishes it");
    const localHead = git(local, "rev-parse", "HEAD");

    const r = await s.syncNow();
    expect(r).toMatchObject({ ok: false, stage: "pull", conflict: true });
    // Aborted: the branch is exactly where it was, no rebase left in progress.
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(local, "status", "--porcelain")).toBe("");
    await expect(fs.stat(path.join(local, ".git", "rebase-merge"))).rejects.toThrow();
    // Nothing was forced onto the remote.
    expect(git(bare, "log", "-1", "--format=%s", "main")).toBe("ed pauses it");

    const alert = dataSyncAlert(s.status);
    expect(alert).toMatchObject({ id: "data-sync-failed:", kind: "data-sync-failed", severity: "error" });
    expect(alert!.message).toMatch(/conflict/i);

    // It surfaces in Home's alerts, and only Home's.
    const state = new ManagersState(local);
    state.dataSync = s;
    const home = await loadAlerts({ state, project: { dir: local }, schedules: async () => [] });
    expect(home.map((a) => a.kind)).toContain("data-sync-failed");
    const acme = await loadAlerts({ state, project: { dir: path.join(local, "acme") }, schedules: async () => [] });
    expect(acme.map((a) => a.kind)).not.toContain("data-sync-failed");

    // Resolve by hand upstream-side (take Ed's), then the next sync clears the alert.
    git(local, "fetch", "-q", "origin");
    git(local, "reset", "-q", "--hard", "origin/main");
    expect((await s.syncNow()).ok).toBe(true);
    expect(dataSyncAlert(s.status)).toBeNull();
  });

  it("skips quietly when there is no remote", async () => {
    const lone = path.join(base, "lone");
    await ensureDataRepo(lone, { gitInit: true });
    const s = sync(lone);
    expect(await s.syncNow()).toEqual({ ok: true, skipped: "no-remote", pulled: false, pushed: false });
    expect(s.status.failure).toBeNull();
    expect(dataSyncAlert(s.status)).toBeNull();
  });

  it("an unreachable remote is a warning, not a conflict, and never prints credentials", async () => {
    git(local, "remote", "set-url", "origin", `file://user:hunter2secret@${path.join(base, "missing.git")}`);
    const s = sync();
    const r = await s.syncNow();
    expect(r.ok).toBe(false);
    const alert = dataSyncAlert(s.status)!;
    expect(alert.severity).toBe("warning");
    expect(alert.message).not.toContain("hunter2secret");
  });

  it("is inert when disabled, and serialises through the given queue", async () => {
    const off = new DataSync({ root: local, config: { enabled: false, intervalMs: 60_000 } });
    expect(await off.syncNow()).toMatchObject({ ok: true, skipped: "disabled" });
    expect(git(bare, "rev-list", "--all")).toBe("");

    const ac = new Autocommitter({ git: { commitProject: async () => ({ committed: false }) }, enabled: true, debounceMs: 1 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const blocker = ac.exclusive(async () => {
      order.push("commit-start");
      await gate;
      order.push("commit-end");
    });
    const s = new DataSync({ root: local, config: on, serialize: (fn) => ac.exclusive(async () => {
      order.push("sync");
      return fn();
    }) });
    const p = s.syncNow();
    // Joining: a second call while one is queued returns the same promise.
    expect(s.syncNow()).toBe(p);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["commit-start"]);
    release();
    await blocker;
    expect((await p).ok).toBe(true);
    expect(order).toEqual(["commit-start", "commit-end", "sync"]);
  });

  it("request() debounces a burst into one sync", async () => {
    const s = sync();
    let calls = 0;
    const orig = s.syncNow.bind(s);
    s.syncNow = () => {
      calls++;
      return orig();
    };
    s.request();
    s.request();
    s.request();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
    await s.stop();
  });
});

describe("data sync config", () => {
  it("is off by default with a 10 minute interval", () => {
    expect(loadDataSyncConfig({})).toEqual({ enabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS });
    expect(DEFAULT_SYNC_INTERVAL_MS).toBe(600_000);
  });
  it("reads MANAGERS_DATA_SYNC and MANAGERS_DATA_SYNC_INTERVAL", () => {
    expect(loadDataSyncConfig({ MANAGERS_DATA_SYNC: "1", MANAGERS_DATA_SYNC_INTERVAL: "5m" })).toEqual({
      enabled: true,
      intervalMs: 300_000,
    });
    // Floor at 10 s; junk falls back to the default.
    expect(loadDataSyncConfig({ MANAGERS_DATA_SYNC: "1", MANAGERS_DATA_SYNC_INTERVAL: "1s" }).intervalMs).toBe(10_000);
    expect(loadDataSyncConfig({ MANAGERS_DATA_SYNC_INTERVAL: "soon" }).intervalMs).toBe(600_000);
  });
  it("parses durations", () => {
    expect(parseSyncInterval("30s")).toBe(30_000);
    expect(parseSyncInterval("2h")).toBe(7_200_000);
    expect(parseSyncInterval("90000")).toBe(90_000);
    expect(parseSyncInterval("")).toBeNull();
  });
  it("redacts credentials in git output", () => {
    expect(redactGitText("fatal: unable to access 'https://x-access-token:abc123@github.com/o/r.git/'")).toBe(
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    );
    expect(redactGitText("token ghp_ABCDEFGHIJKLMNOP leaked")).toBe("token [redacted] leaked");
  });
});

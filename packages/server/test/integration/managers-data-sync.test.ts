/**
 * Managers M15: the data-repo sync on the REAL app — `MANAGERS_DATA_SYNC=1` wires
 * a sync that pushes an autocommit to a local bare remote, and a failure shows
 * as a `data-sync-failed` alert on Home in `GET /api/managers/needs-you` and
 * Home's `…/managers/alerts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

let t: TestApp;
let bare: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeAll(async () => {
  t = await startTestApp({
    gitRepo: true,
    env: { MANAGERS_DATA_SYNC: "1", MANAGERS_DATA_SYNC_INTERVAL: "1h", MANAGERS_AUTOCOMMIT_DEBOUNCE_MS: "50" },
  });
  bare = path.join(t.tmp, "remote.git");
  git(t.tmp, "init", "-q", "--bare", bare);
  git(t.projectsRoot, "remote", "add", "origin", bare);
});
afterAll(async () => t?.teardown());

describe("data sync (integration)", () => {
  it("is on, and pushes an autocommitted state write", async () => {
    expect(t.dataSync.status.enabled).toBe(true);
    const p = (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme" } })).json() as {
      project: { slug: string; dir: string };
    };
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${p.project.slug}/managers/objectives`,
      payload: { id: "ship-sync", title: "Ship the sync", success: "Pushed" },
    });
    expect(res.statusCode).toBe(201);
    await t.autocommit.flush(p.project.dir);
    const r = await t.dataSync.syncNow();
    expect(r.ok).toBe(true);
    const branch = git(t.projectsRoot, "symbolic-ref", "--short", "HEAD");
    expect(git(bare, "rev-parse", branch)).toBe(git(t.projectsRoot, "rev-parse", "HEAD"));
    expect(git(bare, "log", "-1", "--format=%s", branch)).toMatch(/managers: update/);
  });

  it("commits a project's creation and its deletion, so the remote stops carrying it", async () => {
    const p = (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Throwaway" } })).json() as {
      project: { slug: string; dir: string };
    };
    const tracked = () => git(t.projectsRoot, "ls-files", "--", p.project.slug).split("\n").filter(Boolean);
    expect(tracked()).toEqual(expect.arrayContaining([`${p.project.slug}/project.yaml`, `${p.project.slug}/CLAUDE.md`]));
    expect(git(t.projectsRoot, "log", "-1", "--format=%s")).toBe(`managers: create project ${p.project.slug}`);
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${p.project.slug}/managers/objectives`,
      payload: { id: "tmp", title: "Temporary", success: "Gone" },
    });
    await t.autocommit.flush(p.project.dir);
    expect(tracked().length).toBeGreaterThan(2);

    const del = await t.app.inject({ method: "DELETE", url: `/api/projects/${p.project.slug}` });
    expect(del.statusCode).toBe(200);
    expect(tracked()).toEqual([]);
    expect(git(t.projectsRoot, "log", "-1", "--format=%s")).toBe(`managers: delete project ${p.project.slug}`);
    expect(git(t.projectsRoot, "status", "--porcelain", "--", p.project.slug)).toBe("");
    expect((await t.dataSync.syncNow()).ok).toBe(true);
    const branch = git(t.projectsRoot, "symbolic-ref", "--short", "HEAD");
    expect(git(bare, "ls-tree", "-r", "--name-only", branch)).not.toContain(`${p.project.slug}/`);
  });

  it("a failing sync raises data-sync-failed on Home (needs-you and alerts)", async () => {
    git(t.projectsRoot, "remote", "set-url", "origin", path.join(t.tmp, "gone.git"));
    const r = await t.dataSync.syncNow();
    expect(r.ok).toBe(false);
    const ny = (await t.app.inject({ method: "GET", url: "/api/managers/needs-you" })).json() as {
      projects: { slug: string; alerts: { kind: string }[] }[];
    };
    const home = ny.projects.find((p) => p.slug === "");
    expect(home?.alerts.map((a) => a.kind)).toContain("data-sync-failed");
    for (const p of ny.projects.filter((x) => x.slug !== "")) {
      expect(p.alerts.map((a) => a.kind)).not.toContain("data-sync-failed");
    }
    // Restored remote → the next sync clears it.
    git(t.projectsRoot, "remote", "set-url", "origin", bare);
    expect((await t.dataSync.syncNow()).ok).toBe(true);
    const after = (await t.app.inject({ method: "GET", url: "/api/managers/needs-you?all=1" })).json() as {
      projects: { slug: string; alerts: { kind: string }[] }[];
    };
    expect(after.projects.find((p) => p.slug === "")?.alerts.map((a) => a.kind) ?? []).not.toContain("data-sync-failed");
  });
});

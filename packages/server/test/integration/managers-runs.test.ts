/**
 * Managers M6: every trigger fire writes a run record, `expect` is evaluated at
 * run end, the alerts are computed from the records, and the run is committed
 * as soon as it ends.
 *
 * Boots the REAL app (projects root a git repo) and fires triggers through the
 * "Run now" route; the fake `claude`'s `[[MCP managers.*]]` directives call the
 * state tools over herdctl's localhost bridge, `[[APIERROR]]` fails the turn.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type Run = {
  id: string;
  trigger: string;
  kind: string;
  status: string;
  sessionId: string | null;
  episodes: string[];
  artifacts: unknown[];
  mcpCalls: Record<string, Record<string, number>>;
  expect: { kind: string; within: string | null } | null;
  expectResult: string | null;
  error: string | null;
  errorKind?: string | null;
  usage?: { outputTokens: number } | null;
  file: string;
};
type Alert = { id: string; kind: string; trigger: string; severity: string; message: string; runId: string | null };

describe("integration: Managers runs, expect and alerts (M6)", () => {
  let t: TestApp;
  let acme: Project;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();
  const botCommits = () => git("log", "--format=%an", "--author=managers-bot").split("\n").filter(Boolean).length;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000, gitRepo: true });
    acme = ((await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme Site" } })).json() as {
      project: Project;
    }).project;
  });
  afterAll(async () => {
    await t.teardown();
  });

  const get = async <T>(url: string): Promise<T> => {
    const res = await t.app.inject({ method: "GET", url: `/api/projects/${acme.slug}/managers${url}` });
    expect(res.statusCode).toBe(200);
    return res.json() as T;
  };
  const alerts = () => get<Alert[]>("/alerts");

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Create (or replace) a trigger, Run-now it, and wait for its run record to finish. */
  async function fire(
    name: string,
    prompt: string,
    expectBlock: Record<string, unknown> | undefined,
    enabled = false,
  ): Promise<Run> {
    await t.triggers.set(acme.slug, name, {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt, ...(expectBlock ? { expect: expectBlock } : {}) },
      enabled,
    });
    const before = new Set((await get<{ runs: Run[] }>(`/runs?trigger=${name}`)).runs.map((r) => r.id));
    const res = await t.app.inject({ method: "POST", url: `/api/projects/${acme.slug}/triggers/${name}/run` });
    expect(res.statusCode).toBe(202);
    return waitFor(async () => {
      const { runs } = await get<{ runs: Run[] }>(`/runs?trigger=${name}`);
      return runs.find((r) => !before.has(r.id) && r.status !== "running") ?? null;
    });
  }

  it("empty state: a project with no triggers and no runs has no alerts", async () => {
    expect(await alerts()).toEqual([]);
  });

  it("expect episode + one recorded episode → met, the episode noted on the run, and ONE commit at run end", async () => {
    const commits = botCommits();
    const run = await fire(
      "pub-ok",
      'Check. [[MCP managers.record_episode {"text":"Checked the post","importance":3}]] [[MCP managers.list_projects {}]]',
      { kind: "episode", within: "48h" },
      true,
    );
    expect(run).toMatchObject({ trigger: "pub-ok", kind: "wake", status: "succeeded", expectResult: "met", error: null });
    expect(run.sessionId).toBeTruthy();
    expect(run.episodes).toHaveLength(1);
    // managers.* calls are not counted; nothing else was called.
    expect(run.mcpCalls).toEqual({});
    const log = await get<{ log: { entries: { id: string; run: string | null }[] } }>("/log");
    expect(log.log.entries.find((e) => e.id === run.episodes[0])).toMatchObject({ run: run.id });

    // Committed at run end — not after the 10 s debounce — as one bot commit
    // holding the run record and the episode.
    await waitFor(async () => botCommits() === commits + 1 || null, 5_000);
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n").sort();
    expect(files).toContain(`${acme.slug}/${run.file}`);
    expect(files.some((f) => /\/log\/\d{4}-\d{2}\.md$/.test(f))).toBe(true);
    expect(git("status", "--porcelain", "--", `${acme.slug}/runs`, `${acme.slug}/log`)).toBe("");
    const onDisk = YAML.parse(git("show", `HEAD:${acme.slug}/${run.file}`));
    expect(onDisk).toMatchObject({ status: "succeeded", expectResult: "met" });

    // An enabled trigger with a met run inside its window raises nothing.
    expect((await alerts()).filter((a) => a.trigger === "pub-ok")).toEqual([]);
  });

  it("expect episode + none recorded → missing, and an artifact-missing alert", async () => {
    const run = await fire("pub-empty", "Nothing to do.", { kind: "episode" });
    expect(run).toMatchObject({ status: "succeeded", expectResult: "missing" });
    const a = (await alerts()).find((x) => x.id === "artifact-missing:pub-empty");
    expect(a).toMatchObject({ severity: "warning", runId: run.id });
  });

  it("[[APIERROR]] → failed, and a run-failed alert that the run detail also names", async () => {
    const run = await fire("pub-fail", "[[APIERROR]]", { kind: "episode", within: "48h" });
    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
    const all = await alerts();
    expect(all.find((x) => x.id === "run-failed:pub-fail")).toMatchObject({ severity: "error", runId: run.id });
    // Errors sort first.
    expect(all[0]!.severity).toBe("error");
    // Failed → run-failed only, never also artifact-missing.
    expect(all.find((x) => x.id === "artifact-missing:pub-fail")).toBeUndefined();

    const detail = await get<{ run: Run; durationSeconds: number | null; chat: unknown; alerts: Alert[] }>(
      `/runs/${run.id}`,
    );
    expect(detail.run.id).toBe(run.id);
    expect(typeof detail.durationSeconds).toBe("number");
    expect(detail.alerts.map((x) => x.id)).toEqual(["run-failed:pub-fail"]);
  });

  it("record_artifact works inside a run (the run id reaches the state tools) and meets an artifact expectation", async () => {
    const run = await fire(
      "ship",
      '[[MCP managers.record_artifact {"kind":"commit","ref":"abc1234","note":"landed"}]]',
      { kind: "artifact" },
    );
    expect(run).toMatchObject({ status: "succeeded", expectResult: "met" });
    expect(run.artifacts).toMatchObject([{ kind: "commit", ref: "abc1234", note: "landed" }]);
  });

  it("an enabled trigger with a window and no met run is stale; a fresh project still has none", async () => {
    await t.triggers.set(acme.slug, "never-ran", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "x", expect: { kind: "episode", within: "24h" } },
      enabled: true,
    });
    expect((await alerts()).map((a) => a.id)).toContain("stale:never-ran");
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Empty One" } });
    const empty = await t.app.inject({ method: "GET", url: "/api/projects/empty-one/managers/alerts" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
  });

  it("run.expect survives a trigger enable/disable round-trip AND an unrelated project PATCH", async () => {
    await t.triggers.set(acme.slug, "keep-expect", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "x", expect: { kind: "report", report: "status", within: "7d" } },
      enabled: false,
    });
    const url = `/api/projects/${acme.slug}/triggers/keep-expect`;
    const cur = ((await t.app.inject({ method: "GET", url })).json() as { trigger: { trigger: unknown; run: unknown } })
      .trigger;
    // The Triggers tab's enable toggle PUTs the record back with `enabled` flipped.
    const put = await t.app.inject({ method: "PUT", url, payload: { trigger: cur.trigger, run: cur.run, enabled: true } });
    expect(put.statusCode).toBe(200);
    const patch = await t.app.inject({
      method: "PATCH",
      url: `/api/projects/${acme.slug}`,
      payload: { maxTurns: 40 },
    });
    expect(patch.statusCode).toBeLessThan(300);
    const yaml = YAML.parse(await fs.readFile(path.join(acme.dir, "project.yaml"), "utf8")) as {
      triggers: Record<string, { run: { expect?: unknown } }>;
    };
    expect(yaml.triggers["keep-expect"]!.run.expect).toEqual({ kind: "report", report: "status", within: "7d" });
  });

  it("a malformed expect is refused by the trigger schema", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/projects/${acme.slug}/triggers/bad-expect`,
      payload: {
        trigger: { type: "schedule", cron: "0 0 1 1 *" },
        run: { prompt: "x", expect: { kind: "episode", within: "2 weeks" } },
        enabled: false,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- #11: the runtime refuses the turn -----------------------------------------
  // From 2026-10-04 to 2026-10-16 every turn died on an expired Claude login and
  // every run was recorded `succeeded`, error null, 0 output tokens.

  /** Fire a one-off trigger in ANY project and wait for its finished run. */
  async function fireIn(slug: string, name: string, prompt: string): Promise<Run> {
    await t.triggers.set(slug, name, {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt, expect: { kind: "episode", within: "48h" } },
      enabled: true,
    });
    const runsOf = async () =>
      ((await t.app.inject({ method: "GET", url: `/api/projects/${slug}/managers/runs?trigger=${name}` })).json() as {
        runs: Run[];
      }).runs;
    const before = new Set((await runsOf()).map((r) => r.id));
    const res = await t.app.inject({ method: "POST", url: `/api/projects/${slug}/triggers/${name}/run` });
    expect(res.statusCode).toBe(202);
    return waitFor(async () => (await runsOf()).find((r) => !before.has(r.id) && r.status !== "running") ?? null);
  }
  const needsYou = async () =>
    (await t.app.inject({ method: "GET", url: "/api/managers/needs-you" })).json() as {
      instanceAlerts: (Alert & { folded: number })[];
      projects: { slug: string; alerts?: Alert[] }[];
    };

  it("[[AUTHFAIL]] (the SDK shape: a synthetic error + a 'success' result) → failed, with the runtime's message", async () => {
    // Run finish times are to the second, and a success tying a failure counts as
    // newer; keep the earlier tests' successes out of this streak's second.
    await new Promise((r) => setTimeout(r, 1100));
    const run = await fire("auth-sdk", "[[AUTHFAIL]]", { kind: "episode", within: "48h" });
    expect(run).toMatchObject({
      status: "failed",
      errorKind: "runtime",
      error: "Not logged in · Please run /login (authentication_failed · HTTP 401)",
    });
    expect(run.usage?.outputTokens ?? 0).toBe(0);
    // The run-failed alert carries the message; nothing says artifact-missing.
    const all = await alerts();
    expect(all.find((x) => x.id === "run-failed:auth-sdk")?.message).toContain("Not logged in · Please run /login");
    expect(all.find((x) => x.id === "artifact-missing:auth-sdk")).toBeUndefined();
    // The run detail (the RunDrawer's read) has it too.
    const detail = await get<{ run: Run }>(`/runs/${run.id}`);
    expect(detail.run).toMatchObject({ errorKind: "runtime", error: run.error });
  });

  it("[[AUTHFAIL:cli]] (the CLI shape: no result line, exit 1) → failed with the runtime's message, not the exit code", async () => {
    const run = await fire("auth-cli", "[[AUTHFAIL:cli]]", undefined);
    expect(run).toMatchObject({ status: "failed", errorKind: "runtime" });
    expect(run.error).toContain("Not logged in · Please run /login");
    expect(run.error).not.toContain("exited with code");
  });

  it("[[EMPTYTURN]] (no assistant message, 0 output tokens, 'success') → failed as no-output", async () => {
    const run = await fire("empty", "[[EMPTYTURN]]", undefined);
    expect(run).toMatchObject({ status: "failed", errorKind: "no-output" });
    expect(run.error).toMatch(/produced no output/);
  });

  it("failures across projects raise ONE runtime-unavailable on Home, folding the per-trigger alerts; the next good run clears it", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Blog" } });
    await fireIn("blog", "roadmap", "[[AUTHFAIL]]");

    const down = await needsYou();
    expect(down.instanceAlerts).toHaveLength(1);
    const alert = down.instanceAlerts[0]!;
    expect(alert).toMatchObject({ id: "runtime-unavailable:", kind: "runtime-unavailable", severity: "error" });
    expect(alert.message).toMatch(
      /^Claude runtime is failing: Not logged in · Please run \/login \(authentication_failed · HTTP 401\)\. \d+ runs failed across 2 workspaces since /,
    );
    // The per-trigger run-failed (and stale) alerts it explains are folded away…
    expect(alert.folded).toBeGreaterThanOrEqual(2);
    const shown = down.projects.flatMap((p) => p.alerts ?? []).map((a) => a.id);
    expect(shown).not.toContain("run-failed:roadmap");
    expect(shown).not.toContain("run-failed:auth-sdk");
    // …but an unrelated failure (the agent's own error) still shows.
    expect(shown).toContain("run-failed:pub-fail");
    // The project's own alerts route is unchanged: the full truth stays there.
    expect((await alerts()).map((a) => a.id)).toContain("run-failed:auth-sdk");

    // The runtime comes back: one good run anywhere clears the instance alert.
    await new Promise((r) => setTimeout(r, 1100));
    const ok = await fireIn("blog", "roadmap", "All good.");
    expect(ok.status).toBe("succeeded");
    expect((await needsYou()).instanceAlerts).toEqual([]);
  });
});

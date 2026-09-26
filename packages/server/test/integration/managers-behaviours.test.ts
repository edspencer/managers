/**
 * Managers M8: behaviours and binary autonomy on the real app.
 *
 * Home (the root) defines `triage-external-prs`, gating the trigger `triage-prs`
 * and the tool `mcp__paddock__create_chat`. A project binds an ENABLED schedule
 * trigger to it and leaves the behaviour OFF — the default. Then:
 *
 *   - "Run now" is a 409 naming the behaviour, and NOTHING runs (no run record, no chat);
 *   - the keeper's schedule is not armed and its denied_tools carry the tool, on
 *     the registered agent AND on the spawned `claude`'s argv;
 *   - the Behaviours PATCH switches it on (project.yaml, an #autonomy episode, one
 *     commit with both), after which Run now works and the briefing lists it ON;
 *   - a hand edit of project.yaml raises `behaviours-changed-outside-ui`;
 *   - `answer … wake: true` respects the wake trigger's behaviour;
 *   - the block survives an unrelated project PATCH and a Triggers-tab PUT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { keeperAgentName } from "../../src/herdctl-agent-names.js";
import type { Project } from "../../src/projects.js";

type Run = { id: string; trigger: string; status: string; sessionId: string | null };
type Behaviour = {
  name: string;
  enabled: boolean;
  origin: string;
  inherited: boolean;
  boundTriggers: { name: string; exists: boolean; enabled: boolean }[];
};
type Invocation = { prompt: string; disallowedTools: string | null };

const BEHAVIOUR = "triage-external-prs";
const TOOL = "mcp__paddock__create_chat";

describe("integration: behaviours and binary autonomy (M8)", () => {
  let t: TestApp;
  let proj: Project;
  let logPath: string;
  const api = (slug: string) => `/api/projects/${slug}/managers`;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const behaviours = async (slug: string) =>
    (await inject("GET", `${api(slug)}/behaviours`)).json() as {
      behaviours: Behaviour[];
      changedOutsideUi: boolean;
    };
  const runs = async (slug: string, trigger: string) =>
    ((await inject("GET", `${api(slug)}/runs?trigger=${trigger}`)).json() as { runs: Run[] }).runs;
  const keeper = (slug: string) =>
    t.herdctl.manager.getAgents().find((a) => a.name === keeperAgentName(slug)) as unknown as {
      denied_tools?: string[];
      schedules?: Record<string, { enabled?: boolean }>;
    };

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function writeRootBehaviours(defs: Record<string, unknown>): Promise<void> {
    const file = path.join(t.projectsRoot, "project.yaml");
    const doc = ((await fs.readFile(file, "utf8").then((r) => YAML.parse(r)).catch(() => null)) ?? {}) as Record<string, unknown>;
    doc.behaviours = defs;
    await fs.writeFile(file, YAML.stringify(doc), "utf8");
  }

  beforeAll(async () => {
    logPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "m8-inv-")), "invocations.jsonl");
    t = await startTestApp({ sweepIntervalMs: 600_000, gitRepo: true, env: { MANAGERS_FAKE_INVOCATION_LOG: logPath } });
    await writeRootBehaviours({
      [BEHAVIOUR]: {
        enabled: true, // Home's own switch: must not reach the project
        description: "Triage PRs from outside contributors.",
        triggers: ["triage-prs"],
        tools: [TOOL],
        instructions: "Name the PR by number only.",
      },
    });
    proj = ((await inject("POST", "/api/projects", { name: "Widget Lib" })).json() as { project: Project }).project;
    await t.triggers.set(proj.slug, "triage-prs", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "Triage external PRs.", behaviour: BEHAVIOUR },
      enabled: true,
    });
    // M5's seeded wake is disabled; enable it, gated by the same behaviour, for the answer test.
    await t.triggers.set(proj.slug, "wake", {
      trigger: { type: "schedule", cron: "0 7 * * *" },
      run: { prompt: "Wake.", behaviour: BEHAVIOUR },
      enabled: true,
    });
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("lists the inherited behaviour OFF (Home's own enabled ignored), with its bound triggers", async () => {
    const b = (await behaviours(proj.slug)).behaviours.find((x) => x.name === BEHAVIOUR)!;
    expect(b).toMatchObject({ enabled: false, origin: "home", inherited: true });
    expect(b.boundTriggers.map((x) => x.name)).toEqual(["triage-prs", "wake"]);
    // …and ON for Home itself, whose switch it is.
    const home = ((await inject("GET", "/api/root/managers/behaviours")).json() as { behaviours: Behaviour[] }).behaviours;
    expect(home.find((x) => x.name === BEHAVIOUR)).toMatchObject({ enabled: true, origin: "home", inherited: false });
  });

  it("off: the schedule is not armed and the keeper denies the behaviour's tool plus the anti-tamper edits", async () => {
    const k = keeper(proj.slug);
    expect(k.schedules?.["triage-prs"]?.enabled).toBe(false);
    expect(k.denied_tools).toContain(TOOL);
    expect(k.denied_tools).toContain("Edit(project.yaml)");
    expect(k.denied_tools).toContain("Write(.managers/**)");
  });

  it("off: Run now is a 409 naming the behaviour, and nothing runs", async () => {
    const before = (await t.herdctl.listSessions(await t.projects.get(proj.slug)).catch(() => [])).length;
    const res = await inject("POST", `/api/projects/${proj.slug}/triggers/triage-prs/run`);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; error: string; behaviours: string[] };
    expect(body.code).toBe("behaviour_off");
    expect(body.behaviours).toEqual([BEHAVIOUR]);
    expect(body.error).toContain(`"${BEHAVIOUR}"`);
    expect(await runs(proj.slug, "triage-prs")).toEqual([]);
    const after = (await t.herdctl.listSessions(await t.projects.get(proj.slug)).catch(() => [])).length;
    expect(after).toBe(before);
  });

  it("off: answer … wake:true does not fire the gated wake, and says why", async () => {
    const task = (
      (await inject("POST", `${api(proj.slug)}/tasks`, { title: "Merge #88?", status: "awaiting-ed", ask: "Merge?" })).json() as {
        task: { id: string };
      }
    ).task;
    const res = await inject("POST", `${api(proj.slug)}/tasks/${task.id}/answer`, { text: "yes", wake: true });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { wake: { fired: boolean; reason: string } }).wake).toEqual({
      fired: false,
      reason: `the wake trigger's behaviour "${BEHAVIOUR}" is off`,
    });
    expect(await runs(proj.slug, "wake")).toEqual([]);
  });

  it("off: the briefing lists it as not permitted", async () => {
    const text = ((await inject("GET", `${api(proj.slug)}/briefing`)).json() as { text: string }).text;
    const sec = text.slice(text.indexOf("## Behaviours"), text.indexOf("## Connections"));
    expect(sec).toContain("ON: none.");
    expect(sec).toContain(`- ${BEHAVIOUR} — Triage PRs`);
  });

  it("an off behaviour's tool reaches the spawned claude's --disallowedTools", async () => {
    await t.triggers.set(proj.slug, "plain", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "M8 plain turn." },
      enabled: false,
    });
    expect((await inject("POST", `/api/projects/${proj.slug}/triggers/plain/run`)).statusCode).toBe(202);
    const inv = await waitFor(async () => {
      const raw = await fs.readFile(logPath, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Invocation)
        .find((i) => i.prompt.includes("M8 plain turn."));
    });
    const denied = (inv.disallowedTools ?? "").split(",");
    expect(denied).toContain(TOOL);
    expect(denied).toContain("Edit(project.yaml)");
    expect(denied).toContain("Edit(**/.managers/**)");
  });

  it("PATCH validates: 400 for a bad name or body, 404 for an undefined behaviour", async () => {
    expect((await inject("PATCH", `${api(proj.slug)}/behaviours/Bad%20Name`, { enabled: true })).statusCode).toBe(400);
    expect((await inject("PATCH", `${api(proj.slug)}/behaviours/${BEHAVIOUR}`, { enabled: "yes" })).statusCode).toBe(400);
    expect((await inject("PATCH", `${api(proj.slug)}/behaviours/nope`, { enabled: true })).statusCode).toBe(404);
    // A no-op switch changes nothing and logs nothing.
    const same = await inject("PATCH", `${api(proj.slug)}/behaviours/${BEHAVIOUR}`, { enabled: false });
    expect(same.statusCode).toBe(200);
    expect((same.json() as { changed: boolean }).changed).toBe(false);
  });

  it("on: PATCH writes project.yaml, re-arms, logs #autonomy and commits both; Run now then works", async () => {
    const res = await inject("PATCH", `${api(proj.slug)}/behaviours/${BEHAVIOUR}`, { enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { changed: boolean; behaviour: Behaviour; episode: { id: string; file: string } };
    expect(body.changed).toBe(true);
    expect(body.behaviour.enabled).toBe(true);

    const yaml = YAML.parse(await fs.readFile(path.join(proj.dir, "project.yaml"), "utf8")) as {
      behaviours: Record<string, { enabled: boolean }>;
    };
    expect(yaml.behaviours).toEqual({ [BEHAVIOUR]: { enabled: true } });

    const log = await fs.readFile(path.join(proj.dir, body.episode.file), "utf8");
    expect(log).toContain("#autonomy");
    expect(log).toContain(`Ed turned behaviour ${BEHAVIOUR} ON`);

    // One commit carrying project.yaml and the log.
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
    expect(files).toContain(`${proj.slug}/project.yaml`);
    expect(files).toContain(`${proj.slug}/${body.episode.file}`);
    expect(git("status", "--porcelain", "--", `${proj.slug}/project.yaml`)).toBe("");

    const k = keeper(proj.slug);
    expect(k.schedules?.["triage-prs"]?.enabled).toBe(true);
    expect(k.denied_tools).not.toContain(TOOL);
    expect(k.denied_tools).toContain("Edit(project.yaml)");

    const run = await inject("POST", `/api/projects/${proj.slug}/triggers/triage-prs/run`);
    expect(run.statusCode, run.body).toBe(202);
    const done = await waitFor(async () => (await runs(proj.slug, "triage-prs")).find((r) => r.status !== "running"));
    expect(done.status).toBe("succeeded");

    const text = ((await inject("GET", `${api(proj.slug)}/briefing`)).json() as { text: string }).text;
    const sec = text.slice(text.indexOf("## Behaviours"), text.indexOf("## Connections"));
    expect(sec).toContain(`**${BEHAVIOUR}**`);
    expect(sec).toContain("instructions: Name the PR by number only.");
    // The PATCH re-recorded the known-good state: no out-of-UI alert.
    expect((await behaviours(proj.slug)).changedOutsideUi).toBe(false);
  });

  it("off again: a second #autonomy episode, and the tool is denied again", async () => {
    const res = await inject("PATCH", `${api(proj.slug)}/behaviours/${BEHAVIOUR}`, { enabled: false });
    expect(res.statusCode).toBe(200);
    const log = (
      (await inject("GET", `${api(proj.slug)}/log`)).json() as { log: { entries: { tags: string[]; text: string }[] } }
    ).log.entries.filter((e) => e.tags.includes("autonomy"));
    expect(log).toHaveLength(2);
    expect(log.map((e) => (/ (ON|OFF):/.exec(e.text) ?? [])[1]).sort()).toEqual(["OFF", "ON"]);
    expect(keeper(proj.slug).denied_tools).toContain(TOOL);
    expect((await inject("POST", `/api/projects/${proj.slug}/triggers/triage-prs/run`)).statusCode).toBe(409);
  });

  it("the behaviours block survives an unrelated project PATCH and a Triggers-tab PUT", async () => {
    const p = await inject("PATCH", `/api/projects/${proj.slug}`, { summary: "Unrelated edit." });
    expect(p.statusCode, p.body).toBe(200);
    // The Triggers tab saves by full replace, carrying the run fields it doesn't show.
    const get = (await inject("GET", `/api/projects/${proj.slug}/triggers`)).json() as {
      triggers: { name: string; trigger: unknown; run: Record<string, unknown>; enabled: boolean }[];
    };
    const tr = get.triggers.find((x) => x.name === "triage-prs")!;
    const put = await inject("PUT", `/api/projects/${proj.slug}/triggers/triage-prs`, {
      trigger: tr.trigger,
      run: { ...tr.run, prompt: "Triage external PRs, edited." },
      enabled: tr.enabled,
    });
    expect(put.statusCode, put.body).toBe(200);
    const yaml = YAML.parse(await fs.readFile(path.join(proj.dir, "project.yaml"), "utf8")) as {
      summary: string;
      behaviours: Record<string, unknown>;
      triggers: Record<string, { run: { behaviour?: string; prompt: string } }>;
    };
    expect(yaml.summary).toBe("Unrelated edit.");
    expect(yaml.behaviours).toEqual({ [BEHAVIOUR]: { enabled: false } });
    expect(yaml.triggers["triage-prs"]!.run).toMatchObject({ behaviour: BEHAVIOUR, prompt: "Triage external PRs, edited." });
    // Neither edit is an autonomy change.
    expect((await behaviours(proj.slug)).changedOutsideUi).toBe(false);
  });

  it("a hand edit flipping it on raises behaviours-changed-outside-ui; Acknowledge clears it", async () => {
    const file = path.join(proj.dir, "project.yaml");
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, raw.replace(/(triage-external-prs:\n\s+enabled:) false/, "$1 true"), "utf8");
    expect((await t.projects.get(proj.slug)).behaviours?.[BEHAVIOUR]?.enabled).toBe(true);

    const alerts = (await inject("GET", `${api(proj.slug)}/alerts`)).json() as { id: string; severity: string }[];
    expect(alerts.find((a) => a.id === "behaviours-changed-outside-ui")).toMatchObject({ severity: "info" });
    expect((await behaviours(proj.slug)).changedOutsideUi).toBe(true);
    // The briefing carries it too.
    const text = ((await inject("GET", `${api(proj.slug)}/briefing`)).json() as { text: string }).text;
    expect(text).toContain("[info] behaviours-changed-outside-ui");

    expect((await inject("POST", `${api(proj.slug)}/behaviours/acknowledge`)).statusCode).toBe(200);
    const after = (await inject("GET", `${api(proj.slug)}/alerts`)).json() as { id: string }[];
    expect(after.find((a) => a.id === "behaviours-changed-outside-ui")).toBeUndefined();
  });

  it("empty state: a fresh project lists only the inherited and built-in behaviours, all off", async () => {
    const empty = ((await inject("POST", "/api/projects", { name: "Empty Project" })).json() as { project: Project }).project;
    const list = (await behaviours(empty.slug)).behaviours;
    expect(list.map((b) => [b.name, b.origin, b.enabled])).toEqual([
      ["consolidate-memory", "builtin", false],
      [BEHAVIOUR, "home", false],
    ]);
    expect((await inject("GET", "/api/projects/nope/managers/behaviours")).statusCode).toBe(404);
  });
});

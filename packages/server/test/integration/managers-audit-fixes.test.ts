/**
 * Managers M9.5: regression tests for the M1–M8 audit's blocker and majors, on
 * the real app.
 *
 *   #1 concurrent project.yaml saves (Home and a project) never lose `behaviours:`
 *      and a gated trigger stays 409 throughout;
 *   #2 an unreadable Home project.yaml fails CLOSED: the gate holds, the tool
 *      stays denied after a project save, an error alert is raised, and nothing
 *      rewrites the broken file;
 *   #3 an agent cannot remove + recreate (or edit) a behaviour-gated trigger
 *      through the `managers` MCP trigger tools — the audit's exact sequence,
 *      driven through the fake `claude`;
 *   #4 concurrent identical switches record ONE change and ONE episode;
 *   #6 a switch's commit does not sweep in other project.yaml edits.
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

type Block = { type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Line = { type: string; message?: { content?: string | Block[] } };

async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === `${sessionId}.jsonl`) return path.join((e as unknown as { parentPath: string }).parentPath, e.name);
  }
  return null;
}

async function finishedTranscript(root: string, sessionId: string, timeoutMs = 30_000): Promise<Line[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await findTranscript(root, sessionId);
    if (file) {
      const lines = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Line);
      if (lines.some((l) => l.type === "result")) return lines;
    }
    if (Date.now() > deadline) throw new Error(`no finished transcript for ${sessionId}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function toolCalls(lines: Line[]) {
  const results = new Map<string, Block>();
  for (const l of lines) {
    if (l.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
  }
  const calls: { name: string; content: string; isError: boolean }[] = [];
  for (const l of lines) {
    if (l.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id!);
      calls.push({ name: b.name!, content: JSON.stringify(r?.content ?? ""), isError: r?.is_error === true });
    }
  }
  return calls;
}

const BEHAVIOUR = "triage-external-prs";
const TOOL = "mcp__paddock__create_chat";

describe("integration: M9.5 audit fixes", () => {
  let t: TestApp;
  let acme: Project;
  let widget: Project;
  const rootFile = () => path.join(t.projectsRoot, "project.yaml");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const keeper = (slug: string) =>
    t.herdctl.manager.getAgents().find((a) => a.name === keeperAgentName(slug)) as unknown as { denied_tools?: string[] };
  const runNow = (slug: string, name: string) => inject("POST", `/api/projects/${slug}/triggers/${name}/run`);

  async function writeHome(doc: Record<string, unknown>): Promise<void> {
    await fs.writeFile(rootFile(), YAML.stringify(doc), "utf8");
  }
  const HOME = {
    name: "Home",
    started: "2026-07-28",
    summary: "the home workspace",
    behaviours: {
      [BEHAVIOUR]: { description: "Triage external PRs.", triggers: ["triage-prs"], tools: [TOOL] },
    },
  };

  async function runPrompt(slug: string, name: string, prompt: string): Promise<Line[]> {
    await t.triggers.set(slug, name, { trigger: { type: "schedule", cron: "0 0 1 1 *" }, run: { prompt }, enabled: false });
    const res = await runNow(slug, name);
    expect(res.statusCode).toBe(202);
    return finishedTranscript(t.cfg.dataDir, (res.json() as { sessionId: string }).sessionId);
  }

  beforeAll(async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "m95-inv-"));
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      gitRepo: true,
      env: {
        MANAGERS_FAKE_INVOCATION_LOG: path.join(logDir, "invocations.jsonl"),
        // The audit's opt-in posture for #3: agents get the trigger tools.
        MANAGERS_SELF_MCP_WRITE: "1",
        MANAGERS_HOOKS_MCP: "1",
      },
    });
    await writeHome(HOME);
    acme = ((await inject("POST", "/api/projects", { name: "Acme Site" })).json() as { project: Project }).project;
    widget = ((await inject("POST", "/api/projects", { name: "Widget Lib" })).json() as { project: Project }).project;
    // Gated by Home's `triggers:` list (name) …
    await t.triggers.set(acme.slug, "triage-prs", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "Triage." },
      enabled: true,
    });
    // … and by its own binding (the audit's `drafter`).
    await t.triggers.set(widget.slug, "drafter", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "Draft release notes.", behaviour: BEHAVIOUR },
      enabled: true,
    });
    // A read primes the last-known-good definitions, as boot does.
    await inject("GET", `/api/projects/${acme.slug}/managers/behaviours`);
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("#1: 2×60 concurrent Home saves keep behaviours: and started; the gated trigger stays 409 throughout", async () => {
    // A big file widens the window a non-atomic write leaves a reader (the torn read
    // that normalised Home to blank defaults); distinct trigger PUTs expose lost updates.
    const big = "x".repeat(400_000);
    const saves = Array.from({ length: 60 }, (_, i) => [
      inject("PATCH", "/api/root", { summary: `home ${i} ${big}` }),
      inject("PATCH", `/api/projects/${acme.slug}`, { summary: `acme ${i}` }),
      ...(i < 20
        ? [
            inject("PUT", `/api/root/triggers/home-t${i}`, {
              trigger: { type: "schedule", cron: "0 4 1 1 *" },
              run: { prompt: `h${i}` },
              enabled: false,
            }),
          ]
        : []),
    ]).flat();
    const fires = Array.from({ length: 40 }, () => runNow(acme.slug, "triage-prs"));
    const [saved, fired] = await Promise.all([Promise.all(saves), Promise.all(fires)]);
    expect(saved.map((r) => r.statusCode).filter((c) => c !== 200)).toEqual([]);
    expect(new Set(fired.map((r) => r.statusCode))).toEqual(new Set([409]));
    const doc = YAML.parse(await fs.readFile(rootFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(doc.behaviours as object)).toEqual([BEHAVIOUR]);
    expect(doc.started).toBe("2026-07-28");
    for (let i = 0; i < 20; i++) expect((doc.triggers as Record<string, unknown>)?.[`home-t${i}`], `home-t${i}`).toBeTruthy();
    // No temp file left behind by the atomic writes.
    expect((await fs.readdir(t.projectsRoot)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);

  it("#1: concurrent writers of ONE project (PATCH, trigger PUT, behaviour switch) lose nothing", async () => {
    const ops = [
      ...Array.from({ length: 20 }, (_, i) => inject("PATCH", `/api/projects/${widget.slug}`, { summary: `w ${i}` })),
      ...Array.from({ length: 20 }, (_, i) =>
        inject("PUT", `/api/projects/${widget.slug}/triggers/t${i}`, {
          trigger: { type: "schedule", cron: "0 4 1 1 *" },
          run: { prompt: `t${i}` },
          enabled: false,
        }),
      ),
      inject("PATCH", `/api/projects/${widget.slug}/managers/behaviours/consolidate-memory`, { enabled: true }),
    ];
    const res = await Promise.all(ops);
    expect(res.map((r) => r.statusCode).filter((c) => c !== 200)).toEqual([]);
    const p = (await inject("GET", `/api/projects/${widget.slug}`)).json() as { project: Project };
    for (let i = 0; i < 20; i++) expect(p.project.triggers?.[`t${i}`], `t${i}`).toBeTruthy();
    expect(p.project.triggers?.drafter?.run.behaviour).toBe(BEHAVIOUR);
    expect(p.project.behaviours?.["consolidate-memory"]?.enabled).toBe(true);
  }, 60_000);

  it("#4: 8 concurrent identical switches give ONE change and ONE #autonomy episode", async () => {
    const url = `/api/projects/${widget.slug}/managers/behaviours/consolidate-memory`;
    const res = await Promise.all(Array.from({ length: 8 }, () => inject("PATCH", url, { enabled: false })));
    expect(res.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(res.filter((r) => (r.json() as { changed: boolean }).changed)).toHaveLength(1);
    const log = await fs.readFile(path.join(widget.dir, "log", `${new Date().toISOString().slice(0, 7)}.md`), "utf8");
    expect(log.match(/turned behaviour consolidate-memory OFF/g)).toHaveLength(1);
  }, 60_000);

  it("#6: a switch's commit holds only the switch; pending trigger edits are committed apart, as the bot", async () => {
    // A Triggers-tab edit leaves project.yaml dirty (REST trigger edits are not committed).
    await inject("PUT", `/api/projects/${widget.slug}/triggers/pending-edit`, {
      trigger: { type: "schedule", cron: "0 5 1 1 *" },
      run: { prompt: "pending" },
      enabled: false,
    });
    const res = await inject("PATCH", `/api/projects/${widget.slug}/managers/behaviours/consolidate-memory`, { enabled: true });
    expect((res.json() as { changed: boolean }).changed).toBe(true);
    const yamlPath = `${widget.slug}/project.yaml`;
    const [switchCommit, snapshot] = git("log", "-2", "--format=%H", "--", yamlPath).split("\n");
    const switchDiff = git("show", "--format=", switchCommit!, "--", yamlPath);
    expect(switchDiff).not.toContain("pending-edit");
    expect(switchDiff).toMatch(/enabled: true/);
    expect(git("show", "-s", "--format=%an%n%s", snapshot!)).toMatch(/^managers-bot\nmanagers: record .*project\.yaml edits/);
    expect(git("show", "--format=", snapshot!, "--", yamlPath)).toContain("pending-edit");
    // Put it back off for the rest of the file.
    await inject("PATCH", `/api/projects/${widget.slug}/managers/behaviours/consolidate-memory`, { enabled: false });
  }, 60_000);

  it("#3: remove_trigger + set_trigger + run_trigger (the audit's sequence) cannot ungate drafter", async () => {
    const before = await runNow(widget.slug, "drafter");
    expect(before.statusCode).toBe(409);
    const calls = toolCalls(
      await runPrompt(
        acme.slug,
        "bypass",
        `[[MCP managers.remove_trigger {"project":"${widget.slug}","name":"drafter"}]] ` +
          `[[MCP managers.set_trigger {"project":"${widget.slug}","name":"drafter","type":"schedule","cron":"0 3 1 1 *","prompt":"x","enabled":true}]] ` +
          `[[MCP managers.run_trigger {"project":"${widget.slug}","name":"drafter"}]] ` +
          // Home's name-gated trigger in another project, and a brand-new name are the controls.
          `[[MCP managers.set_trigger {"project":"${acme.slug}","name":"triage-prs","type":"schedule","cron":"0 3 1 1 *","prompt":"x","enabled":true}]] ` +
          `[[MCP managers.set_trigger {"project":"${acme.slug}","name":"fresh-one","type":"schedule","cron":"0 3 1 1 *","prompt":"x","enabled":false}]]`,
      ),
    );
    expect(calls.map((c) => c.name)).toEqual([
      "mcp__managers__remove_trigger",
      "mcp__managers__set_trigger",
      "mcp__managers__run_trigger",
      "mcp__managers__set_trigger",
      "mcp__managers__set_trigger",
    ]);
    const [rm, set, run, setHome, fresh] = calls;
    expect(rm).toMatchObject({ isError: true });
    expect(rm!.content).toMatch(/remove_trigger refused: trigger \\"drafter\\" is gated by \\"triage-external-prs\\"/);
    expect(set).toMatchObject({ isError: true });
    expect(set!.content).toMatch(/set_trigger refused/);
    expect(run).toMatchObject({ isError: true });
    expect(run!.content).toMatch(/gated by the behaviour/);
    expect(setHome).toMatchObject({ isError: true });
    expect(setHome!.content).toMatch(/set_trigger refused: trigger \\"triage-prs\\" is gated/);
    expect(fresh, fresh!.content).toMatchObject({ isError: false });
    // drafter is untouched and still gated.
    const w = (await inject("GET", `/api/projects/${widget.slug}`)).json() as { project: Project };
    expect(w.project.triggers?.drafter?.run.behaviour).toBe(BEHAVIOUR);
    expect(w.project.triggers?.drafter?.run.prompt).toBe("Draft release notes.");
    expect((await runNow(widget.slug, "drafter")).statusCode).toBe(409);
    const runs = (await inject("GET", `/api/projects/${widget.slug}/managers/runs?trigger=drafter`)).json() as { runs: unknown[] };
    expect(runs.runs).toEqual([]);
  }, 60_000);

  it("#3: a name that was gated stays closed to agents after Ed deletes the trigger in the UI", async () => {
    await t.triggers.set(widget.slug, "was-gated", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "x", behaviour: BEHAVIOUR },
      enabled: false,
    });
    // Ed's delete through REST (the human path is allowed, and records the tombstone).
    expect((await inject("DELETE", `/api/projects/${widget.slug}/triggers/was-gated`)).statusCode).toBe(200);
    const [recreate] = toolCalls(
      await runPrompt(
        widget.slug,
        "recreate",
        `[[MCP managers.set_trigger {"project":"${widget.slug}","name":"was-gated","type":"schedule","cron":"0 3 1 1 *","prompt":"x","enabled":true}]]`,
      ),
    );
    expect(recreate).toMatchObject({ isError: true });
    expect(recreate!.content).toMatch(/was gated by a behaviour before/);
  }, 60_000);

  it("#2: a malformed Home project.yaml fails CLOSED and is never rewritten", async () => {
    const broken = 'name: "Home\nbehaviours: [oops\n';
    await fs.writeFile(rootFile(), broken, "utf8");
    // The gate holds for both kinds of binding.
    expect((await runNow(acme.slug, "triage-prs")).statusCode).toBe(409);
    expect((await runNow(widget.slug, "drafter")).statusCode).toBe(409);
    // The project still lists Home's definition (last-known-good), forced OFF, plus the marker.
    const list = ((await inject("GET", `/api/projects/${acme.slug}/managers/behaviours`)).json() as {
      behaviours: { name: string; enabled: boolean; tools: string[] }[];
    }).behaviours;
    expect(list.find((b) => b.name === BEHAVIOUR)).toMatchObject({ enabled: false, tools: [TOOL] });
    expect(list.find((b) => b.name === "config-unreadable")).toMatchObject({ enabled: false });
    // A project save re-registers the keeper: the tool stays denied.
    expect((await inject("PATCH", `/api/projects/${acme.slug}`, { summary: "after break" })).statusCode).toBe(200);
    expect(keeper(acme.slug).denied_tools).toContain(TOOL);
    // An ERROR alert, not an info one.
    const alertsRes = (await inject("GET", `/api/projects/${acme.slug}/managers/alerts`)).json();
    const alerts = (Array.isArray(alertsRes) ? alertsRes : (alertsRes as { alerts: unknown[] }).alerts) as {
      kind: string;
      severity: string;
    }[];
    expect(alerts, JSON.stringify(alertsRes)).toBeTruthy();
    expect(alerts.find((a) => a.kind === "config-unreadable")).toMatchObject({ severity: "error" });
    // Nothing rewrites the broken file with defaults.
    const save = await inject("PATCH", "/api/root", { summary: "flatten me" });
    expect(save.statusCode).toBe(400);
    expect((save.json() as { error: string }).error).toMatch(/Refusing to rewrite Home's project\.yaml/);
    expect(
      (await inject("PATCH", `/api/projects/${acme.slug}/managers/behaviours/${BEHAVIOUR}`, { enabled: true })).statusCode,
    ).toBe(409);
    expect(await fs.readFile(rootFile(), "utf8")).toBe(broken);
    // Fixing the file restores normal service.
    await writeHome(HOME);
    const fixed = ((await inject("GET", `/api/projects/${acme.slug}/managers/behaviours`)).json() as {
      behaviours: { name: string }[];
    }).behaviours;
    expect(fixed.map((b) => b.name)).not.toContain("config-unreadable");
  }, 60_000);
});

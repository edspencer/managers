/**
 * Managers M7: the wake briefing on the real fire path.
 *
 * Boots the REAL app (projects root a git repo) and fires schedule triggers with
 * "Run now". On the default (batch) path the fake `claude` records the exact
 * prompt it got as the transcript's first user message. The SESSION drive path
 * runs on the SDK runtime, which the fake `claude` cannot stand in for, so that
 * case stubs herdctl's `openChatSession` and asserts on the prompt (and system
 * prompt append) the server built for it — credential-free, no model involved.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";
import { PRELOAD_CONTEXT_OPEN, PRELOAD_REQUEST_MARKER } from "../../src/preload.js";

type Run = {
  id: string;
  trigger: string;
  status: string;
  objective: string | null;
  sessionId: string | null;
  briefing: { path: string; sha256: string } | null;
  file: string;
};

describe("integration: the wake briefing (M7)", () => {
  let t: TestApp;
  let acme: Project;
  let empty: Project;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.projectsRoot, encoding: "utf8" }).trim();

  const api = (slug: string) => `/api/projects/${slug}/managers`;
  const get = async <T>(url: string, status = 200): Promise<T> => {
    const res = await t.app.inject({ method: "GET", url });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(status);
    return res.json() as T;
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

  /** Create a trigger, Run-now it, wait for its run record to finish. */
  async function fire(slug: string, name: string, run: Record<string, unknown>): Promise<{ run: Run; sessionId: string }> {
    await t.triggers.set(slug, name, { trigger: { type: "schedule", cron: "0 0 1 1 *" }, run, enabled: false });
    const before = new Set((await get<{ runs: Run[] }>(`${api(slug)}/runs?trigger=${name}`)).runs.map((r) => r.id));
    const res = await t.app.inject({ method: "POST", url: `/api/projects/${slug}/triggers/${name}/run` });
    expect(res.statusCode).toBe(202);
    const done = await waitFor(async () => {
      const { runs } = await get<{ runs: Run[] }>(`${api(slug)}/runs?trigger=${name}`);
      return runs.find((r) => !before.has(r.id) && r.status !== "running") ?? null;
    });
    return { run: done, sessionId: done.sessionId! };
  }

  async function firstUserMessage(slug: string, sessionId: string): Promise<string> {
    const messages = (
      await get<{ messages: { role: string; content: string }[] }>(`/api/projects/${slug}/chats/${sessionId}/messages`)
    ).messages;
    return messages.find((m) => m.role === "user")!.content;
  }

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000, gitRepo: true });
    const create = async (name: string) =>
      ((await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } })).json() as { project: Project })
        .project;
    acme = await create("Acme Site");
    empty = await create("Empty Project");
    // Some state for the briefing to carry.
    const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: "POST", url, payload });
    expect((await post(`${api(acme.slug)}/objectives`, { id: "grow", title: "Grow awareness", success: "Known" })).statusCode).toBe(201);
    expect(
      (await post(`${api(acme.slug)}/objectives`, { id: "burn-down", title: "Burn down issues", success: "Under 10", triggers: ["wake"] }))
        .statusCode,
    ).toBe(201);
    await post(`${api(acme.slug)}/tasks`, { title: "Write the post", status: "open" });
    await post(`${api(acme.slug)}/tasks`, { title: "Merge #88?", status: "awaiting-ed", ask: "Merge renovate #88?" });
    await t.projects.writeOverview(acme.slug, "# Acme\nOVERVIEW: the secret is velvet.");
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("a fired schedule trigger's first user message is the briefing, and its name is the trigger body", async () => {
    const { run, sessionId } = await fire(acme.slug, "wake", { prompt: "Wake. Look around." });
    const first = await firstUserMessage(acme.slug, sessionId);
    expect(first.startsWith(`${PRELOAD_CONTEXT_OPEN}\n## Briefing\n`)).toBe(true);
    for (const h of ["## Protocol", "## Shared memory", "## Open tasks", "## Alerts", "## OVERVIEW.md"]) {
      expect(first).toContain(h);
    }
    expect(first).toContain(`- Run: ${run.id}`);
    expect(first).toContain("- Why: Run now (a manual fire)");
    expect(first).toContain("velvet");
    expect(first.endsWith(`${PRELOAD_REQUEST_MARKER}Wake. Look around.`)).toBe(true);
    // Awaiting-ed first.
    const open = first.slice(first.indexOf("## Open tasks"), first.indexOf("## Answered"));
    expect(open.indexOf("[awaiting-ed]")).toBeLessThan(open.indexOf("[open]"));

    // Sidebar name: the trigger body, not the briefing.
    const chat = await waitFor(async () => {
      const { chats } = await get<{ chats: { sessionId: string; name: string }[] }>(`/api/projects/${acme.slug}/chats`);
      return chats.find((c) => c.sessionId === sessionId) ?? null;
    });
    expect(chat.name).toBe("Wake. Look around.");

    // The run is bound to burn-down (its `triggers:` lists wake), and the briefing says so.
    expect(run.objective).toBe("burn-down");
    expect(first).toContain("## Objective: Burn down issues (burn-down)");
  });

  it("keeps what the manager saw: .managers/briefings/<run>.md, gitignored, hashed on the run, served as briefingText", async () => {
    const { run, sessionId } = await fire(acme.slug, "wake-2", { prompt: "Second wake." });
    expect(run.briefing).toEqual({ path: `.managers/briefings/${run.id}.md`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const abs = path.join(acme.dir, run.briefing!.path);
    const text = await fs.readFile(abs, "utf8");
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(run.briefing!.sha256);
    // Exactly what the manager was sent.
    const first = await firstUserMessage(acme.slug, sessionId);
    expect(first).toBe(`${PRELOAD_CONTEXT_OPEN}\n${text.trim()}\n${PRELOAD_REQUEST_MARKER}Second wake.`);
    // Gitignored, and never committed.
    expect(git("check-ignore", path.relative(t.projectsRoot, abs))).toBe(path.relative(t.projectsRoot, abs));
    expect(git("ls-files", "--", `${acme.slug}/.managers/briefings`)).toBe("");
    const detail = await get<{ briefingText: string | null }>(`${api(acme.slug)}/runs/${run.id}`);
    expect(detail.briefingText).toBe(text);
  });

  it("run.briefing: false sends the bare prompt; run.briefing.objective beats the triggers: binding", async () => {
    const off = await fire(acme.slug, "no-brief", { prompt: "Bare prompt.", briefing: false });
    expect(await firstUserMessage(acme.slug, off.sessionId)).toBe("Bare prompt.");
    expect(off.run.briefing).toBeNull();

    // `wake-obj` is not in any objective's triggers:, so only run.briefing binds it.
    const on = await fire(acme.slug, "wake-obj", { prompt: "Focus.", briefing: { objective: "grow" } });
    expect(on.run.objective).toBe("grow");
    expect(await firstUserMessage(acme.slug, on.sessionId)).toContain("## Objective: Grow awareness (grow)");
  });

  it("get_briefing is a state-read tool on every trigger turn", async () => {
    const { sessionId } = await fire(acme.slug, "ask-brief", {
      prompt: '[[MCP managers.get_briefing {"objective":"grow"}]]',
      briefing: false,
    });
    const file = await waitFor(async () => {
      const entries = await fs.readdir(t.cfg.dataDir, { recursive: true, withFileTypes: true });
      const hit = entries.find((e) => e.name === `${sessionId}.jsonl`);
      return hit ? path.join((hit as unknown as { parentPath: string }).parentPath, hit.name) : null;
    });
    const raw = await waitFor(async () => {
      const s = await fs.readFile(file, "utf8");
      return s.includes('"type":"result"') ? s : null;
    });
    expect(raw).toContain("mcp__managers__get_briefing");
    expect(raw).toMatch(/Objective: Grow awareness \(grow\)/);
    expect(raw).toContain("sections");
  });

  it("GET …/managers/briefing previews the same section order; bad input is a 400/404", async () => {
    const b = await get<{ text: string; sections: { name: string; chars: number }[]; objective: string | null }>(
      `${api(acme.slug)}/briefing`,
    );
    expect(b.sections.map((s) => s.name)).toEqual([
      "Header",
      "Protocol",
      "Behaviours",
      "Connections",
      "Shared memory",
      "Project memory",
      "Objective",
      "Open tasks",
      "Answered since last wake",
      "Recent runs",
      "Alerts",
      "Recent project log",
      "OVERVIEW.md",
    ]);
    expect(b.text).toContain("- Run: none");
    expect((await get<{ objective: string }>(`${api(acme.slug)}/briefing?trigger=wake`)).objective).toBe("burn-down");
    expect((await get<{ objective: string }>(`${api(acme.slug)}/briefing?objective=grow`)).objective).toBe("grow");
    await get(`${api(acme.slug)}/briefing?objective=Not%20Kebab`, 400);
    // M10: `kind=report` is a preview of the report briefing; an unknown kind is still a 400.
    await get(`${api(acme.slug)}/briefing?kind=digest`, 400);
    await get(`${api(acme.slug)}/briefing?kind=report&report=Not%20Kebab`, 400);
    const rep = await get<{ sections: { name: string }[] }>(`${api(acme.slug)}/briefing?kind=report`);
    expect(rep.sections.map((x) => x.name)).toContain("Previous report");
    await get(`${api(acme.slug)}/briefing?trigger=nope`, 404);
    await get(`${api("no-such-project")}/briefing`, 404);
    // Home, on the root mount.
    const home = await get<{ text: string }>(`/api/root/managers/briefing`);
    expect(home.text).toContain("- Project: Home (the root workspace)");
  });

  // M15 (real-Claude shakedown): an answer's wake said "Run now (a manual fire)".
  it("answer … wake:true fires wake with a Why naming the answered task", async () => {
    await t.triggers.set(empty.slug, "wake", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "Wake." },
      enabled: true,
    });
    const task = (
      (await t.app.inject({
        method: "POST",
        url: `${api(empty.slug)}/tasks`,
        payload: { title: "Pick one", status: "awaiting-ed", ask: "A or B?", options: ["A", "B"] },
      })).json() as { task: { id: string } }
    ).task;
    const res = await t.app.inject({
      method: "POST",
      url: `${api(empty.slug)}/tasks/${task.id}/answer`,
      payload: { choice: "A", wake: true },
    });
    const wake = (res.json() as { wake: { fired: boolean; sessionId?: string } }).wake;
    expect(wake.fired).toBe(true);
    const done = await waitFor(async () => {
      const { runs } = await get<{ runs: Run[] }>(`${api(empty.slug)}/runs?trigger=wake`);
      return runs.find((r) => r.status !== "running") ?? null;
    });
    const first = await firstUserMessage(empty.slug, done.sessionId!);
    expect(first).toContain(`- Why: Ed answered ${task.id} and asked you to wake now`);
    await t.triggers.set(empty.slug, "wake", { trigger: { type: "schedule", cron: "0 0 1 1 *" }, run: { prompt: "Wake." }, enabled: false });
    await t.app.inject({ method: "PATCH", url: `${api(empty.slug)}/tasks/${task.id}`, payload: { status: "done" } });
  });

  it("empty state: an empty project's briefing says (no objectives) and (no open tasks)", async () => {
    const b = await get<{ text: string }>(`${api(empty.slug)}/briefing`);
    expect(b.text).toContain("(no objectives)");
    expect(b.text).toContain("(no open tasks)");
    expect(b.text).toContain("(no alerts)");
  });

  it("run.briefing survives a Triggers-tab PUT and an unrelated project PATCH (the §4 round-trip)", async () => {
    await t.triggers.set(acme.slug, "keep-brief", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "x", briefing: { objective: "grow" }, expect: { kind: "episode" } },
      enabled: false,
    });
    const url = `/api/projects/${acme.slug}/triggers/keep-brief`;
    const cur = ((await t.app.inject({ method: "GET", url })).json() as { trigger: { trigger: unknown; run: Record<string, unknown> } })
      .trigger;
    expect(cur.run.briefing).toEqual({ objective: "grow" });
    // The Triggers tab edits by full-replace PUT, carrying run keys it doesn't show.
    const put = await t.app.inject({ method: "PUT", url, payload: { trigger: cur.trigger, run: { ...cur.run, prompt: "edited" }, enabled: true } });
    expect(put.statusCode).toBe(200);
    const patch = await t.app.inject({ method: "PATCH", url: `/api/projects/${acme.slug}`, payload: { maxTurns: 40 } });
    expect(patch.statusCode).toBeLessThan(300);
    const yaml = YAML.parse(await fs.readFile(path.join(acme.dir, "project.yaml"), "utf8")) as {
      triggers: Record<string, { run: Record<string, unknown> }>;
    };
    expect(yaml.triggers["keep-brief"]!.run).toMatchObject({ prompt: "edited", briefing: { objective: "grow" } });

    // `briefing: false` round-trips too, and a malformed one is refused.
    const off = await t.app.inject({ method: "PUT", url, payload: { trigger: cur.trigger, run: { prompt: "y", briefing: false }, enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(((await t.app.inject({ method: "GET", url })).json() as { trigger: { run: { briefing: unknown } } }).trigger.run.briefing).toBe(false);
    const bad = await t.app.inject({ method: "PUT", url, payload: { trigger: cur.trigger, run: { prompt: "y", briefing: { objective: "Not Kebab" } }, enabled: false } });
    expect(bad.statusCode).toBe(400);
  });

  it("SESSION drive mode: the SDK-bound prompt is the briefing, and the system append points at its protocol", async () => {
    const sess = ((await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Session Proj" } })).json() as {
      project: Project;
    }).project;
    const patched = await t.app.inject({ method: "PATCH", url: `/api/projects/${sess.slug}`, payload: { driveMode: "session" } });
    expect(patched.statusCode).toBeLessThan(300);

    // Stand in for the SDK runtime: capture what the server hands openChatSession
    // and play back a minimal successful turn. No `claude`, no credentials.
    const captured: { agent: string; prompt: string; systemPromptAppend?: string }[] = [];
    const manager = t.herdctl.manager as unknown as { openChatSession: (...a: unknown[]) => Promise<unknown> };
    const spy = vi.spyOn(manager, "openChatSession").mockImplementation(async (...args: unknown[]) => {
      const [agent, opts] = args as [string, { prompt: string; systemPromptAppend?: string }];
      captured.push({ agent, prompt: opts.prompt, systemPromptAppend: opts.systemPromptAppend });
      const sid = "5e55a10e-0000-4000-8000-000000000007";
      return {
        messages: (async function* () {
          yield { type: "system", subtype: "init", session_id: sid };
          yield { type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
          yield { type: "result", subtype: "success", is_error: false, session_id: sid, result: "ok" };
        })(),
        send: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        listCommands: vi.fn(async () => []),
        setModel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
    });
    try {
      const { run } = await fire(sess.slug, "wake", { prompt: "Session wake." });
      expect(spy).toHaveBeenCalled();
      const call = captured.find((c) => c.agent === `keeper-${sess.slug}`)!;
      expect(call).toBeTruthy();
      expect(call.prompt.startsWith(`${PRELOAD_CONTEXT_OPEN}\n## Briefing\n`)).toBe(true);
      expect(call.prompt).toContain("## Open tasks");
      expect(call.prompt).toContain(`- Run: ${run.id}`);
      expect(call.prompt.endsWith(`${PRELOAD_REQUEST_MARKER}Session wake.`)).toBe(true);
      // The environment prompt rides on the SDK runtime only, and points at the protocol.
      expect(call.systemPromptAppend).toContain("follow the briefing's protocol");
      // Same record-keeping as batch.
      expect(run.status).toBe("succeeded");
      const saved = await fs.readFile(path.join(sess.dir, run.briefing!.path), "utf8");
      expect(call.prompt).toContain(saved.trim());
    } finally {
      spy.mockRestore();
    }
  });
});

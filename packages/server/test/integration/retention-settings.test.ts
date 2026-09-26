/**
 * Managers M3: transcripts never expire, and there is no hidden auto-memory
 * store — on EVERY runtime path.
 *
 * Retention rests on two facts together: Managers' Claude home carries a
 * generated `settings.json` with the overlay, and every agent loads the `user`
 * setting source that file is. Each is asserted against the real app:
 *
 * - boot → `<dataDir>/claude-home/settings.json` holds the overlay;
 * - batch (CLI runtime): the fake `claude`'s recorded argv carries
 *   `--setting-sources user,project` for the keeper, a trigger and the sweeper;
 * - session drive mode (SDK runtime): the REAL `FleetManager.openChatSession`
 *   hands `SDKRuntime.openSession` an agent whose options — built by herdctl's
 *   own `buildSdkOptions`, the exact code `openSession` runs — carry
 *   `settingSources: ["user","project"]` and the Managers Claude home. The SDK
 *   subprocess itself needs a real login, so `openSession` is intercepted at the
 *   prototype and nothing is spawned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SDKRuntime } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { keeperAgentName, sweeperAgentName } from "../../src/herdctl-agent-names.js";
import type { Project } from "../../src/projects.js";

type Invocation = { prompt: string; settingSources: string | null };

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug;

async function invocations(logPath: string): Promise<Invocation[]> {
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Invocation);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("integration: transcript retention + no auto-memory (Managers M3)", () => {
  let t: TestApp;
  let ws: WsClient;
  let logPath: string;
  let project: Project;

  beforeAll(async () => {
    const tmpLog = path.join(
      (await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "m3-inv-"))),
      "invocations.jsonl",
    );
    logPath = tmpLog;
    // sweepIntervalMs: 0 → the post-turn sweep runs right after the turn, so the
    // sweeper's own `claude -p` lands in the log too.
    t = await startTestApp({
      sweepIntervalMs: 0,
      env: { MANAGERS_FAKE_INVOCATION_LOG: logPath },
    });
    project = (
      (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Keep Proj" } })).json() as {
        project: Project;
      }
    ).project;
    const { port } = await listen(t.app);
    ws = await connectWs(port);
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
    await fs.rm(path.dirname(logPath), { recursive: true, force: true });
  });

  it("writes the overlay into <dataDir>/claude-home/settings.json at boot", async () => {
    const file = path.join(t.cfg.dataDir, "claude-home", "settings.json");
    expect(t.cfg.claudeHome).toBe(path.dirname(file));
    const lst = await fs.lstat(file);
    expect(lst.isSymbolicLink()).toBe(false);
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    expect(settings.cleanupPeriodDays).toBe(36500);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.autoDreamEnabled).toBe(false);
  });

  it("batch: the keeper AND the sweeper are spawned with --setting-sources user,project", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: project.slug, sessionId: null, message: "retention probe turn" },
    });
    await ws.waitFor(isComplete(project.slug), { from: mark });

    const keeper = await waitFor(async () =>
      (await invocations(logPath)).find((i) => i.prompt.includes("retention probe turn")),
    );
    expect(keeper.settingSources).toBe("user,project");

    // The sweeper is identified by its marker-shaped prompt.
    const sweeper = await waitFor(async () =>
      (await invocations(logPath)).find((i) => i.prompt.includes("<<<OVERVIEW>>>")),
    );
    expect(sweeper.settingSources).toBe("user,project");
    // …and M3 dropped the CLAUDE section from the prompt it was handed.
    expect(sweeper.prompt).not.toContain("<<<CLAUDE>>>");
  });

  it("batch: a trigger run is spawned with --setting-sources user,project", async () => {
    await t.triggers.set(project.slug, "keep-probe", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "trigger retention probe" },
      enabled: false,
    });
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${project.slug}/triggers/keep-probe/run`,
    });
    expect(res.statusCode).toBe(202);
    const inv = await waitFor(async () =>
      (await invocations(logPath)).find((i) => i.prompt.includes("trigger retention probe")),
    );
    expect(inv.settingSources).toBe("user,project");
  });

  it("session drive mode: openChatSession builds SDK options with settingSources user,project", async () => {
    // Reach the real FleetManager the app booted (private field; this is a test).
    const fleet = (t.herdctl as unknown as { fleet: import("@herdctl/core").FleetManager }).fleet;
    expect(fleet).toBeTruthy();

    const proto = SDKRuntime.prototype as unknown as {
      openSession: (o: unknown) => unknown;
      buildSdkOptions: (o: unknown) => Record<string, unknown>;
    };
    const original = proto.openSession;
    const seen: Array<{ options: Record<string, unknown>; sdk: Record<string, unknown> }> = [];
    proto.openSession = function (this: unknown, options: unknown) {
      // Run herdctl's OWN option builder — the first thing the real openSession does.
      seen.push({
        options: options as Record<string, unknown>,
        sdk: proto.buildSdkOptions.call(this, options),
      });
      return {
        close: async () => undefined,
        [Symbol.asyncIterator]: async function* () {},
      };
    };
    try {
      for (const name of [keeperAgentName(project.slug), keeperAgentName("")]) {
        await fleet.openChatSession(name, { resume: null, prompt: "" });
      }
    } finally {
      proto.openSession = original;
    }

    expect(seen).toHaveLength(2);
    for (const { options, sdk } of seen) {
      const agent = options.agent as { setting_sources?: string[] };
      expect(agent.setting_sources).toEqual(["user", "project"]);
      expect(sdk.settingSources).toEqual(["user", "project"]);
      // …against Managers' own Claude home, where the overlay file lives.
      expect((sdk.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(t.cfg.claudeHome);
    }
  });

  it("every registered agent (keeper, sweeper, trigger) declares the setting sources", async () => {
    const fleet = (t.herdctl as unknown as { fleet: import("@herdctl/core").FleetManager }).fleet;
    const agents = fleet.getAgents();
    const names = [keeperAgentName(project.slug), sweeperAgentName(project.slug)];
    for (const n of names) {
      const a = agents.find((x) => x.qualifiedName === n);
      expect(a, n).toBeTruthy();
      expect(a!.setting_sources, n).toEqual(["user", "project"]);
    }
    const trig = agents.find((x) => x.qualifiedName.startsWith("trigger-"));
    if (trig) expect(trig.setting_sources).toEqual(["user", "project"]);
  });

  it("the sweep leaves CLAUDE.md untouched and still writes OVERVIEW.md", async () => {
    const overview = await waitFor(async () => {
      const r = await t.app.inject({ method: "GET", url: `/api/projects/${project.slug}/overview` });
      return r.body.includes("# Project Overview") ? r.body : undefined;
    });
    expect(overview).toContain("# Project Overview");
    const claude = await fs.readFile(path.join(project.dir, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("A durable convention discovered from recent activity.");
  });

  it("the own → host transcript migration is refused, and never offered", async () => {
    const probe = await t.app.inject({ method: "GET", url: "/api/transcripts/migration" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ eligible: false, reason: "not-supported" });

    const run = await t.app.inject({
      method: "POST",
      url: "/api/transcripts/migration",
      payload: { sessionIds: [] },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().code).toBe("not_supported");
  });
});

describe("integration: claude.transcripts: host is a boot error (Managers M3)", () => {
  it("refuses to build the app, from the config file", async () => {
    await expect(
      startTestApp({ configFile: { claude: { transcripts: "host" } } }),
    ).rejects.toThrow(/claude\.transcripts: host` is not supported by Managers/);
  });

  it("refuses to build the app, from MANAGERS_CLAUDE_TRANSCRIPTS — and leaves no env behind", async () => {
    await expect(
      startTestApp({ env: { MANAGERS_CLAUDE_TRANSCRIPTS: "host" } }),
    ).rejects.toThrow(/MANAGERS_CLAUDE_TRANSCRIPTS/);
    expect(process.env.MANAGERS_CLAUDE_TRANSCRIPTS).toBeUndefined();
  });
});

/**
 * Managers M14.5: regression tests for the M9–M14 audit's blocker and majors, and
 * the integration-level minors, on the real app.
 *
 *   #1 boot refuses auth=none without MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH, and jwt
 *      without an issuer AND an audience (unless MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE);
 *      an opted-in danger is listed by GET /api/security;
 *   #2 boot refuses driveMode batch without MANAGERS_ALLOW_BATCH_DRIVE; a project's
 *      batch override is refused and runs as session; herdctl's per-turn MCP
 *      bridge binds 127.0.0.1, not 0.0.0.0;
 *   #3 a project whose project.yaml will not parse keeps its asks on Home's
 *      "Needs you", with configError and a config-unreadable alert;
 *   #12 an agent cannot write another project's triggers;
 *   #13 project create/remove and an agent's set_trigger merge are serialised
 *      under the project.yaml lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import type { Project } from "../../src/projects.js";

const FAKE_BIN = fileURLToPath(new URL("../../../../test/bin", import.meta.url));

/** Build the app with exactly `env` on top of an isolated base; restore everything after. */
async function bootWith(env: Record<string, string | undefined>): Promise<{ error: Error | null; security?: unknown }> {
  const tmp = await makeTmpDir("m145-boot-");
  const base: Record<string, string | undefined> = {
    HOME: path.join(tmp, "home"),
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    MANAGERS_DATA_DIR: path.join(tmp, "data"),
    MANAGERS_PROJECTS_DIR: path.join(tmp, "data", "projects"),
    MANAGERS_WEB_DIST: path.join(tmp, "no-dist"),
    MANAGERS_DATA_GIT_INIT: "0",
    CLAUDE_CONFIG_DIR: undefined,
    MANAGERS_AUTH_MODE: undefined,
    MANAGERS_AUTH_JWKS_URL: undefined,
    MANAGERS_AUTH_JWT_ISSUER: undefined,
    MANAGERS_AUTH_JWT_AUDIENCE: undefined,
    MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE: undefined,
    MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH: undefined,
    MANAGERS_ALLOW_BATCH_DRIVE: undefined,
    MANAGERS_DRIVE_MODE: undefined,
    ...env,
  };
  const saved = Object.fromEntries(Object.keys(base).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.mkdir(base.HOME!, { recursive: true });
  await fs.mkdir(base.MANAGERS_PROJECTS_DIR!, { recursive: true });
  try {
    const built = await buildApp({ serveStatic: false });
    try {
      await built.app.ready();
      const res = await built.app.inject({ method: "GET", url: "/api/security" });
      return { error: null, security: res.statusCode === 200 ? res.json() : res.statusCode };
    } finally {
      await built.close().catch(() => undefined);
    }
  } catch (err) {
    return { error: err as Error };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rmTmpDir(tmp);
  }
}

describe("integration: M14.5 boot posture (#1, #2)", () => {
  it("#1: refuses auth=none without MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH", async () => {
    const r = await bootWith({ MANAGERS_AUTH_MODE: "none" });
    expect(r.error?.message).toMatch(/refusing to start: MANAGERS_AUTH_MODE=none/);
    expect(r.error?.message).toMatch(/MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1/);
    // The default mode IS none: an unset mode is refused the same way.
    expect((await bootWith({})).error?.message).toMatch(/MANAGERS_AUTH_MODE=none/);
  }, 60_000);

  it("#1: with the opt-in it boots, and /api/security lists the danger", async () => {
    const r = await bootWith({ MANAGERS_AUTH_MODE: "none", MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH: "1" });
    expect(r.error).toBeNull();
    expect(r.security).toMatchObject({
      authMode: "none",
      driveMode: "session",
      batchDriveAllowed: false,
      warnings: [expect.objectContaining({ code: "no-auth", title: "No authentication: agents on this host can act as you" })],
    });
  }, 60_000);

  it("#1: refuses jwt without an issuer and an audience, unless ALLOW_ANY_AUDIENCE", async () => {
    const jwt = { MANAGERS_AUTH_MODE: "jwt", MANAGERS_AUTH_JWKS_URL: "https://idp.example.test/jwks" };
    expect((await bootWith(jwt)).error?.message).toMatch(
      /jwt without MANAGERS_AUTH_JWT_ISSUER and MANAGERS_AUTH_JWT_AUDIENCE/,
    );
    expect((await bootWith({ ...jwt, MANAGERS_AUTH_JWT_ISSUER: "https://idp.example.test/" })).error?.message).toMatch(
      /jwt without MANAGERS_AUTH_JWT_AUDIENCE\./,
    );
    const pinned = await bootWith({
      ...jwt,
      MANAGERS_AUTH_JWT_ISSUER: "https://idp.example.test/",
      MANAGERS_AUTH_JWT_AUDIENCE: "managers",
    });
    expect(pinned.error).toBeNull();
    // /api/security is behind auth like everything else: no token, 401.
    expect(pinned.security).toBe(401);
    expect((await bootWith({ ...jwt, MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE: "1" })).error).toBeNull();
  }, 60_000);

  it("#2: refuses MANAGERS_DRIVE_MODE=batch without MANAGERS_ALLOW_BATCH_DRIVE", async () => {
    const noAuth = { MANAGERS_AUTH_MODE: "none", MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH: "1" };
    expect((await bootWith({ ...noAuth, MANAGERS_DRIVE_MODE: "batch" })).error?.message).toMatch(
      /refusing to start: MANAGERS_DRIVE_MODE=batch.*MANAGERS_ALLOW_BATCH_DRIVE=1/s,
    );
    const ok = await bootWith({ ...noAuth, MANAGERS_DRIVE_MODE: "batch", MANAGERS_ALLOW_BATCH_DRIVE: "1" });
    expect(ok.error).toBeNull();
    expect((ok.security as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(["no-auth", "batch-drive"]);
  }, 60_000);
});

describe("integration: M14.5 batch drive mode off (#2)", () => {
  let t: TestApp;
  beforeAll(async () => {
    // The instance default is session and batch is NOT allowed (no turn runs here).
    t = await startTestApp({ env: { MANAGERS_DRIVE_MODE: "session", MANAGERS_ALLOW_BATCH_DRIVE: "" } });
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("a project cannot be switched to batch, and a batch override on disk runs as session", async () => {
    const inject = (method: "POST" | "PATCH", url: string, payload: unknown) =>
      t.app.inject({ method, url, payload: payload as Record<string, unknown> });
    const p = ((await inject("POST", "/api/projects", { name: "Batch Probe" })).json() as { project: Project }).project;
    const res = await inject("PATCH", `/api/projects/${p.slug}`, { driveMode: "batch" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "batch_drive_disabled" });
    expect((await inject("PATCH", `/api/projects/${p.slug}`, { driveMode: "session" })).statusCode).toBe(200);
    const sec = (await t.app.inject({ method: "GET", url: "/api/security" })).json() as { batchDriveAllowed: boolean };
    expect(sec.batchDriveAllowed).toBe(false);
    const { resolveProjectDriveMode } = await import("../../src/boot-posture.js");
    expect(resolveProjectDriveMode({ driveMode: "batch" }, t.cfg)).toBe("session");
    expect(resolveProjectDriveMode({ driveMode: "batch" }, { driveMode: "session", allowBatchDrive: true })).toBe("batch");
  });
});

describe("integration: M14.5 on a running app", () => {
  let t: TestApp;
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  beforeAll(async () => {
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      // Agents get the trigger tools, as in the audit's #12.
      env: { MANAGERS_SELF_MCP_WRITE: "1", MANAGERS_HOOKS_MCP: "1" },
    });
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
  });

  it("#2: herdctl's per-turn MCP bridge binds 127.0.0.1 (herdctl itself asks for 0.0.0.0)", async () => {
    const { startMcpHttpBridge } = (await import(
      "@herdctl/core/dist/runner/runtime/mcp-http-bridge.js" as string
    )) as { startMcpHttpBridge: (def: unknown) => Promise<{ server: import("node:http").Server; port: number; close: () => Promise<void> }> };
    const bridge = await startMcpHttpBridge({ name: "probe", tools: [] });
    try {
      const addr = bridge.server.address() as { address: string };
      expect(addr.address).toBe("127.0.0.1");
      // Still reachable on loopback (the CLI child's URL).
      const res = await fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await bridge.close();
    }
  });

  it("#3: a malformed project.yaml keeps the project's asks on Home, with an error row and a config-unreadable alert", async () => {
    const p = ((await inject("POST", "/api/projects", { name: "Widget Lib" })).json() as { project: Project }).project;
    const ask = await inject("POST", `/api/projects/${p.slug}/managers/tasks`, {
      title: "Decide whether to merge renovate bump #88",
      status: "awaiting-ed",
      ask: "Merge it?",
      options: ["merge", "wait"],
    });
    expect(ask.statusCode).toBe(201);
    const before = (await inject("GET", "/api/managers/needs-you?all=1")).json() as { totals: { checked: number } };
    await fs.writeFile(path.join(t.projectsRoot, p.slug, "project.yaml"), 'name: "Widget\nbehaviours: [oops\n', "utf8");

    const res = (await inject("GET", "/api/managers/needs-you?all=1")).json() as {
      projects: { slug: string; configError?: string; needsYou: { title: string }[]; alerts: { kind: string; severity: string; message: string }[] }[];
      totals: { checked: number; errors: number };
    };
    expect(res.totals.checked).toBe(before.totals.checked);
    const g = res.projects.find((x) => x.slug === p.slug)!;
    expect(g).toBeDefined();
    expect(g.configError).toMatch(/project\.yaml is not valid YAML/);
    expect(g.needsYou.map((x) => x.title)).toEqual(["Decide whether to merge renovate bump #88"]);
    expect(g.alerts[0]).toMatchObject({ kind: "config-unreadable", severity: "error" });
    expect(g.alerts[0]!.message).toMatch(/missing from the project list/);
    expect(res.totals.errors).toBeGreaterThanOrEqual(1);
    // Without ?all it is listed too (it has something to show).
    const plain = (await inject("GET", "/api/managers/needs-you")).json() as { projects: { slug: string }[] };
    expect(plain.projects.map((x) => x.slug)).toContain(p.slug);
    // And the error never leaks the absolute data dir.
    expect(JSON.stringify(res)).not.toContain(t.projectsRoot);

    // An EMPTY project.yaml hides a project the same way, so it is flagged too.
    await fs.writeFile(path.join(t.projectsRoot, p.slug, "project.yaml"), "", "utf8");
    const empty = (await inject("GET", "/api/managers/needs-you")).json() as { projects: { slug: string; configError?: string }[] };
    expect(empty.projects.find((x) => x.slug === p.slug)?.configError).toBe("project.yaml is empty");
  });

  it("#12: an agent cannot rewrite another project's trigger (its own project still works)", async () => {
    const a = ((await inject("POST", "/api/projects", { name: "Acme Site" })).json() as { project: Project }).project;
    const w = ((await inject("POST", "/api/projects", { name: "Other Lib" })).json() as { project: Project }).project;
    await t.triggers.set(a.slug, "probe", {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: {
        prompt:
          `[[MCP managers.set_trigger {"project":"${w.slug}","name":"wake","prompt":"rewritten wake"}]] ` +
          `[[MCP managers.set_trigger {"project":"${a.slug}","name":"own-one","type":"schedule","cron":"0 3 1 1 *","prompt":"x","enabled":false}]]`,
      },
      enabled: false,
    });
    const run = await inject("POST", `/api/projects/${a.slug}/triggers/probe/run`);
    expect(run.statusCode).toBe(202);
    const deadline = Date.now() + 30_000;
    let own: unknown;
    for (;;) {
      own = ((await inject("GET", `/api/projects/${a.slug}`)).json() as { project: Project }).project.triggers?.["own-one"];
      const runs = ((await inject("GET", `/api/projects/${a.slug}/managers/runs?trigger=probe`)).json() as { runs: { status: string }[] }).runs;
      if (runs.length && runs[0]!.status !== "running") break;
      if (Date.now() > deadline) throw new Error("probe run never finished");
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(own).toBeDefined();
    const wake = ((await inject("GET", `/api/projects/${w.slug}`)).json() as { project: Project }).project.triggers?.wake;
    expect(wake?.run.prompt).not.toBe("rewritten wake");
  }, 60_000);

  it("#13: concurrent creates of one slug make ONE project; remove and a queued write never resurrect it", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => t.projects.create({ name: "Race Me" }).then(() => "ok", (e: Error) => e.message)),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => /already exists/.test(r))).toHaveLength(7);

    // A locked write queued behind a remove fails, and the directory stays gone.
    const [removed, patched] = await Promise.allSettled([
      t.projects.remove("race-me"),
      t.projects.update("race-me", { summary: "after the remove" }),
    ]);
    expect(removed.status).toBe("fulfilled");
    expect(patched.status).toBe("rejected");
    await expect(fs.access(path.join(t.projectsRoot, "race-me"))).rejects.toThrow();
  });

  it("#13: an agent's partial set_trigger merges into the trigger read UNDER the lock", async () => {
    const p = ((await inject("POST", "/api/projects", { name: "Merge Probe" })).json() as { project: Project }).project;
    await t.triggers.set(p.slug, "job", { trigger: { type: "schedule", cron: "0 3 1 1 *" }, run: { prompt: "v1" }, enabled: false });
    // The agent's merge is evaluated against whatever the file holds when the lock is taken:
    // Ed's edit (queued first) lands, then the agent's `enabled` flip merges on top of it.
    const human = t.triggers.set(p.slug, "job", {
      trigger: { type: "schedule", cron: "0 3 1 1 *" },
      run: { prompt: "Ed's v2" },
      enabled: false,
    });
    const { mergeTriggerUpdate } = await import("../../src/trigger-config.js");
    const agent = t.triggers.set(p.slug, "job", (existing) => mergeTriggerUpdate(existing, { enabled: true }));
    await Promise.all([human, agent]);
    const job = ((await inject("GET", `/api/projects/${p.slug}`)).json() as { project: Project }).project.triggers?.job;
    expect(job?.run.prompt).toBe("Ed's v2");
    expect(job?.enabled).toBe(true);
  });
});

/**
 * Managers M9: per-project MCP connections — the pure half.
 *
 * Resolution (inline secrets are a hard error, reserved names are refused,
 * `tools:` narrows to exact patterns, unset env drops), attachment to the keeper
 * and to scoped triggers (a trigger reaches a connection only through its own
 * `run.tools`), the briefing body, the API redaction, and the probe's error
 * sanitiser plus the probe itself against the rig's fake Paddock /mcp.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { AgentConfigSchema } from "@herdctl/core";
import {
  PROJECT_MCP_RESERVED_NAMES,
  connectionsBriefingBody,
  projectMcpNotices,
  redactMcpInPayload,
  resolveProjectMcp,
  sanitizeProjectMcp,
  triggerConnections,
  type ProjectMcpConfig,
} from "../../../src/managers/project-mcp.js";
import { probeConnection, sanitizeProbeError } from "../../../src/managers/mcp-probe.js";
import { buildAgentConfig, buildTriggerConfig } from "../../../src/herdctl-agent-config.js";
import { FLEET_ALLOWED_TOOLS } from "../../../src/herdctl-agent-names.js";
import { RESERVED_MCP_SERVER_NAMES } from "../../../src/mcp-servers.js";
import { sanitizeTrigger } from "../../../src/trigger-config.js";
import type { PaddockConfig } from "../../../src/config.js";
import type { Project } from "../../../src/projects.js";
// The rig's fake Paddock /mcp — the same server QA drives.
import { startFakePaddockMcp } from "../../../../../scripts/managers-rig/fake-paddock-mcp.mjs";

const SECRET = "Bearer SYNTHETIC-SECRET-9f3a";
const ENV = { MANAGERS_MCP_PADDOCK_WIDGET_LIB: SECRET, MANAGERS_RIG_URL: "http://127.0.0.1:1/mcp?k=v" };

const paddock = (over: Partial<ProjectMcpConfig> = {}): ProjectMcpConfig => ({
  url: "https://paddock.example.invalid/mcp",
  headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_WIDGET_LIB" },
  ...over,
});

const resolve = (mcp: Record<string, unknown>, env: Record<string, string | undefined> = ENV) =>
  resolveProjectMcp({ mcp }, env);

/** Everything a diagnostic could leak through. */
const allText = (r: ReturnType<typeof resolve>) =>
  JSON.stringify({ ...r, servers: undefined, connections: r.connections.map(({ server: _s, ...v }) => v) });

describe("resolveProjectMcp (M9)", () => {
  it("resolves an env-referenced bearer; the view names the variable, never the value", () => {
    const r = resolve({ paddock: paddock({ description: "Ed's Paddock" }) });
    expect(r.errors).toEqual([]);
    expect(r.servers.paddock).toEqual({
      url: "https://paddock.example.invalid/mcp",
      headers: { Authorization: SECRET },
    });
    const c = r.connections[0]!;
    expect(c).toMatchObject({
      name: "paddock",
      description: "Ed's Paddock",
      transport: "http",
      url: "https://paddock.example.invalid/mcp",
      headerKeys: ["Authorization"],
      envRefs: [{ name: "MANAGERS_MCP_PADDOCK_WIDGET_LIB", where: "headers.Authorization", set: true }],
      tools: null,
      allow: ["mcp__paddock__*"],
      attached: true,
    });
    expect(allText(r)).not.toContain("SYNTHETIC-SECRET");
  });

  it("an INLINE Authorization value is a hard error: dropped, and the value is not echoed", () => {
    const r = resolve({ paddock: paddock({ headers: { Authorization: SECRET } }) });
    expect(r.servers).toEqual({});
    expect(r.toolPatterns).toEqual([]);
    const c = r.connections[0]!;
    expect(c.attached).toBe(false);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toMatch(/^mcp\.paddock\.headers\.Authorization: looks like a credential .* Not attached$/);
    expect(allText(r)).not.toContain("SYNTHETIC-SECRET");
    // The instance block only WARNS about the same thing; here it is refused.
    expect(r.warnings).toEqual([]);
  });

  it("inline secret-ish env values and a url with a query string are hard errors too", () => {
    const stdio = resolve({ gh: { command: "/usr/bin/gh-mcp", env: { GITHUB_TOKEN: "ghp_SYNTHETIC" } } });
    expect(stdio.connections[0]!.attached).toBe(false);
    expect(stdio.errors[0]).toMatch(/mcp\.gh\.env\.GITHUB_TOKEN: looks like a credential/);
    expect(allText(stdio)).not.toContain("ghp_SYNTHETIC");
    const q = resolve({ x: { url: "https://x.example.invalid/mcp?api_key=SYNTHETIC" } });
    expect(q.connections[0]!.attached).toBe(false);
    expect(q.errors[0]).toMatch(/mcp\.x\.url: carries a query string/);
    expect(allText(q)).not.toContain("api_key=SYNTHETIC");
    // A non-secret inline header is fine.
    expect(resolve({ x: { url: "https://x.example.invalid/mcp", headers: { "X-Client": "managers" } } }).servers.x)
      .toBeDefined();
  });

  it("reserved names are refused (the injected servers and the browser server)", () => {
    expect(PROJECT_MCP_RESERVED_NAMES).toEqual(expect.arrayContaining([...RESERVED_MCP_SERVER_NAMES, "playwright"]));
    for (const name of PROJECT_MCP_RESERVED_NAMES) {
      const r = resolve({ [name]: paddock() });
      expect(r.servers).toEqual({});
      expect(r.errors[0]).toContain(`mcp.${name}: "${name}" is reserved`);
    }
  });

  it("tools: narrows the allowlist to exact mcp__<name>__<tool> patterns", () => {
    const r = resolve({ paddock: paddock({ tools: ["list_projects", "list_chats", "read_chat", "create_chat", "list_chats"] }) });
    expect(r.connections[0]!.tools).toEqual(["list_projects", "list_chats", "read_chat", "create_chat"]);
    expect(r.toolPatterns).toEqual([
      "mcp__paddock__list_projects",
      "mcp__paddock__list_chats",
      "mcp__paddock__read_chat",
      "mcp__paddock__create_chat",
    ]);
    expect(r.toolPatterns).not.toContain("mcp__paddock__*");
  });

  it("a bad tools: list drops the connection (empty, a pattern instead of a name, not a list)", () => {
    for (const tools of [[], ["mcp__paddock__list_chats"], ["list chats"], "list_chats"]) {
      const r = resolve({ paddock: paddock({ tools: tools as string[] }) });
      expect(r.connections[0]!.attached, JSON.stringify(tools)).toBe(false);
      expect(r.errors[0]).toMatch(/^mcp\.paddock\.tools: /);
    }
  });

  it("an unset env var drops the connection with an error naming the variable (the broken-conn fixture)", () => {
    const r = resolve({ paddock: paddock({ headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_BROKEN_CONN" } }) });
    expect(r.servers).toEqual({});
    const c = r.connections[0]!;
    expect(c.attached).toBe(false);
    expect(c.envRefs).toEqual([{ name: "MANAGERS_MCP_PADDOCK_BROKEN_CONN", where: "headers.Authorization", set: false }]);
    expect(c.errors).toEqual([
      "mcp.paddock.headers.Authorization: environment variable MANAGERS_MCP_PADDOCK_BROKEN_CONN is unset or empty. Not attached",
    ]);
  });

  it("an env: url shows the RESOLVED url, redacted; unset it shows the reference", () => {
    const set = resolve({ p: { url: "env:MANAGERS_RIG_URL" } });
    expect(set.connections[0]!.url).toBe("http://127.0.0.1:1/mcp?<redacted>");
    expect(set.servers.p!.url).toBe("http://127.0.0.1:1/mcp?k=v");
    const unset = resolve({ p: { url: "env:NOPE_URL" } });
    expect(unset.connections[0]!.url).toBe("env:NOPE_URL");
    expect(unset.connections[0]!.attached).toBe(false);
  });

  it("an unknown key, a non-mapping entry and a non-mapping block are errors, never throws", () => {
    expect(resolve({ p: { ...paddock(), toolz: ["x"] } }).errors[0]).toMatch(/unrecognised key\(s\) toolz/);
    expect(resolve({ p: "https://x" }).errors[0]).toBe("mcp.p: is not a mapping. Not attached");
    expect(resolveProjectMcp({ mcp: ["x"] }, ENV).errors[0]).toMatch(/^mcp: must be a mapping/);
    expect(resolveProjectMcp({}, ENV)).toMatchObject({ servers: {}, connections: [], errors: [] });
  });

  it("one bad connection does not take the others down", () => {
    const r = resolve({ bad: paddock({ headers: { Authorization: SECRET } }), good: paddock() });
    expect(Object.keys(r.servers)).toEqual(["good"]);
    expect(r.connections.map((c) => [c.name, c.attached])).toEqual([["bad", false], ["good", true]]);
  });

  it("notices are secret-free and name the connection", () => {
    const r = resolve({ bad: paddock({ headers: { Authorization: SECRET } }), good: paddock() });
    const lines = projectMcpNotices("widget-lib", r);
    expect(lines.map((l) => l.level)).toEqual(["info", "error"]);
    expect(lines[0]!.message).toBe("widget-lib: MCP connections attached: good (http: https://paddock.example.invalid/mcp, 1 header)");
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC-SECRET");
  });

  it("sanitizeProjectMcp carries entries verbatim (an invalid one survives a save), drops a non-mapping block", () => {
    const raw = { paddock: paddock({ tools: [] }), bad: "x" };
    expect(sanitizeProjectMcp(raw)).toEqual(raw);
    expect(sanitizeProjectMcp([])).toBeUndefined();
    expect(sanitizeProjectMcp({})).toBeUndefined();
  });
});

describe("attachment (M9)", () => {
  const cfg = { dataDir: "/tmp/data", nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
  const project = (mcp?: Record<string, ProjectMcpConfig>) =>
    ({
      slug: "widget-lib",
      name: "Widget Lib",
      dir: "/tmp/data/projects/widget-lib",
      workingDir: "/tmp/data/projects/widget-lib",
      mcp,
    }) as unknown as Project;
  const trig = (tools: string[], type: "schedule" | "event" = "schedule") =>
    sanitizeTrigger({
      trigger: type === "schedule" ? { type, cron: "0 7 * * *" } : { type, on: "onArchive" },
      run: { prompt: "go", tools },
      enabled: true,
    })!;

  it("the keeper gets the project servers and exactly their patterns on allowed_tools", () => {
    const p = project({ paddock: paddock({ tools: ["list_chats", "create_chat"] }) });
    const mcp = resolveProjectMcp(p, ENV);
    const c = buildAgentConfig(cfg, p, undefined, undefined, undefined, undefined, mcp);
    expect(c.mcp_servers).toEqual({ paddock: mcp.servers.paddock });
    expect(c.allowed_tools).toEqual([...FLEET_ALLOWED_TOOLS, "mcp__paddock__list_chats", "mcp__paddock__create_chat"]);
    // …and survives herdctl's schema, header included.
    const parsed = AgentConfigSchema.parse(c);
    expect(parsed.mcp_servers?.paddock).toMatchObject({ url: "https://paddock.example.invalid/mcp", headers: { Authorization: SECRET } });
  });

  it("a project with no connections leaves the keeper config as before (no mcp_servers, no allowed_tools)", () => {
    const c = buildAgentConfig(cfg, project(), undefined, undefined, undefined, undefined, resolveProjectMcp(project(), ENV));
    expect(c.mcp_servers).toBeUndefined();
    expect(c.allowed_tools).toBeUndefined();
  });

  it("a dropped connection attaches nothing", () => {
    const p = project({ paddock: paddock({ headers: { Authorization: SECRET } }) });
    const c = buildAgentConfig(cfg, p, undefined, undefined, undefined, undefined, resolveProjectMcp(p, ENV));
    expect(c.mcp_servers).toBeUndefined();
    expect(c.allowed_tools).toBeUndefined();
  });

  describe("trigger scoping: a scoped trigger reaches a connection only through its own run.tools", () => {
    const p = project({ paddock: paddock({ tools: ["list_chats", "create_chat"] }), other: { url: "https://o.example.invalid/mcp" } });
    const mcp = resolveProjectMcp(p, ENV);
    const build = (tools: string[], type?: "schedule" | "event") => buildTriggerConfig(cfg, p, "t", trig(tools, type), undefined, mcp);

    it("run.tools without the connection → not attached, allow-list untouched", () => {
      const c = build(["Read", "Write"]);
      expect(c.mcp_servers).toBeUndefined();
      expect(c.allowed_tools).toEqual(["Read", "Write"]);
    });
    it("mcp__paddock__* → attached with what the CONNECTION allows (a trigger cannot widen it)", () => {
      const c = build(["Read", "mcp__paddock__*"]);
      expect(Object.keys(c.mcp_servers as object)).toEqual(["paddock"]);
      expect(c.allowed_tools).toEqual(["Read", "mcp__paddock__list_chats", "mcp__paddock__create_chat"]);
    });
    it("one named tool → just that tool; a tool the connection narrows out → nothing", () => {
      const one = build(["mcp__paddock__list_chats"]);
      expect(Object.keys(one.mcp_servers as object)).toEqual(["paddock"]);
      expect(one.allowed_tools).toEqual(["mcp__paddock__list_chats"]);
      const out = build(["Read", "mcp__paddock__send_message"]);
      expect(out.mcp_servers).toBeUndefined();
      expect(out.allowed_tools).toEqual(["Read", "mcp__paddock__send_message"]);
    });
    it("an un-narrowed connection grants any named tool; two connections attach independently", () => {
      const c = build(["mcp__other__anything", "mcp__paddock"], "event");
      expect(Object.keys(c.mcp_servers as object).sort()).toEqual(["other", "paddock"]);
      expect(c.allowed_tools).toEqual(["mcp__other__anything", "mcp__paddock__list_chats", "mcp__paddock__create_chat"]);
    });
    it("empty run.tools (the unenforced no-tools case) attaches nothing", () => {
      expect(triggerConnections([], mcp)).toEqual({ servers: {}, allowedTools: [] });
      expect(build([], "event").mcp_servers).toBeUndefined();
    });
  });
});

describe("briefing body and API redaction (M9)", () => {
  it("lists names, descriptions and callable tools; a broken connection is marked unavailable", () => {
    const body = connectionsBriefingBody(
      resolve({
        paddock: paddock({ description: "Ed's Paddock", tools: ["list_chats"] }),
        wide: { url: "https://w.example.invalid/mcp" },
        broken: paddock({ headers: { Authorization: "env:UNSET_X" } }),
      }),
    );
    expect(body).toContain("- broken: NOT AVAILABLE this run");
    expect(body).toContain("- **paddock** — Ed's Paddock. Tools: mcp__paddock__list_chats.");
    expect(body).toContain("- **wide**. Tools: mcp__wide__* (every tool).");
    expect(body).not.toContain("example.invalid");
    expect(connectionsBriefingBody(resolve({}))).toBe("(none configured)");
  });

  it("redactMcpInPayload keeps env: names and redacts inline values in project/projects/root", () => {
    const mcp = { p: { url: "https://x.example.invalid/mcp?k=SYNTH", headers: { Authorization: SECRET, A: "env:VAR_A" }, args: ["--token=SYNTH"] } };
    const out = redactMcpInPayload({ project: { slug: "a", mcp }, projects: [{ slug: "b", mcp }, { slug: "c" }], root: { slug: "", mcp } });
    const s = JSON.stringify(out);
    expect(s).not.toContain("SYNTH");
    expect(s).toContain("env:VAR_A");
    expect((out as { project: { mcp: { p: { url: string } } } }).project.mcp.p.url).toBe("https://x.example.invalid/mcp?<redacted>");
    const untouched = { projects: [{ slug: "x" }] };
    expect(redactMcpInPayload(untouched)).toBe(untouched);
  });
});

describe("probeConnection (M9) against the rig's fake Paddock /mcp", () => {
  let fake: { url: string; port: number; close: () => Promise<void>; calls: unknown[] };
  beforeAll(async () => {
    fake = await startFakePaddockMcp({ port: 0 });
  });
  afterAll(async () => {
    await fake.close();
  });

  it("succeeds with the right bearer and lists the tools", async () => {
    const r = await probeConnection({ url: fake.url, headers: { Authorization: "Bearer rig-token" } });
    expect(r).toMatchObject({ ok: true, error: null });
    expect(r.tools).toEqual(["list_projects", "list_chats", "create_chat", "read_chat"]);
  });

  it("a wrong token is 401 Unauthorized, with no token text", async () => {
    const r = await probeConnection({ url: fake.url, headers: { Authorization: "Bearer wrong-secret" } });
    expect(r).toMatchObject({ ok: false, tools: [], error: "401 Unauthorized" });
  });

  it("a closed port is ECONNREFUSED", async () => {
    const port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const r = await probeConnection({ url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer rig-token" } });
    expect(r).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });

  it("a server that never answers times out within the bound", async () => {
    const hang = net.createServer(() => undefined).listen(0, "127.0.0.1");
    await new Promise((r) => hang.once("listening", r));
    const port = (hang.address() as net.AddressInfo).port;
    const r = await probeConnection({ url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 300 });
    hang.close();
    expect(r).toMatchObject({ ok: false, error: "timed out after 300ms" });
  });

  it("stdio is not probed", async () => {
    expect(await probeConnection({ command: "/bin/true" })).toMatchObject({ ok: false });
  });

  it("sanitizeProbeError never returns the raw message", () => {
    expect(sanitizeProbeError(Object.assign(new Error("Streamable HTTP error: body Bearer SECRET"), { code: 403 }))).toBe("403 Forbidden");
    expect(sanitizeProbeError(new Error("fetch failed", { cause: { code: "ENOTFOUND" } }))).toBe("ENOTFOUND");
    expect(sanitizeProbeError(new Error("something with Bearer SECRET inside"))).toBe("connection failed");
    expect(sanitizeProbeError(new Error("MCP error -32601: Method not found: x"))).toBe("MCP error -32601");
  });
});

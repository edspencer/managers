/**
 * Managers M9: per-project MCP connections on the real app.
 *
 * A fake Paddock `/mcp` (the rig's `fake-paddock-mcp.mjs`, bearer `rig-token`)
 * stands in for Ed's Paddock. Four projects, like the rig:
 *
 *   - widget-lib    `mcp.paddock` with the right token (env var set);
 *   - broken-conn   the token's env var is UNSET;
 *   - wrong-token   the env var holds a token the server rejects;
 *   - empty-project no `mcp:` at all.
 *
 * Covers the REST view and probe, attachment to the keeper (the header-
 * authenticated http server the fake `claude` connects to — M2's untested case),
 * a real `[[MCP paddock.list_projects {}]]` call counted into the run's
 * `mcpCalls` (M6's open test), trigger scoping, behaviour denial of a connection
 * tool, the briefing section, no cascade from the root, the DTO redaction and
 * the §4 round trip.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { keeperAgentName, triggerAgentName } from "../../src/herdctl-agent-names.js";
import type { Project } from "../../src/projects.js";
import { startFakePaddockMcp } from "../../../../scripts/managers-rig/fake-paddock-mcp.mjs";

type Run = { id: string; trigger: string; status: string; sessionId: string | null; mcpCalls: Record<string, Record<string, number>> };
type Conn = {
  name: string;
  url: string | null;
  headerKeys: string[];
  envRefs: { name: string; where: string; set: boolean }[];
  tools: string[] | null;
  allow: string[];
  attached: boolean;
  errors: string[];
};
type Probe = { name: string; ok: boolean; tools: string[]; error: string | null };
type Line = {
  type: string;
  message?: { content?: Array<{ type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> | string };
};
type Invocation = { prompt: string; allowedTools: string | null; mcpConfig: string | null };

const TOKEN_ENV = "MANAGERS_MCP_PADDOCK_WIDGET_LIB";
const WRONG_ENV = "MANAGERS_MCP_PADDOCK_WRONG_TOKEN";
const URL_ENV = "MANAGERS_TEST_PADDOCK_URL";

describe("integration: per-project MCP connections (M9)", () => {
  let t: TestApp;
  let fake: Awaited<ReturnType<typeof startFakePaddockMcp>>;
  let logPath: string;
  const slugs: Record<string, string> = {};
  const api = (slug: string) => (slug === "" ? "/api/root/managers" : `/api/projects/${slug}/managers`);
  const inject = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const connections = async (slug: string) => ((await inject("GET", `${api(slug)}/connections`)).json() as { connections: Conn[] }).connections;
  const probe = async (slug: string, name = "paddock") => {
    const res = await inject("POST", `${api(slug)}/connections/${name}/probe`, {});
    return { status: res.statusCode, body: res.json() as Probe, raw: res.body };
  };
  const agent = (name: string) =>
    t.herdctl.manager.getAgents().find((a) => a.name === name) as unknown as
      | { mcp_servers?: Record<string, { url?: string; headers?: Record<string, string> }>; allowed_tools?: string[] }
      | undefined;

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Set a workspace's `mcp:` (or any keys) by hand, then re-register its agents. */
  async function setYaml(slug: string, keys: Record<string, unknown>): Promise<void> {
    const file = slug === "" ? path.join(t.projectsRoot, "project.yaml") : path.join(t.projectsRoot, slug, "project.yaml");
    const doc = (YAML.parse(await fs.readFile(file, "utf8").catch(() => "")) ?? {}) as Record<string, unknown>;
    Object.assign(doc, keys);
    await fs.writeFile(file, YAML.stringify(doc), "utf8");
    await t.herdctl.ensureProjectAgent(await t.projects.get(slug));
  }

  const paddockConn = (tokenEnv: string, extra: Record<string, unknown> = {}) => ({
    paddock: { url: `env:${URL_ENV}`, headers: { Authorization: `env:${tokenEnv}` }, description: "This project's Paddock", ...extra },
  });

  async function fire(slug: string, name: string, prompt: string, tools?: string[]): Promise<Run> {
    await t.triggers.set(slug, name, {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt, ...(tools ? { tools } : {}) },
      enabled: false,
    });
    const before = new Set(
      ((await inject("GET", `${api(slug)}/runs?trigger=${name}`)).json() as { runs: Run[] }).runs.map((r) => r.id),
    );
    const res = await inject("POST", `/api/projects/${slug}/triggers/${name}/run`);
    expect(res.statusCode).toBe(202);
    return waitFor(async () => {
      const { runs } = (await inject("GET", `${api(slug)}/runs?trigger=${name}`)).json() as { runs: Run[] };
      return runs.find((r) => !before.has(r.id) && r.status !== "running") ?? null;
    });
  }

  async function transcriptCalls(sessionId: string) {
    const entries = await fs.readdir(t.tmp, { recursive: true, withFileTypes: true });
    const e = entries.find((x) => x.name === `${sessionId}.jsonl`)!;
    const lines = (await fs.readFile(path.join((e as unknown as { parentPath: string }).parentPath, e.name), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
    const results = new Map<string, { content: unknown; is_error?: boolean }>();
    for (const l of lines)
      if (l.type === "user" && Array.isArray(l.message?.content))
        for (const b of l.message.content) if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
    const calls: { name: string; content: string; isError: boolean }[] = [];
    for (const l of lines)
      if (l.type === "assistant" && Array.isArray(l.message?.content))
        for (const b of l.message.content)
          if (b.type === "tool_use") {
            const r = results.get(b.id!);
            calls.push({ name: b.name!, content: String(r?.content ?? ""), isError: !!r?.is_error });
          }
    return calls;
  }

  const invocations = async (): Promise<Invocation[]> =>
    (await fs.readFile(logPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Invocation);

  beforeAll(async () => {
    fake = await startFakePaddockMcp({ port: 0 });
    logPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "m9-inv-")), "invocations.jsonl");
    t = await startTestApp({
      sweepIntervalMs: 600_000,
      gitRepo: true,
      env: {
        MANAGERS_FAKE_INVOCATION_LOG: logPath,
        [URL_ENV]: fake.url,
        [TOKEN_ENV]: "Bearer rig-token",
        [WRONG_ENV]: "Bearer wrong-secret",
      },
    });
    for (const name of ["Widget Lib", "Broken Conn", "Wrong Token", "Empty Project"]) {
      const p = ((await inject("POST", "/api/projects", { name })).json() as { project: Project }).project;
      slugs[name] = p.slug;
    }
    await setYaml(slugs["Widget Lib"]!, { mcp: paddockConn(TOKEN_ENV, { tools: ["list_projects", "list_chats", "create_chat", "read_chat"] }) });
    await setYaml(slugs["Broken Conn"]!, { mcp: paddockConn("MANAGERS_MCP_PADDOCK_BROKEN_CONN") });
    await setYaml(slugs["Wrong Token"]!, { mcp: paddockConn(WRONG_ENV) });
  }, 60_000);
  afterAll(async () => {
    await t?.teardown();
    await fake?.close();
  });

  it("GET connections: redacted url, header keys, env var set — and no token text anywhere", async () => {
    const res = await inject("GET", `${api(slugs["Widget Lib"]!)}/connections`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("rig-token");
    const [c] = (res.json() as { connections: Conn[] }).connections;
    expect(c).toMatchObject({
      name: "paddock",
      url: fake.url,
      headerKeys: ["Authorization"],
      envRefs: [
        { name: URL_ENV, where: "url", set: true },
        { name: TOKEN_ENV, where: "headers.Authorization", set: true },
      ],
      tools: ["list_projects", "list_chats", "create_chat", "read_chat"],
      allow: ["mcp__paddock__list_projects", "mcp__paddock__list_chats", "mcp__paddock__create_chat", "mcp__paddock__read_chat"],
      attached: true,
      errors: [],
    });
  });

  it("probe with the right token lists the fake's tools", async () => {
    const r = await probe(slugs["Widget Lib"]!);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "paddock", ok: true, error: null, tools: ["list_projects", "list_chats", "create_chat", "read_chat"] });
  });

  it("missing env: listed as not attached with the variable unset; the probe says why without contacting anything", async () => {
    const calls = fake.calls.length;
    const [c] = await connections(slugs["Broken Conn"]!);
    expect(c!.attached).toBe(false);
    expect(c!.envRefs.find((r) => r.where === "headers.Authorization")).toEqual({
      name: "MANAGERS_MCP_PADDOCK_BROKEN_CONN",
      where: "headers.Authorization",
      set: false,
    });
    const r = await probe(slugs["Broken Conn"]!);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("MANAGERS_MCP_PADDOCK_BROKEN_CONN is unset or empty");
    expect(r.raw).not.toMatch(/at .*\.js:\d+|rig-token/);
    expect(fake.calls.length).toBe(calls);
    // …and the keeper has no paddock server.
    expect(agent(keeperAgentName(slugs["Broken Conn"]!))?.mcp_servers?.paddock).toBeUndefined();
  });

  it("wrong token: the probe is 401 Unauthorized, with no token text", async () => {
    const r = await probe(slugs["Wrong Token"]!);
    expect(r.body).toMatchObject({ ok: false, tools: [], error: "401 Unauthorized" });
    expect(r.raw).not.toContain("wrong-secret");
  });

  it("empty state and 404s", async () => {
    expect(await connections(slugs["Empty Project"]!)).toEqual([]);
    expect((await probe(slugs["Empty Project"]!)).status).toBe(404);
    expect((await inject("GET", "/api/projects/no-such-project/managers/connections")).statusCode).toBe(404);
  });

  it("the keeper carries the header-authenticated server and exactly the narrowed patterns", async () => {
    const k = agent(keeperAgentName(slugs["Widget Lib"]!))!;
    expect(k.mcp_servers?.paddock).toMatchObject({ url: fake.url, headers: { Authorization: "Bearer rig-token" } });
    expect(k.allowed_tools).toEqual(expect.arrayContaining(["mcp__paddock__list_projects", "mcp__paddock__create_chat"]));
    expect(k.allowed_tools).not.toContain("mcp__paddock__*");
  });

  it("[[MCP paddock.list_projects {}]] really calls the fake with the bearer, and the run counts it in mcpCalls", async () => {
    const before = fake.calls.length;
    const run = await fire(slugs["Widget Lib"]!, "pd-list", "Check. [[MCP paddock.list_projects {}]] [[MCP managers.list_projects {}]]");
    expect(run.status).toBe("succeeded");
    expect(run.mcpCalls).toEqual({ paddock: { list_projects: 1 } });
    expect(fake.calls.slice(before)).toEqual([{ tool: "list_projects", args: {}, authorized: true }]);
    const calls = await transcriptCalls(run.sessionId!);
    const pd = calls.find((c) => c.name === "mcp__paddock__list_projects")!;
    expect(pd.isError).toBe(false);
    expect(pd.content).toContain('"slug": "demo"');
    // Characterisation (mcp-servers.ts argvExposure): under batch the header rides in --mcp-config.
    const inv = (await invocations()).find((i) => i.prompt.includes("[[MCP paddock.list_projects"))!;
    expect(inv.mcpConfig).toContain('"paddock"');
  });

  it("a tool the connection narrows out is refused by the allowlist, and the fake never sees it", async () => {
    await setYaml(slugs["Widget Lib"]!, { mcp: paddockConn(TOKEN_ENV, { tools: ["list_projects"] }) });
    try {
      const before = fake.calls.length;
      const run = await fire(slugs["Widget Lib"]!, "pd-narrow", 'Go. [[MCP paddock.create_chat {"project":"demo","prompt":"x"}]]');
      const [c] = await transcriptCalls(run.sessionId!);
      expect(c).toMatchObject({ name: "mcp__paddock__create_chat", isError: true });
      expect(c!.content).toContain("not in --allowedTools");
      expect(fake.calls.length).toBe(before);
    } finally {
      await setYaml(slugs["Widget Lib"]!, { mcp: paddockConn(TOKEN_ENV, { tools: ["list_projects", "list_chats", "create_chat", "read_chat"] }) });
    }
  });

  it("an OFF behaviour's connection tool is denied; switching it on lets create_chat through", async () => {
    const slug = slugs["Widget Lib"]!;
    await setYaml(slug, { behaviours: { dispatch: { description: "Dispatch work to Paddock.", tools: ["mcp__paddock__create_chat"] } } });
    const prompt = 'Go. [[MCP paddock.create_chat {"project":"demo","prompt":"triage #12"}]]';
    const off = await fire(slug, "pd-dispatch", prompt);
    const [c1] = await transcriptCalls(off.sessionId!);
    expect(c1).toMatchObject({ name: "mcp__paddock__create_chat", isError: true });
    expect(c1!.content).toContain("denied");
    expect((await inject("PATCH", `${api(slug)}/behaviours/dispatch`, { enabled: true })).statusCode).toBe(200);
    const before = fake.calls.length;
    const on = await fire(slug, "pd-dispatch", prompt);
    const [c2] = await transcriptCalls(on.sessionId!);
    expect(c2).toMatchObject({ name: "mcp__paddock__create_chat", isError: false });
    expect(c2!.content).toMatch(/"sessionId": "fake-chat-new-\d{4}"/);
    expect(on.mcpCalls).toEqual({ paddock: { create_chat: 1 } });
    expect(fake.calls.slice(before)).toEqual([{ tool: "create_chat", args: { project: "demo", prompt: "triage #12" }, authorized: true }]);
  });

  it("trigger scoping: a scoped trigger reaches the connection only through its own run.tools", async () => {
    const slug = slugs["Widget Lib"]!;
    const before = fake.calls.length;
    const without = await fire(slug, "scoped-no", "Go. [[MCP paddock.list_projects {}]]", ["Read"]);
    expect(agent(triggerAgentName(slug, "scoped-no"))?.mcp_servers?.paddock).toBeUndefined();
    const [c1] = await transcriptCalls(without.sessionId!);
    expect(c1).toMatchObject({ name: "mcp__paddock__list_projects", isError: true });
    expect(fake.calls.length).toBe(before);

    const withIt = await fire(slug, "scoped-yes", "Go. [[MCP paddock.list_projects {}]]", ["Read", "mcp__paddock__*"]);
    const a = agent(triggerAgentName(slug, "scoped-yes"))!;
    expect(a.mcp_servers?.paddock).toBeDefined();
    // The wildcard is replaced by what the connection allows.
    expect(a.allowed_tools).toEqual(["Read", "mcp__paddock__list_projects", "mcp__paddock__list_chats", "mcp__paddock__create_chat", "mcp__paddock__read_chat"]);
    const [c2] = await transcriptCalls(withIt.sessionId!);
    expect(c2).toMatchObject({ name: "mcp__paddock__list_projects", isError: false });
    expect(withIt.mcpCalls).toEqual({ paddock: { list_projects: 1 } });
  });

  it("the briefing's Connections section names the connection and its tools; empty says none", async () => {
    const b = (await inject("GET", `${api(slugs["Widget Lib"]!)}/briefing`)).json() as { text: string };
    expect(b.text).toContain("- **paddock** — This project's Paddock. Tools: mcp__paddock__list_projects, mcp__paddock__list_chats, mcp__paddock__create_chat, mcp__paddock__read_chat.");
    expect(b.text).not.toContain("rig-token");
    const broken = (await inject("GET", `${api(slugs["Broken Conn"]!)}/briefing`)).json() as { text: string };
    expect(broken.text).toContain("- paddock: NOT AVAILABLE this run");
    const empty = (await inject("GET", `${api(slugs["Empty Project"]!)}/briefing`)).json() as { text: string };
    expect(empty.text).toMatch(/## Connections\n+\(none configured\)/);
  });

  it("not cascaded: Home's own mcp: is Home's alone", async () => {
    await setYaml("", { mcp: { homeonly: { url: `env:${URL_ENV}`, headers: { Authorization: `env:${TOKEN_ENV}` } } } });
    expect((await connections("")).map((c) => c.name)).toEqual(["homeonly"]);
    expect(await connections(slugs["Empty Project"]!)).toEqual([]);
    await t.herdctl.ensureProjectAgent(await t.projects.get(slugs["Empty Project"]!));
    expect(agent(keeperAgentName(slugs["Empty Project"]!))?.mcp_servers).toBeUndefined();
  });

  it("round trip: an unrelated PATCH and a Triggers-tab PUT keep mcp:; the DTO redacts an inline value", async () => {
    const slug = slugs["Widget Lib"]!;
    const file = path.join(t.projectsRoot, slug, "project.yaml");
    const before = YAML.parse(await fs.readFile(file, "utf8")).mcp;
    expect((await inject("PATCH", `/api/projects/${slug}`, { summary: "Changed." })).statusCode).toBe(200);
    expect(YAML.parse(await fs.readFile(file, "utf8")).mcp).toEqual(before);
    const put = await inject("PUT", `/api/projects/${slug}/triggers/pd-list`, {
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "Edited in the Triggers tab." },
      enabled: false,
    });
    expect(put.statusCode).toBe(200);
    expect(YAML.parse(await fs.readFile(file, "utf8")).mcp).toEqual(before);

    // An inline secret (refused by the resolver) is never echoed by the project API.
    await setYaml(slugs["Wrong Token"]!, { mcp: { paddock: { url: `env:${URL_ENV}`, headers: { Authorization: "Bearer INLINE-SYNTHETIC" } } } });
    for (const url of [`/api/projects/${slugs["Wrong Token"]}`, "/api/projects", `${api(slugs["Wrong Token"]!)}/connections`]) {
      const res = await inject("GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain("INLINE-SYNTHETIC");
    }
    const [c] = await connections(slugs["Wrong Token"]!);
    expect(c!.errors[0]).toMatch(/headers\.Authorization: looks like a credential/);
    // …and the widget-lib DTO shows the env reference, which is a name, not a value.
    const dto = (await inject("GET", `/api/projects/${slug}`)).json() as { project: { mcp?: unknown } };
    expect(JSON.stringify(dto.project.mcp)).toContain(`env:${TOKEN_ENV}`);
  });
});

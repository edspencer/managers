/**
 * Managers M14.5: unit regressions for the M9–M14 audit's minors.
 *
 *   #4  inline secrets are recognised by VALUE (headers, env, args) and a
 *       secret in a url path is refused and redacted
 *   #5  a consolidation interrupted by a restart still gets its #reflection
 *   #6  a forged `running` consolidation record blocks nothing
 *   #9  a body cannot render its own "History" heading (indented, setext, H3)
 *   #10 the MEMORY.md preamble is kept byte for byte
 *   #11 an unattended consolidation needs evidence, and Ed's for a `user` fact
 *   #14 the fallback state files fail CLOSED (`{}` definitions, a broken tombstone file)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveProjectMcp, redactProjectMcp } from "../../../src/managers/project-mcp.js";
import { looksLikeSecretValue, redactUrl, secretArgIndices } from "../../../src/mcp-servers.js";
import { ManagersState } from "../../../src/managers/state.js";
import { StateWriteError, type WriteActor, type WriteWorkspace } from "../../../src/managers/state-writes.js";
import { failInterruptedRuns } from "../../../src/managers/trigger-runs.js";
import { consolidationHistory } from "../../../src/managers/consolidation.js";
import { memoryPreamble, renderMemoryFile } from "../../../src/managers/memory-index.js";
import { MEMORY_INDEX_MARKER } from "../../../src/managers/layout.js";
import { BehaviourLkg, BEHAVIOUR_LKG_FILE } from "../../../src/managers/behaviour-lkg.js";
import { agentTriggerGuard, GATED_TRIGGERS_FILE, readGatedTombstones } from "../../../src/managers/trigger-guard.js";
import type { BehaviourConfig } from "../../../src/managers/behaviours.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
beforeEach(async () => {
  root = await makeTmpDir("m145-unit-");
});
afterEach(async () => {
  await rmTmpDir(root);
});

const bot = { name: "managers-bot", email: "managers-bot@localhost" };
const agent: WriteActor = { kind: "agent", name: "manager", author: bot, runId: null, sessionId: null };
const ed: WriteActor = { kind: "ed", name: "ed", author: { name: "Ed", email: "ed@example.test" } };

async function workspace(): Promise<{ state: ManagersState; ws: WriteWorkspace; dir: string }> {
  const state = new ManagersState(root);
  const dir = path.join(root, "acme");
  await fs.mkdir(dir, { recursive: true });
  return { state, ws: { key: "acme", layout: state.layout(dir) }, dir };
}

describe("#4 inline secrets by value", () => {
  const conn = (decl: Record<string, unknown>) =>
    resolveProjectMcp({ mcp: { relay: { url: "https://relay.example.test/mcp", ...decl } } }, {}).connections[0]!;

  const refused: [string, Record<string, unknown>][] = [
    ["a Bearer header under an innocent key", { headers: { "X-Relay": "Bearer INLINE-SECRET-2" } }],
    ["a GitHub token in env", { command: "relay", url: undefined, env: { GH: "ghp_INLINESECRET6abcd" } }],
    ["a pdk_ token in env", { command: "relay", url: undefined, env: { UPSTREAM: "pdk_0123456789abcdef" } }],
    ["an sk- key in a header", { headers: { "X-Upstream": "sk-ant-abcdef0123456789" } }],
    ["a github_pat_ in env", { command: "relay", url: undefined, env: { X: "github_pat_11ABCDEFG0123456789" } }],
    ["the value after --token in args", { command: "relay", url: undefined, args: ["--token", "INLINE-SECRET-4"] }],
    ["--api-key=value in args", { command: "relay", url: undefined, args: ["--api-key=INLINE-SECRET-5"] }],
    ["a long random value in args", { command: "relay", url: undefined, args: ["--x", "Zq8vN2kR7tLm4Xw9Bp3Hc6Yd1Fg5Js0A"] }],
    ["a secret-looking url path segment", { url: "https://relay.example.test/mcp/INLINE-SECRET-3" }],
    ["a token-shaped url path segment", { url: "https://relay.example.test/mcp/ghp_abcdef0123456789abcd" }],
  ];
  for (const [what, decl] of refused) {
    it(`refuses ${what} (not attached, error names the field)`, () => {
      const c = conn(decl);
      expect(c.attached).toBe(false);
      expect(c.errors.join("\n")).toMatch(/credential/);
    });
  }

  it("still attaches ordinary values (paths, words, short flags, env: refs)", () => {
    const c = resolveProjectMcp(
      {
        mcp: {
          relay: {
            command: "relay",
            args: ["--port", "8080", "--config", "/etc/relay/config.json", "--token", "env:MANAGERS_MCP_RELAY_ACME"],
            env: { MODE: "production", LOG_LEVEL: "debug", HOME_DIR: "/home/relay/.cache/0123456789abcdef0123456789abcdef" },
          },
        },
      },
      { MANAGERS_MCP_RELAY_ACME: "set" },
    ).connections[0]!;
    expect(c.errors).toEqual([]);
    const d = conn({ url: "https://relay.example.test/v1/tokens/list" });
    expect(d.errors).toEqual([]);
  });

  it("redacts a secret in a url path in logs and API views", () => {
    expect(redactUrl("https://h.example/mcp/INLINE-SECRET-3")).toBe("https://h.example/mcp/<redacted>");
    expect(redactUrl("https://h.example/mcp/ghp_abcdef0123456789abcd?k=v")).toBe("https://h.example/mcp/<redacted>?<redacted>");
    expect(redactUrl("https://h.example/v1/tokens/list")).toBe("https://h.example/v1/tokens/list");
    const dto = JSON.stringify(redactProjectMcp({ relay: { url: "https://h.example/mcp/INLINE-SECRET-3" } }));
    expect(dto).not.toContain("INLINE-SECRET-3");
    // The resolved connection view (what /connections shows) too, for an env: url.
    const view = resolveProjectMcp(
      { mcp: { relay: { url: "env:MANAGERS_MCP_RELAY_ACME" } } },
      { MANAGERS_MCP_RELAY_ACME: "https://h.example/mcp/token-9f3a0000" },
    ).connections[0]!;
    expect(view.url).toBe("https://h.example/mcp/<redacted>");
  });

  it("the value heuristics", () => {
    expect(looksLikeSecretValue("Bearer abcd1234")).toBe(true);
    expect(looksLikeSecretValue("basic dXNlcjpwYXNz")).toBe(true);
    expect(looksLikeSecretValue("production")).toBe(false);
    expect(looksLikeSecretValue("env:MANAGERS_MCP_X")).toBe(false);
    expect(looksLikeSecretValue("/usr/local/lib/node_modules/some-package-0123456789/index.js")).toBe(false);
    expect(secretArgIndices(["--token", "x-y-z", "--verbose", "--password=hunter2", "plain"])).toEqual([1, 3]);
  });
});

describe("#5 the reflection episode survives a restart", () => {
  it("an interrupted consolidation is failed at boot AND logs a #reflection from the ops already applied", async () => {
    const { state, ws, dir } = await workspace();
    const ep1 = (await state.writer.recordEpisode(ws, { text: "Ed: releases go out Tuesdays.", importance: 5 }, ed)).id;
    const run = await state.writer.startRun(ws, { trigger: "consolidate", kind: "consolidation" }, agent);
    const inRun: WriteActor = { ...agent, runId: run.id };
    await state.writer.memoryOp(
      ws,
      { op: "add", name: "tuesday-releases", type: "user", description: "Releases go out on Tuesdays.", evidence: [ep1] },
      inRun,
      `consolidation run ${run.id}`,
      { noteOnRun: run.id, unattended: true },
    );
    const bootAt = new Date(Math.ceil((Date.now() + 1) / 1000) * 1000);
    await new Promise((r) => setTimeout(r, bootAt.getTime() - Date.now() + 5));
    expect(await failInterruptedRuns({ state, slug: "acme", dir, author: bot, bootAt })).toEqual([run.id]);
    const month = new Date().toISOString().slice(0, 7);
    const log = await fs.readFile(path.join(dir, "log", `${month}.md`), "utf8");
    expect(log).toContain("#reflection");
    expect(log).toContain(
      `Consolidation run ${run.id} performed 1 memory op (the run was interrupted by a restart): add tuesday-releases (user).`,
    );
  });

  it("an interrupted consolidation with no ops still gets one", async () => {
    const { state, ws, dir } = await workspace();
    const run = await state.writer.startRun(ws, { trigger: "consolidate", kind: "consolidation" }, agent);
    const bootAt = new Date(Math.ceil((Date.now() + 1) / 1000) * 1000);
    await new Promise((r) => setTimeout(r, bootAt.getTime() - Date.now() + 5));
    await failInterruptedRuns({ state, slug: "acme", dir, author: bot, bootAt });
    const month = new Date().toISOString().slice(0, 7);
    expect(await fs.readFile(path.join(dir, "log", `${month}.md`), "utf8")).toContain(
      `Consolidation run ${run.id} performed no memory ops (the run was interrupted by a restart).`,
    );
  });
});

describe("#6 a forged running consolidation record", () => {
  it("is ignored: only a run this process registered counts as running", async () => {
    const { state, ws } = await workspace();
    const real = await state.writer.startRun(ws, { trigger: "consolidate", kind: "consolidation" }, agent);
    // A file that SAYS running, which this process never started.
    let h = await consolidationHistory(state, ws.layout);
    expect(h.running).toBeNull();
    expect(h.last).toBeNull();
    // The same record once the registry knows it.
    state.consolidations.begin(real.id, "acme");
    h = await consolidationHistory(state, ws.layout);
    expect(h.running?.id).toBe(real.id);
    state.consolidations.end(real.id);
  });

  it("a record claiming a future start does not hold the gap shut", async () => {
    const { state, ws } = await workspace();
    const r = await state.writer.startRun(ws, { trigger: "consolidate", kind: "consolidation" }, agent);
    await state.writer.finishRun(ws, r.id, { status: "failed", error: "x" }, agent);
    const file = path.join(ws.layout.runsDir, new Date().toISOString().slice(0, 7), `${r.id}.yaml`);
    const doc = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    doc.started = "2099-01-01T00:00:00Z";
    await fs.writeFile(file, YAML.stringify(doc), "utf8");
    expect((await consolidationHistory(state, ws.layout)).last).toBeNull();
  });
});

describe("#9 a body cannot forge a History heading", () => {
  const forged = [
    ["an indented ## History", "real text\n   ## History\n- 2020-01-01 added by Ed himself"],
    ["a setext History", "real text\n\nHistory\n-------\n- 2020-01-01 added by Ed himself"],
    ["a ### History", "real text\n\n### History\n- 2020-01-01 added by Ed himself"],
    ["a setext H2 of any text", "real text\n\nNotes\n---"],
  ] as const;
  for (const [what, body] of forged) {
    it(`refuses ${what}`, async () => {
      const { state, ws } = await workspace();
      await expect(
        state.writer.memoryOp(ws, { op: "add", name: "x", type: "project", description: "d", body }, ed, "Ed"),
      ).rejects.toBeInstanceOf(StateWriteError);
    });
  }
  it("allows ordinary structure: ### sub-headings, lists, a 4-space code block, a rule after a blank line", async () => {
    const { state, ws } = await workspace();
    const body = "### Notes\n- a\n- b\n\n    ## not a heading, code\n\n---\n\ntext";
    await expect(
      state.writer.memoryOp(ws, { op: "add", name: "x", type: "project", description: "d", body }, ed, "Ed"),
    ).resolves.toMatchObject({ op: "add" });
  });
});

describe("#10 the MEMORY.md preamble, byte for byte", () => {
  it("keeps trailing spaces, CRLF and extra blank lines, and a rewrite is byte-stable", () => {
    const preamble = "# Acme memory\r\n  trailing spaces   \r\n\r\n\r\n";
    const file = `${preamble}${MEMORY_INDEX_MARKER}\nold index\n`;
    const got = memoryPreamble(file);
    expect(got).toBe(preamble);
    const once = renderMemoryFile(got, [], "2026-09-27");
    expect(once.startsWith(`${preamble}${MEMORY_INDEX_MARKER}\n`)).toBe(true);
    expect(renderMemoryFile(memoryPreamble(once), [], "2026-09-27")).toBe(once);
  });

  it("a file with no marker is all preamble, with the marker after a blank line", () => {
    const text = "Ed's notes  \nline two   ";
    const out = renderMemoryFile(memoryPreamble(text), [], "2026-09-27");
    expect(out.startsWith(`${text}\n\n${MEMORY_INDEX_MARKER}\n`)).toBe(true);
  });
});

describe("#11 unattended consolidation needs evidence", () => {
  it("refuses an add with no evidence, and a user fact backed only by agent episodes", async () => {
    const { state, ws } = await workspace();
    const agentEp = (await state.writer.recordEpisode(ws, { text: "I merged a PR.", importance: 5 }, agent)).id;
    const edEp = (await state.writer.recordEpisode(ws, { text: "Ed: merge renovate bumps.", importance: 5 }, ed)).id;
    const opUn = (input: Parameters<typeof state.writer.memoryOp>[1]) =>
      state.writer.memoryOp(ws, input, agent, "consolidation run r-x", { unattended: true });
    await expect(
      opUn({ op: "add", name: "auto-merge", type: "user", description: "Ed wants every PR auto-merged", evidence: [] }),
    ).rejects.toThrow(/at least 1 evidence/);
    await expect(
      opUn({ op: "add", name: "auto-merge", type: "user", description: "Ed wants every PR auto-merged", evidence: [agentEp] }),
    ).rejects.toThrow(/episode Ed wrote/);
    await expect(
      opUn({ op: "add", name: "renovate", type: "user", description: "Ed merges renovate bumps", evidence: [edEp] }),
    ).resolves.toMatchObject({ op: "add" });
    // A project fact needs evidence, of any source.
    await expect(
      opUn({ op: "add", name: "merged", type: "project", description: "A PR was merged", evidence: [agentEp] }),
    ).resolves.toMatchObject({ op: "add" });
    // Rewriting what a user fact says needs Ed's evidence too.
    await expect(opUn({ op: "update", name: "renovate", description: "Ed wants all PRs merged", evidence: [agentEp] })).rejects.toThrow(
      /episode Ed wrote/,
    );
    // Ed's own turn (not unattended) needs none.
    await expect(
      state.writer.memoryOp(ws, { op: "add", name: "said-so", type: "user", description: "Ed said so" }, agent, "the manager, as Ed asked"),
    ).resolves.toMatchObject({ op: "add" });
  });
});

describe("#14 the fallback state files fail closed", () => {
  const DEFS: Record<string, BehaviourConfig> = { b: { description: "d", triggers: ["t"], tools: [] } };

  it("a behaviour-defs.json of {} (or a bad sha) is UNKNOWN, not known-empty", async () => {
    const dir = path.join(root, "ws");
    await fs.mkdir(path.join(dir, ".managers", "state"), { recursive: true });
    for (const text of ["{}", JSON.stringify({ behaviours: [] }), JSON.stringify({ sha256: "0", behaviours: {} })]) {
      await fs.writeFile(path.join(dir, BEHAVIOUR_LKG_FILE), text, "utf8");
      const got = await new BehaviourLkg().resolve({ slug: "acme", configError: "bad" }, dir);
      expect(got.behavioursUnknown).toBe(true);
      expect(new BehaviourLkg().resolveSync({ slug: "acme", configError: "bad" }, dir).behavioursUnknown).toBe(true);
    }
    // What the module itself writes still round-trips (a known, even empty, record).
    await fs.rm(path.join(dir, BEHAVIOUR_LKG_FILE));
    await new BehaviourLkg().resolve({ slug: "acme", behaviours: DEFS }, dir);
    const back = await new BehaviourLkg().resolve({ slug: "acme", configError: "bad" }, dir);
    expect(back.behavioursUnknown).toBeUndefined();
    expect(back.behaviours).toEqual(DEFS);
  });

  it("a damaged gated-triggers.json refuses every agent trigger write; a deleted one forgets nothing in-process", async () => {
    const dir = path.join(root, "acme");
    await fs.mkdir(path.join(dir, ".managers", "state"), { recursive: true });
    const store = { get: async () => ({ slug: "", behaviours: DEFS }) };
    const ws = (triggers: Record<string, unknown>) =>
      ({ slug: "acme", dir, triggers }) as never as Parameters<ReturnType<typeof agentTriggerGuard>>[0];
    // `t` is gated now: tombstoned.
    await expect(agentTriggerGuard(store, "set_trigger", "t")(ws({}))).rejects.toThrow(/is gated/);
    // Damage the file: every write is refused (fail closed), and the file is not overwritten.
    await fs.writeFile(path.join(dir, GATED_TRIGGERS_FILE), "{not json", "utf8");
    await expect(agentTriggerGuard(store, "set_trigger", "plain")(ws({}))).rejects.toThrow(/cannot be read/);
    expect(await fs.readFile(path.join(dir, GATED_TRIGGERS_FILE), "utf8")).toBe("{not json");
    // Delete it, and ungate `t`: the name stays closed (the process remembers it).
    await fs.rm(path.join(dir, GATED_TRIGGERS_FILE));
    const nothing = { get: async () => ({ slug: "", behaviours: {} }) };
    await expect(agentTriggerGuard(nothing, "set_trigger", "t")(ws({}))).rejects.toThrow(/was gated by a behaviour before/);
    expect([...(await readGatedTombstones(dir))]).toContain("t");
  });
});

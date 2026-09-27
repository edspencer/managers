/**
 * Managers M9.5: unit regressions for the audit's remaining findings.
 *
 *   #2  fail-closed behaviours (pure merge + the last-known-good definitions)
 *   #3  the agent trigger guard (bindings, name gates, tombstones)
 *   #5  autocommit stages only store-shaped files
 *   #8  runs left `running` by a dead process are failed at boot
 *   #11 History titles strip the preload/briefing wrapper
 *   M9  bypassPermissions warning; MANAGERS_MCP_* sequestering
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import {
  CONFIG_UNREADABLE_BEHAVIOUR,
  behavioursFor,
  disabledBehaviourTools,
  effectiveBehaviours,
  triggerGate,
  unreadableRoot,
  type BehaviourConfig,
} from "../../../src/managers/behaviours.js";
import { BehaviourLkg } from "../../../src/managers/behaviour-lkg.js";
import { agentTriggerGuard, humanTriggerGuard, readGatedTombstones } from "../../../src/managers/trigger-guard.js";
import { GitService } from "../../../src/git.js";
import { Autocommitter } from "../../../src/managers/autocommit.js";
import { ManagersState } from "../../../src/managers/state.js";
import type { WriteActor } from "../../../src/managers/state-writes.js";
import { isOwnedStateFile } from "../../../src/managers/layout.js";
import { failInterruptedRuns, INTERRUPTED_BY_RESTART } from "../../../src/managers/trigger-runs.js";
import { runPrompt } from "../../../src/runs.js";
import { wrapPreload } from "../../../src/preload.js";
import { configAlerts } from "../../../src/managers/alerts.js";
import {
  mcpResolveEnv,
  resetSequesteredMcpSecrets,
  sequesterMcpSecrets,
} from "../../../src/managers/mcp-secret-env.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

const B = "triage-external-prs";
const TOOL = "mcp__paddock__create_chat";
const HOME_DEFS: Record<string, BehaviourConfig> = { [B]: { description: "d", triggers: ["triage-prs"], tools: [TOOL] } };

let root: string;
beforeEach(async () => {
  root = await makeTmpDir("m95-unit-");
});
afterEach(async () => {
  await rmTmpDir(root);
});

describe("#2 fail-closed behaviours", () => {
  it("an unreadable root turns every behaviour OFF, even one the project switched on", () => {
    const project = { slug: "acme", behaviours: { [B]: { enabled: true } } };
    const ok = effectiveBehaviours(project, { slug: "", behaviours: HOME_DEFS });
    expect(ok.find((b) => b.name === B)?.enabled).toBe(true);
    const broken = effectiveBehaviours(project, { slug: "", behaviours: HOME_DEFS, configError: "bad" });
    expect(broken.find((b) => b.name === B)).toMatchObject({ enabled: false, tools: [TOOL] });
    expect(broken.find((b) => b.name === CONFIG_UNREADABLE_BEHAVIOUR)).toMatchObject({ enabled: false, triggers: [] });
    expect(disabledBehaviourTools(broken)).toContain(TOOL);
    expect(triggerGate("triage-prs", undefined, broken).open).toBe(false);
    // With the definitions KNOWN, an unbound trigger still runs.
    expect(triggerGate("wake", undefined, broken).open).toBe(true);
  });

  it("with the definitions unknown, the synthetic behaviour gates EVERY trigger", () => {
    const list = effectiveBehaviours({ slug: "acme" }, unreadableRoot(new Error("Project not found: ")));
    expect(list.find((b) => b.name === CONFIG_UNREADABLE_BEHAVIOUR)?.triggers).toEqual(["*"]);
    expect(triggerGate("wake", undefined, list)).toMatchObject({ open: false, off: [CONFIG_UNREADABLE_BEHAVIOUR] });
  });

  it("behavioursFor treats a THROWING root read as unreadable, not as 'no Home definitions'", async () => {
    const projects = {
      get: async () => {
        throw new Error("Project not found: ");
      },
    };
    const list = await behavioursFor(projects, { slug: "acme", triggers: {} } as never);
    expect(triggerGate("anything", undefined, list).open).toBe(false);
  });

  it("the last-known-good definitions come back from disk after a restart", async () => {
    const dir = path.join(root, "home");
    await new BehaviourLkg().resolve({ slug: "", behaviours: HOME_DEFS }, dir);
    const fresh = new BehaviourLkg(); // a new process
    const got = await fresh.resolve({ slug: "", configError: "bad" }, dir);
    expect(got.behaviours).toEqual({ [B]: HOME_DEFS[B] });
    expect(got.behavioursUnknown).toBeUndefined();
    expect(fresh.resolveSync({ slug: "", configError: "bad" }, dir).behaviours).toEqual({ [B]: HOME_DEFS[B] });
    const none = await new BehaviourLkg().resolve({ slug: "", configError: "bad" }, path.join(root, "never-seen"));
    expect(none.behavioursUnknown).toBe(true);
  });
});

describe("#3 agent trigger guard", () => {
  const store = (root: { behaviours?: Record<string, BehaviourConfig> }) => ({
    get: async () => ({ slug: "", ...root }),
  });
  const ws = (triggers: Record<string, unknown>) =>
    ({ slug: "acme", dir: root, triggers }) as never as Parameters<ReturnType<typeof agentTriggerGuard>>[0];

  it("refuses a trigger bound by run.behaviour, one named in a behaviour, and one tombstoned", async () => {
    const s = store({ behaviours: HOME_DEFS });
    const current = ws({ drafter: { run: { prompt: "p", behaviour: B } }, plain: { run: { prompt: "p" } } });
    await expect(agentTriggerGuard(s, "remove_trigger", "drafter")(current)).rejects.toThrow(/is gated by "triage-external-prs"/);
    await expect(agentTriggerGuard(s, "set_trigger", "triage-prs")(current)).rejects.toThrow(/is gated/);
    await expect(agentTriggerGuard(s, "set_trigger", "plain")(current)).resolves.toBeUndefined();
    // (the built-in consolidate-memory's `consolidate` is a gated name too)
    expect([...(await readGatedTombstones(root))].sort()).toEqual(["consolidate", "drafter", "triage-prs"]);
    // drafter removed by a human: its name stays closed to agents.
    const after = ws({ plain: { run: { prompt: "p" } } });
    await expect(agentTriggerGuard(s, "set_trigger", "drafter")(after)).rejects.toThrow(/was gated by a behaviour before/);
  });

  it("the human guard only records, never refuses", async () => {
    const s = store({ behaviours: HOME_DEFS });
    await expect(humanTriggerGuard(s)(ws({ x: { run: { prompt: "p", behaviour: B } } }))).resolves.toBeUndefined();
    expect([...(await readGatedTombstones(root))].sort()).toEqual(["consolidate", "triage-prs", "x"]);
  });
});

describe("#5 autocommit stages only store-shaped files", () => {
  it("isOwnedStateFile matches the store grammar and nothing else", () => {
    for (const ok of [
      "tasks/open/t-260926-bleb.md",
      "tasks/done/2026-09/t-260926-bleb.md",
      "log/2026-09.md",
      "objectives/grow/objective.md",
      "objectives/grow/journal/2026-09.md",
      "memory/MEMORY.md",
      "memory/facts/a-fact.md",
      "memory/playbooks/p.md",
      "reports/status/current.md",
      "reports/status/2026-09-26.md",
      "runs/2026-09/r-260926-2352-4g.yaml",
      ".gitattributes",
    ])
      expect(isOwnedStateFile(ok), ok).toBe(true);
    for (const bad of [
      "tasks/open/zz-stray.txt",
      "tasks/open/notes.md",
      "log/notes.md",
      "memory/scratch.md",
      "runs/2026-09/r-260926-2352-4g.yaml.bak",
      "objectives/grow/notes.md",
      "tasks/x.md",
    ])
      expect(isOwnedStateFile(bad), bad).toBe(false);
  });

  it("a stray file dropped into tasks/open/ stays uncommitted (audit #5)", async () => {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.test");
    await fs.writeFile(path.join(root, ".gitkeep"), "");
    git("add", "-A");
    git("commit", "-qm", "init");
    const state = new ManagersState(root);
    const ac = new Autocommitter({ git: new GitService(root), enabled: true, debounceMs: 60_000 });
    state.writer.onWrite = (d, l, a, r) => ac.schedule(d, l, a, r);
    const dir = path.join(root, "acme");
    await fs.mkdir(path.join(dir, "tasks", "open"), { recursive: true });
    await fs.writeFile(path.join(dir, "tasks", "open", "zz-stray.txt"), "stray\n");
    const bot: WriteActor = { kind: "agent", name: "m", author: { name: "managers-bot", email: "b@l" } };
    const ws = { key: "acme", layout: state.layout(dir) };
    const t = await state.writer.upsertTask(ws, { title: "real" }, bot);
    expect((await ac.flush(dir))?.committed).toBe(true);
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
    expect(files).toContain(`acme/tasks/open/${t.id}.md`);
    expect(files).not.toContain("acme/tasks/open/zz-stray.txt");
    expect(git("status", "--porcelain", "--", "acme/tasks/open/zz-stray.txt")).toMatch(/^\?\?/);
    // A task closing (a delete + an add) still commits both sides.
    await state.writer.upsertTask(ws, { id: t.id, status: "done" }, bot);
    expect((await ac.flush(dir))?.committed).toBe(true);
    const moved = git("show", "--name-status", "--format=", "HEAD");
    // git may report it as a rename; either way both paths are in the commit.
    expect(moved).toContain(`acme/tasks/open/${t.id}.md`);
    expect(moved).toMatch(new RegExp(`acme/tasks/done/\\d{4}-\\d{2}/${t.id}\\.md`));
    expect(git("status", "--porcelain", "-uall", "--", `acme/tasks`)).toMatch(/^\?\? acme\/tasks\/open\/zz-stray\.txt$/);
  });
});

describe("#8 runs interrupted by a restart", () => {
  it("fails every run still running from before boot; a run started after boot is left alone", async () => {
    const state = new ManagersState(root);
    const dir = path.join(root, "acme");
    await fs.mkdir(dir, { recursive: true });
    const ws = { key: "acme", layout: state.layout(dir) };
    const a: WriteActor = { kind: "agent", name: "m", author: { name: "b", email: "b@l" } };
    const old = await state.writer.startRun(ws, { trigger: "hang", kind: "wake" }, a);
    const done = await state.writer.startRun(ws, { trigger: "ok", kind: "wake" }, a);
    await state.writer.finishRun(ws, done.id, { status: "succeeded" }, a);
    // Run timestamps are whole seconds; boot marks runs before it, so step past a second.
    const bootAt = new Date(Math.ceil((Date.now() + 1) / 1000) * 1000);
    await new Promise((r) => setTimeout(r, bootAt.getTime() - Date.now() + 1100));
    const fresh = await state.writer.startRun(ws, { trigger: "new", kind: "wake" }, a);
    const got = await failInterruptedRuns({ state, slug: "acme", dir, author: a.author, bootAt });
    expect(got).toEqual([old.id]);
    const raw = (f: string) => YAML.parse(execFileSync("cat", [path.join(dir, f)], { encoding: "utf8" }));
    expect(raw(old.file)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART });
    expect(raw(done.file)).toMatchObject({ status: "succeeded" });
    expect(raw(fresh.file)).toMatchObject({ status: "running" });
  });
});

describe("#11 History titles", () => {
  it("strips the preload (the M7 briefing) the way chat names do", () => {
    const briefing = "## Briefing\n- Project: acme-site\n## Protocol\nYou are this project's manager…";
    expect(runPrompt(wrapPreload(briefing, "Wake. Look at the open tasks."))).toBe("Wake. Look at the open tasks.");
    expect(runPrompt("plain prompt")).toBe("plain prompt");
    // A stored prompt truncated before the request marker never shows the briefing.
    expect(runPrompt(wrapPreload(briefing, "x").slice(0, 60))).toBeNull();
    expect(runPrompt(null)).toBeNull();
  });
});

describe("M9 gaps", () => {
  it("warns about bypassPermissions only where narrowing or gated tools exist", () => {
    const off = effectiveBehaviours({ slug: "acme" }, { slug: "", behaviours: HOME_DEFS });
    expect(configAlerts({ permissionMode: "bypassPermissions" }, off)).toMatchObject([
      { kind: "bypass-permissions", severity: "warning" },
    ]);
    expect(configAlerts({ permissionMode: "bypassPermissions", mcp: { paddock: { tools: ["x"] } } }, [])[0]?.message).toMatch(
      /connection tool list \(paddock\)/,
    );
    expect(configAlerts({ permissionMode: "default", mcp: { paddock: { tools: ["x"] } } }, off)).toEqual([]);
    expect(configAlerts({ permissionMode: "bypassPermissions" }, [])).toEqual([]);
  });

  it("sequesters MANAGERS_MCP_* out of an env while the resolver still sees them", () => {
    const env: NodeJS.ProcessEnv = { MANAGERS_MCP_PADDOCK_X: "Bearer s", MANAGERS_MCP_TOKEN_Y: "t", OTHER: "o" };
    try {
      expect(sequesterMcpSecrets(env)).toBe(2);
      expect(env).toEqual({ OTHER: "o" });
      expect(mcpResolveEnv().MANAGERS_MCP_PADDOCK_X).toBe("Bearer s");
    } finally {
      resetSequesteredMcpSecrets();
    }
    expect(mcpResolveEnv().MANAGERS_MCP_PADDOCK_X).toBeUndefined();
  });
});

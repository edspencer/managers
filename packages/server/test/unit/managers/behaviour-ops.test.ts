/**
 * Managers M8: agents get no tool to flip their own autonomy. A trigger's
 * `run.behaviour` binding IS autonomy (unbinding it ungates the trigger), so the
 * `set_trigger` op refuses any change to it; since M9.5 it refuses any edit of a
 * gated trigger at all (see trigger-guard.ts and managers-audit-fixes.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { buildManagementOps } from "../../../src/management-ops.js";
import { HUMAN_ROOT } from "../../../src/run-provenance.js";
import type { ChatHandlerContext } from "../../../src/ws-context.js";

const ALPHA = { slug: "alpha", name: "Alpha", dir: "/p/alpha", workingDir: "/p/alpha", status: "active" };
const gated = {
  name: "triage-prs",
  agentName: "trigger-alpha-triage-prs",
  trigger: { type: "schedule", cron: "0 7 * * *" },
  run: { prompt: "go", session: "new", tools: [], behaviour: "triage-external-prs" },
  enabled: true,
};

function ops() {
  // M14.5: the op hands the store a MERGE function, which the store evaluates
  // against the trigger it reads under the project.yaml lock (here: `gated`).
  const set = vi.fn(async (_s: string, name: string, rec: unknown) => {
    const r = typeof rec === "function" ? (rec as (e: unknown) => Record<string, unknown>)(gated) : (rec as Record<string, unknown>);
    return { name, agentName: "a", ...r };
  });
  const ctx = {
    deps: {
      projects: { list: async () => [ALPHA], get: async () => ALPHA },
      triggers: { get: async () => gated, set },
      herdctl: { listAgentSchedules: async () => [] },
      archive: { isArchived: async () => false },
      cfg: { keeperDriveMode: "session", maxSpawnDepth: 1 },
    },
    hub: { isRunning: () => false },
    startAgentTurn: async () => "unused",
    composePreloadedPrompt: async (_s: string, m: string) => m,
    fireTrigger: async () => null,
  } as unknown as ChatHandlerContext;
  const o = buildManagementOps(ctx, {
    currentProjectSlug: "alpha",
    currentSessionId: () => null,
    parentProvenance: HUMAN_ROOT,
    includeWrite: true,
    includeTriggers: true,
    includeProjects: false,
  });
  return { w: o.write!, set };
}

describe("set_trigger and run.behaviour (M8)", () => {
  it("refuses unbinding a gated trigger", async () => {
    const { w, set } = ops();
    await expect(w.setTrigger("alpha", "triage-prs", { run: { behaviour: undefined } })).rejects.toThrow(/run\.behaviour/);
  });
  it("refuses rebinding it to another behaviour", async () => {
    const { w, set } = ops();
    await expect(w.setTrigger("alpha", "triage-prs", { run: { behaviour: "something-on" } })).rejects.toThrow(
      /autonomy gate/,
    );
  });
  // M9.5 (audit #3): M8 let an agent edit a gated trigger's other fields, and
  // remove + recreate it unbound. Now a gated trigger is Ed's alone: the store
  // write runs the agent guard under the project.yaml lock, and it refuses.
  it("hands the store an agent guard that refuses ANY edit of a gated trigger", async () => {
    const { w, set } = ops();
    await w.setTrigger("alpha", "triage-prs", { enabled: false });
    expect(set).toHaveBeenCalledTimes(1);
    const guard = set.mock.calls[0]![3] as unknown as (current: unknown) => Promise<void>;
    expect(typeof guard).toBe("function");
    await expect(guard({ ...ALPHA, triggers: { "triage-prs": gated } })).rejects.toThrow(
      /set_trigger refused: trigger "triage-prs" is gated by "triage-external-prs"/,
    );
  });
});

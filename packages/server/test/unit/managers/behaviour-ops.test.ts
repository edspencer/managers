/**
 * Managers M8: agents get no tool to flip their own autonomy. A trigger's
 * `run.behaviour` binding IS autonomy (unbinding it ungates the trigger), so the
 * `set_trigger` op refuses any change to it, while other edits still merge.
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
  const set = vi.fn(async (_s: string, name: string, rec: Record<string, unknown>) => ({ name, agentName: "a", ...rec }));
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
    expect(set).not.toHaveBeenCalled();
  });
  it("refuses rebinding it to another behaviour", async () => {
    const { w, set } = ops();
    await expect(w.setTrigger("alpha", "triage-prs", { run: { behaviour: "something-on" } })).rejects.toThrow(
      /autonomy gate/,
    );
    expect(set).not.toHaveBeenCalled();
  });
  it("still allows an edit that leaves the binding alone", async () => {
    const { w, set } = ops();
    await w.setTrigger("alpha", "triage-prs", { enabled: false });
    expect(set).toHaveBeenCalledTimes(1);
    expect((set.mock.calls[0]![2] as { run: { behaviour: string } }).run.behaviour).toBe("triage-external-prs");
  });
});

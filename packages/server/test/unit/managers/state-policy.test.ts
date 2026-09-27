/**
 * Managers M5: policy over the state block (plan §2.3).
 *
 *   • the internal keeper may READ any workspace but WRITE only its own;
 *   • an external principal sees and reaches the state tools only by explicit grant;
 *   • `managementToolFilter` covers the new ops;
 *   • `memory_op` refuses unless Ed's own message drives the turn (M14: the origin alone is not enough).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ManagersState } from "../../../src/managers/state.js";
import { buildStateOps, MEMORY_OP_UNAVAILABLE, type ManagementStateOps } from "../../../src/managers/state-ops.js";
import { enforceManagementPolicy, managementToolFilter } from "../../../src/management-ops.js";
import {
  INTERNAL_PRINCIPAL,
  ManagementDeniedError,
  STATE_READ_OPERATIONS,
  STATE_WRITE_OPERATIONS,
  MEMORY_OPERATIONS,
  ALL_OPERATIONS,
  requiredOauthScope,
  type ManagementPrincipal,
} from "../../../src/management-policy.js";
import { selfMcpServerDef } from "../../../src/self-mcp.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let state: ManagersState;

beforeEach(async () => {
  root = await makeTmpDir("managers-policy-");
  for (const p of ["acme", "widget"]) await fs.mkdir(path.join(root, p), { recursive: true });
  state = new ManagersState(root);
});
afterEach(async () => {
  await rmTmpDir(root);
});

function ops(current: string, origin: "human" | "scheduled" | "external" = "scheduled"): ManagementStateOps {
  return buildStateOps({
    state,
    resolveDir: async (slug) => (slug === "" ? root : path.join(root, slug)),
    currentProjectSlug: current,
    currentSessionId: () => null,
    currentRunId: () => null,
    origin,
    botAuthor: { name: "managers-bot", email: "b@x" },
  });
}

const external = (allow: string[], projects = ["*"]): ManagementPrincipal => ({
  clientId: "ci",
  kind: "token",
  scope: { projects, allow, deny: [] },
});

describe("the internal keeper principal", () => {
  it("writes its own project", async () => {
    const s = enforceManagementPolicy({ state: ops("acme") }, INTERNAL_PRINCIPAL).state!;
    await expect(s.recordEpisode("acme", { text: "mine", importance: 3 })).resolves.toMatchObject({
      file: expect.stringMatching(/^log\//),
    });
  });

  it("is refused a write to another project — and nothing is written there", async () => {
    const s = enforceManagementPolicy({ state: ops("acme") }, INTERNAL_PRINCIPAL).state!;
    await expect(s.recordEpisode("widget", { text: "theirs", importance: 3 })).rejects.toBeInstanceOf(
      ManagementDeniedError,
    );
    await expect(s.upsertTask("widget", { title: "theirs" })).rejects.toThrow(/project "widget"/);
    await expect(s.upsertTask("", { title: "Home's" })).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(fs.readdir(path.join(root, "widget"))).resolves.toEqual([]);
  });

  it("may still READ another workspace", async () => {
    const s = enforceManagementPolicy({ state: ops("acme") }, INTERNAL_PRINCIPAL).state!;
    await expect(s.listTasks("widget")).resolves.toMatchObject({ tasks: [] });
  });
});

describe("an external principal", () => {
  it("without the grants: the state tools are hidden and the ops refuse", async () => {
    const p = external(["list_projects", "list_chats", "read_chat"]);
    const policed = enforceManagementPolicy({ state: ops("") }, p);
    const def = selfMcpServerDef({ state: policed.state }, { toolFilter: managementToolFilter(p) });
    expect(def.tools.map((t) => t.name)).toEqual([]);
    await expect(policed.state!.listTasks("acme")).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(policed.state!.recordEpisode("acme", { text: "x", importance: 1 })).rejects.toBeInstanceOf(
      ManagementDeniedError,
    );
  });

  it("with an explicit grant: sees exactly the granted tools and may write any in-scope project", async () => {
    const p = external(["list_tasks", "record_episode"], ["acme"]);
    const policed = enforceManagementPolicy({ state: ops("") }, p);
    const def = selfMcpServerDef({ state: policed.state }, { toolFilter: managementToolFilter(p) });
    expect(def.tools.map((t) => t.name).sort()).toEqual(["list_tasks", "record_episode"]);
    await expect(policed.state!.recordEpisode("acme", { text: "x", importance: 1 })).resolves.toBeDefined();
    await expect(policed.state!.recordEpisode("widget", { text: "x", importance: 1 })).rejects.toThrow(
      /project "widget"/,
    );
  });
});

describe("the catalogue", () => {
  it("knows every state/memory op, and the filter admits each only when granted", () => {
    for (const op of [...STATE_READ_OPERATIONS, ...STATE_WRITE_OPERATIONS, ...MEMORY_OPERATIONS]) {
      expect(ALL_OPERATIONS).toContain(op);
      expect(managementToolFilter(external([]))(op)).toBe(false);
      expect(managementToolFilter(external([op]))(op)).toBe(true);
      expect(managementToolFilter(INTERNAL_PRINCIPAL)(op)).toBe(true);
    }
  });

  it("state reads need the read OAuth scope; writes and memory need write", () => {
    for (const op of STATE_READ_OPERATIONS) expect(requiredOauthScope(op)).toBe("paddock:read");
    for (const op of [...STATE_WRITE_OPERATIONS, ...MEMORY_OPERATIONS]) {
      expect(requiredOauthScope(op)).toBe("paddock:write");
    }
  });

  it("every state tool assembled on the server is a catalogued operation", () => {
    const def = selfMcpServerDef({ state: ops("acme") });
    for (const t of def.tools) expect(ALL_OPERATIONS).toContain(t.name);
  });
});

describe("memory_op", () => {
  it("is refused outside a live human turn, even for a human-origin chat (M14)", async () => {
    const add = { op: "add" as const, name: "x", type: "user" as const, description: "d" };
    await expect(ops("acme", "scheduled").memoryOp("acme", add)).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
    // A wake replaying a human chat's tools carries origin "human" but no live flag.
    await expect(ops("acme", "human").memoryOp("acme", add)).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
  });

  it("surfaces as an error tool result, never a throw", async () => {
    const def = selfMcpServerDef({ state: ops("acme", "scheduled") });
    const tool = def.tools.find((t) => t.name === "memory_op")!;
    const r = await tool.handler({ op: "add", name: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("not available in this turn");
  });
});

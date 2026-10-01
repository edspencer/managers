/**
 * A task's `dispatched` list: the `upsert_task` tool exposes it (with its shape,
 * described), the handler passes it through to the writer, and each entry's chat
 * link is derived from its connection's url.
 */
import { describe, it, expect, vi } from "vitest";
import { stateTools } from "../../../src/self-mcp-state.js";
import { UPSERT_TASK_DESC } from "../../../src/self-mcp-descriptions.js";
import { dispatchChatHref, withDispatchLinks } from "../../../src/managers/dispatch-links.js";
import type { ManagementStateOps } from "../../../src/managers/state-ops.js";

function upsertTool(upsertTask = vi.fn(async () => ({ id: "t-260930-aaaa", file: "f", status: "open", created: true }))) {
  const state = { currentProjectSlug: "acme", upsertTask } as unknown as ManagementStateOps;
  const tool = stateTools(state).find((t) => t.name === "upsert_task")!;
  return { tool, upsertTask };
}

describe("upsert_task `dispatched`", () => {
  it("is in the tool's input schema with the {connection, project, chat, at} shape, and the description says to use it", () => {
    const { tool } = upsertTool();
    const prop = (tool.inputSchema as { properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }> })
      .properties.dispatched;
    expect(prop).toBeDefined();
    expect(Object.keys(prop!.properties!)).toEqual(["connection", "project", "chat", "at"]);
    expect(prop!.required).toEqual(["connection", "project", "chat"]);
    expect(UPSERT_TASK_DESC).toMatch(/dispatched: \{connection, project, chat\}/);
    expect(UPSERT_TASK_DESC).toMatch(/do not put chat ids in `notes`/);
  });

  it("passes an object, a list, or a JSON string through as a list; bad JSON is a tool error", async () => {
    const { tool, upsertTask } = upsertTool();
    const entry = { connection: "paddock", project: "herdctl", chat: "s1" };
    await tool.handler({ id: "t-260930-aaaa", dispatched: entry });
    await tool.handler({ id: "t-260930-aaaa", dispatched: [entry, { ...entry, chat: "s2" }] });
    await tool.handler({ id: "t-260930-aaaa", dispatched: JSON.stringify(entry) });
    await tool.handler({ id: "t-260930-aaaa" });
    const passed = upsertTask.mock.calls.map((c) => (c as unknown[])[1] as { dispatched?: unknown });
    expect(passed.map((p) => p.dispatched)).toEqual([[entry], [entry, { ...entry, chat: "s2" }], [entry], undefined]);

    const bad = await tool.handler({ id: "t-260930-aaaa", dispatched: "chat abc in herdctl" });
    expect(bad.isError).toBe(true);
    expect(upsertTask).toHaveBeenCalledTimes(4);
  });
});

describe("dispatchChatHref", () => {
  it("maps `<base>/mcp` to `<base>/projects/<project>/chat/<chat>`", () => {
    expect(dispatchChatHref("https://projects.example.test/mcp", "herdctl", "abc-1")).toBe(
      "https://projects.example.test/projects/herdctl/chat/abc-1",
    );
    expect(dispatchChatHref("https://x.test/paddock/mcp/", "p", "c")).toBe("https://x.test/paddock/projects/p/chat/c");
    expect(dispatchChatHref("http://127.0.0.1:7233", "p", "c")).toBe("http://127.0.0.1:7233/projects/p/chat/c");
    expect(dispatchChatHref("https://x.test/mcp", "a b", "c/d")).toBe("https://x.test/projects/a%20b/chat/c%2Fd");
  });

  it("gives no link without a plain http(s) url", () => {
    expect(dispatchChatHref(null, "p", "c")).toBeNull();
    expect(dispatchChatHref("env:MANAGERS_MCP_PADDOCK_URL", "p", "c")).toBeNull();
    expect(dispatchChatHref("https://x.test/mcp/<redacted>", "p", "c")).toBeNull();
    expect(dispatchChatHref("https://x.test/mcp?<redacted>", "p", "c")).toBeNull();
    expect(dispatchChatHref("javascript:alert(1)", "p", "c")).toBeNull();
    expect(dispatchChatHref("https://x.test/mcp", null, "c")).toBeNull();
    expect(dispatchChatHref("https://x.test/mcp", "p", null)).toBeNull();
  });

  it("withDispatchLinks resolves each entry by its connection name", () => {
    const out = withDispatchLinks(
      [
        { connection: "paddock", project: "p", chat: "c", at: null },
        { connection: "gone", project: "p", chat: "c", at: null },
        { connection: null, project: "p", chat: "c", at: null },
      ],
      [{ name: "paddock", url: "https://x.test/mcp" }],
    );
    expect(out.map((d) => d.href)).toEqual(["https://x.test/projects/p/chat/c", null, null]);
  });
});

import { describe, it, expect } from "vitest";
import {
  mcpToolInfo,
  parsePaddockManage,
  paddockManageSummary,
  chatTitle,
  firstLine,
  type PaddockManage,
} from "./mcpTools";

describe("mcpToolInfo", () => {
  it("passes a non-mcp tool through unchanged", () => {
    expect(mcpToolInfo("Read")).toEqual({
      isMcp: false,
      server: "",
      isPaddock: false,
      display: "Read",
      tool: "Read",
    });
  });

  it("humanizes a managers tool and flags provenance", () => {
    expect(mcpToolInfo("mcp__managers__create_chat")).toEqual({
      isMcp: true,
      server: "managers",
      isPaddock: true,
      display: "Create chat",
      tool: "create_chat",
    });
  });

  it("recognizes the paddock send_file server", () => {
    const info = mcpToolInfo("mcp__managers_files__send_file");
    expect(info.isPaddock).toBe(true);
    expect(info.display).toBe("Send file");
  });

  it("marks a third-party mcp tool as mcp but not paddock", () => {
    const info = mcpToolInfo("mcp__playwright__browser_click");
    expect(info.isMcp).toBe(true);
    expect(info.isPaddock).toBe(false);
    expect(info.display).toBe("Browser click");
  });

  it("treats a `paddock` connection as third-party, not one of Managers' own servers", () => {
    // Managers M1: `paddock` is freed to name a per-project connection to a real
    // Paddock instance, so it must not get the own-server treatment.
    const info = mcpToolInfo("mcp__paddock__create_chat");
    expect(info.isMcp).toBe(true);
    expect(info.server).toBe("paddock");
    expect(info.isPaddock).toBe(false);
  });
});

describe("parsePaddockManage", () => {
  it("returns null for a non-managers tool", () => {
    expect(parsePaddockManage("Read", "{}")).toBeNull();
    expect(parsePaddockManage("mcp__managers_files__send_file", "{}")).toBeNull();
  });

  it("returns null for missing or malformed output", () => {
    expect(parsePaddockManage("mcp__managers__list_chats", undefined)).toBeNull();
    expect(parsePaddockManage("mcp__managers__list_chats", "not json")).toBeNull();
    // Wrong shape (no chats array) → null so the caller shows the generic body.
    expect(parsePaddockManage("mcp__managers__list_chats", "{}")).toBeNull();
  });

  it("parses list_projects", () => {
    const out = JSON.stringify({
      count: 2,
      projects: [
        { slug: "paddock", name: "Paddock", area: "dev", status: "active" },
        { slug: "herdctl", name: "herdctl", status: "active" },
      ],
    });
    const pm = parsePaddockManage("mcp__managers__list_projects", out);
    expect(pm).toMatchObject({ tool: "list_projects", count: 2 });
    expect((pm as Extract<PaddockManage, { tool: "list_projects" }>).projects).toHaveLength(2);
  });

  it("parses list_chats and preserves the running flag", () => {
    const out = JSON.stringify({
      count: 1,
      project: "paddock",
      chats: [{ project: "paddock", sessionId: "abc123def", name: "Fix bug", running: true }],
    });
    const pm = parsePaddockManage("mcp__managers__list_chats", out) as Extract<
      PaddockManage,
      { tool: "list_chats" }
    >;
    expect(pm.tool).toBe("list_chats");
    expect(pm.project).toBe("paddock");
    expect(pm.chats[0].running).toBe(true);
  });

  it("parses read_chat with total/returned", () => {
    const out = JSON.stringify({
      project: "paddock",
      sessionId: "s1",
      total: 42,
      returned: 2,
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    });
    const pm = parsePaddockManage("mcp__managers__read_chat", out) as Extract<
      PaddockManage,
      { tool: "read_chat" }
    >;
    expect(pm).toMatchObject({ tool: "read_chat", total: 42, returned: 2 });
    expect(pm.messages).toHaveLength(2);
  });

  it("parses the write acks (create/fork/send) incl. echoed name/prompt", () => {
    expect(
      parsePaddockManage(
        "mcp__managers__create_chat",
        JSON.stringify({
          created: true,
          project: "paddock",
          sessionId: "new-1",
          name: "Worker",
          prompt: "do the thing",
        }),
      ),
    ).toEqual({
      tool: "create_chat",
      project: "paddock",
      sessionId: "new-1",
      name: "Worker",
      prompt: "do the thing",
    });

    expect(
      parsePaddockManage(
        "mcp__managers__fork_chat",
        JSON.stringify({
          forked: true,
          project: "paddock",
          sessionId: "child-1",
          from: "src-9",
          prompt: "focus on the CLI path",
        }),
      ),
    ).toMatchObject({ tool: "fork_chat", from: "src-9", prompt: "focus on the CLI path" });

    expect(
      parsePaddockManage(
        "mcp__managers__send_message",
        JSON.stringify({ sent: true, project: "paddock", sessionId: "s2", prompt: "ping" }),
      ),
    ).toEqual({ tool: "send_message", project: "paddock", sessionId: "s2", prompt: "ping" });
  });

  it("parses fork_chat_batch with per-fork prompts", () => {
    const out = JSON.stringify({
      count: 3,
      source: "src-1",
      forks: [
        { sessionId: "f1", prompt: "handle item 1" },
        { sessionId: "f2", prompt: "handle item 2" },
        { sessionId: "f3", prompt: "handle item 3" },
      ],
    });
    const pm = parsePaddockManage("mcp__managers__fork_chat_batch", out) as Extract<
      PaddockManage,
      { tool: "fork_chat_batch" }
    >;
    expect(pm.tool).toBe("fork_chat_batch");
    expect(pm.count).toBe(3);
    expect(pm.forks[1]).toEqual({ sessionId: "f2", prompt: "handle item 2" });
  });
});

describe("chatTitle / firstLine", () => {
  it("prefers an explicit name", () => {
    expect(chatTitle("My Chat", "some long prompt")).toBe("My Chat");
  });
  it("derives a title from the prompt's first non-blank line when no name", () => {
    expect(chatTitle(undefined, "\n  Investigate the reaper\nmore detail")).toBe(
      "Investigate the reaper",
    );
  });
  it("falls back when neither is present", () => {
    expect(chatTitle()).toBe("untitled chat");
  });
  it("truncates a long line", () => {
    expect(firstLine("x".repeat(200), 20)).toBe(`${"x".repeat(20)}…`);
  });
});

describe("paddockManageSummary", () => {
  it("uses the chat name/derived title for create + fork", () => {
    expect(
      paddockManageSummary({
        tool: "create_chat",
        project: "herdctl",
        sessionId: "s",
        name: "Reaper hunt",
      } as PaddockManage),
    ).toBe("Reaper hunt");
    expect(
      paddockManageSummary({
        tool: "fork_chat",
        project: "paddock",
        sessionId: "s",
        prompt: "focus on the CLI path\nand the SDK",
      } as PaddockManage),
    ).toBe("focus on the CLI path");
  });
  it("previews the sent message for send_message", () => {
    expect(
      paddockManageSummary({
        tool: "send_message",
        project: "paddock",
        sessionId: "s",
        prompt: "rerun the review please",
      } as PaddockManage),
    ).toBe("rerun the review please");
  });

  it("summarizes each tool for the header", () => {
    expect(
      paddockManageSummary({ tool: "list_projects", count: 3, projects: [] } as PaddockManage),
    ).toBe("3 projects");
    expect(
      paddockManageSummary({
        tool: "list_chats",
        count: 1,
        project: "paddock",
        chats: [],
      } as PaddockManage),
    ).toBe("1 chat in paddock");
    expect(
      paddockManageSummary({
        tool: "list_chats",
        count: 5,
        project: null,
        chats: [],
      } as PaddockManage),
    ).toBe("5 chats across all projects");
    expect(
      paddockManageSummary({
        tool: "fork_chat_batch",
        count: 4,
        source: "s",
        forks: [],
      } as PaddockManage),
    ).toBe("fanned out 4 chats");
  });
});

describe("Managers state tools (M5)", () => {
  const out = (o: unknown) => JSON.stringify(o);

  it("parses record_episode and summarizes it compactly", () => {
    const pm = parsePaddockManage(
      "mcp__managers__record_episode",
      out({ project: "acme", id: "ep-260926-0704-c7", file: "log/2026-09.md", importance: 6, objective: null }),
    );
    expect(pm).toMatchObject({ tool: "record_episode", id: "ep-260926-0704-c7", importance: 6 });
    expect(paddockManageSummary(pm!)).toBe("Recorded episode ep-260926-0704-c7 (imp 6)");
  });

  it("parses upsert_task, with created and moved variants", () => {
    const created = parsePaddockManage(
      "mcp__managers__upsert_task",
      out({ project: "acme", id: "t-260926-7k3f", file: "tasks/open/t-260926-7k3f.md", status: "awaiting-ed", created: true }),
    );
    expect(paddockManageSummary(created!)).toBe("Task t-260926-7k3f created → awaiting-ed");
    const moved = parsePaddockManage(
      "mcp__managers__upsert_task",
      out({
        id: "t-260926-7k3f",
        file: "tasks/done/2026-09/t-260926-7k3f.md",
        status: "done",
        created: false,
        movedFrom: "tasks/open/t-260926-7k3f.md",
      }),
    );
    expect(moved).toMatchObject({ movedFrom: "tasks/open/t-260926-7k3f.md" });
    expect(paddockManageSummary(moved!)).toBe("Task t-260926-7k3f → done");
  });

  it("parses list_alerts (M6), including the empty list", () => {
    const some = parsePaddockManage(
      "mcp__managers__list_alerts",
      out({
        project: "acme",
        count: 1,
        alerts: [{ id: "stale:publish-check", kind: "stale", trigger: "publish-check", severity: "warning", message: "m" }],
      }),
    );
    expect(some).toMatchObject({ tool: "list_alerts", count: 1 });
    expect(paddockManageSummary(some!)).toBe("1 alert");
    const none = parsePaddockManage("mcp__managers__list_alerts", out({ project: "acme", count: 0, alerts: [] }));
    expect(paddockManageSummary(none!)).toBe("No alerts");
    expect(parsePaddockManage("mcp__managers__list_alerts", out({ project: "acme" }))).toBeNull();
  });

  it("parses get_briefing (M7)", () => {
    const b = parsePaddockManage(
      "mcp__managers__get_briefing",
      out({
        project: "acme",
        objective: "grow",
        sections: [
          { name: "Header", chars: 120 },
          { name: "Open tasks", chars: 880 },
        ],
        text: "x".repeat(1234),
      }),
    );
    expect(b).toMatchObject({ tool: "get_briefing", objective: "grow", chars: 1234 });
    expect(paddockManageSummary(b!)).toBe("2 sections · 1,234 chars · grow");
    const noObj = parsePaddockManage("mcp__managers__get_briefing", out({ project: "acme", objective: null, sections: [] }));
    expect(paddockManageSummary(noObj!)).toBe("0 sections · 0 chars");
    expect(parsePaddockManage("mcp__managers__get_briefing", out({ project: "acme" }))).toBeNull();
  });

  it("parses the other state tools", () => {
    expect(
      paddockManageSummary(
        parsePaddockManage("mcp__managers__update_objective", out({ id: "grow", status: "active", created: false }))!,
      ),
    ).toBe("Objective grow updated");
    expect(
      paddockManageSummary(
        parsePaddockManage(
          "mcp__managers__write_report",
          out({ type: "status", date: "2026-09-26", file: "reports/status/2026-09-26.md", currentFile: "reports/status/current.md" }),
        )!,
      ),
    ).toBe("status report for 2026-09-26");
    expect(
      paddockManageSummary(
        parsePaddockManage("mcp__managers__list_tasks", out({ count: 2, tasks: [{ id: "t-1", title: "a", status: "open" }] }))!,
      ),
    ).toBe("2 tasks");
    expect(
      paddockManageSummary(parsePaddockManage("mcp__managers__list_memory", out({ facts: [{}], playbooks: [] }))!),
    ).toBe("1 fact, 0 playbooks");
  });

  it("an error result (plain text) falls back to the generic body", () => {
    expect(parsePaddockManage("mcp__managers__upsert_task", "Error: upserting the task: task: ask: awaiting-ed requires an ask")).toBeNull();
    expect(parsePaddockManage("mcp__managers__record_episode", out({ nope: true }))).toBeNull();
  });
});

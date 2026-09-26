/**
 * Managers M2: the fake `claude`'s `[[MCP <server>.<tool> <json-args>]]` directive.
 *
 * Drives the REAL stack end to end with zero Anthropic calls: a trigger's "Run now"
 * starts a batch-mode turn, herdctl exposes the injected `managers` self-MCP to the
 * spawned fake as a localhost HTTP bridge in `--mcp-config`, and the fake calls
 * `tools/call` on it through @modelcontextprotocol/sdk's client. The transcript it
 * writes must carry a paired `tool_use` / `tool_result` per call, and a failed call
 * must be an `is_error` result that does NOT stop the turn.
 *
 * This is the primitive later milestones use to QA wake loops (state tools, per-
 * project connections) without a model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import type { Project } from "../../src/projects.js";

type Line = {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type: string;
          id?: string;
          name?: string;
          input?: unknown;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
  };
};

async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === `${sessionId}.jsonl`) {
      return path.join((e as unknown as { parentPath: string }).parentPath, e.name);
    }
  }
  return null;
}

/** Poll until the session's transcript has its terminal `result` line. */
async function finishedTranscript(root: string, sessionId: string, timeoutMs = 30_000): Promise<Line[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await findTranscript(root, sessionId);
    if (file) {
      const lines = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Line);
      if (lines.some((l) => l.type === "result")) return lines;
    }
    if (Date.now() > deadline) throw new Error(`no finished transcript for ${sessionId}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Every tool call in the transcript, paired with its result, in order. */
function toolCalls(lines: Line[]) {
  const results = new Map<string, { content: unknown; is_error?: boolean }>();
  for (const l of lines) {
    if (l.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) {
      if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
    }
  }
  const calls: { name: string; input: unknown; content: unknown; isError: boolean | undefined }[] = [];
  for (const l of lines) {
    if (l.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id!);
      calls.push({ name: b.name!, input: b.input, content: r?.content, isError: r?.is_error });
    }
  }
  return calls;
}

function finalReply(lines: Line[]): string | undefined {
  const texts = lines
    .filter((l) => l.type === "assistant" && Array.isArray(l.message?.content))
    .flatMap((l) => (l.message!.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text"))
    .map((b) => b.text ?? "");
  return texts[texts.length - 1];
}

describe("integration: fake claude [[MCP …]] directive (Managers M2)", () => {
  let t: TestApp;
  let acme: Project;
  let widget: Project;

  beforeAll(async () => {
    // The `managers` self-MCP is still opt-in per instance until a later milestone
    // makes it always-on; the rig sets the same flag.
    t = await startTestApp({ sweepIntervalMs: 600_000, env: { MANAGERS_SELF_MCP: "1" } });
    const mk = async (name: string) =>
      ((await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } })).json() as { project: Project })
        .project;
    acme = await mk("Acme Site");
    widget = await mk("Widget Lib");
  });
  afterAll(async () => {
    await t.teardown();
  });

  async function runPrompt(name: string, prompt: string): Promise<Line[]> {
    await t.triggers.set(acme.slug, name, {
      // A far-off cron, disabled: only "Run now" fires it.
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt },
      enabled: false,
    });
    const res = await t.app.inject({ method: "POST", url: `/api/projects/${acme.slug}/triggers/${name}/run` });
    expect(res.statusCode).toBe(202);
    const { sessionId } = res.json() as { sessionId: string };
    return finishedTranscript(t.cfg.dataDir, sessionId);
  }

  it("calls managers.list_projects over the injected bridge and records the result", async () => {
    const lines = await runPrompt("mcp-ok", "QA [[MCP managers.list_projects {}]]");
    const calls = toolCalls(lines);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("mcp__managers__list_projects");
    expect(calls[0]!.input).toEqual({});
    expect(calls[0]!.isError).toBe(false);
    expect(typeof calls[0]!.content).toBe("string");
    expect(calls[0]!.content).toContain(acme.slug);
    expect(calls[0]!.content).toContain(widget.slug);
    const result = lines.find((l) => l.type === "result")!;
    expect(result.subtype).toBe("success");
    expect(finalReply(lines)).toBeTruthy();
  });

  it("an unknown server is an is_error result and the turn still completes", async () => {
    const lines = await runPrompt("mcp-nosuch", "[[MCP nosuch.tool {}]]");
    const calls = toolCalls(lines);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("mcp__nosuch__tool");
    expect(calls[0]!.isError).toBe(true);
    expect(String(calls[0]!.content)).toMatch(/not configured/);
    // …and it names the servers that WERE configured, which is what makes a typo debuggable.
    expect(String(calls[0]!.content)).toContain("managers");
    expect(lines.find((l) => l.type === "result")!.subtype).toBe("success");
    expect(finalReply(lines)).toBeTruthy();
  });

  it("runs repeated directives in order; an unknown tool or bad args errors without stopping later calls", async () => {
    const lines = await runPrompt(
      "mcp-seq",
      'first [[MCP managers.nope {}]] then [[MCP managers.list_projects {"x":[[1]]}]] then [[MCP managers.list_projects {oops}]] done',
    );
    const calls = toolCalls(lines);
    expect(calls.map((c) => c.name)).toEqual([
      "mcp__managers__nope",
      "mcp__managers__list_projects",
      "mcp__managers__list_projects",
    ]);
    // Unknown tool on a real server: the bridge's JSON-RPC error surfaces as is_error.
    expect(calls[0]!.isError).toBe(true);
    expect(String(calls[0]!.content)).toMatch(/nope/);
    // A `]]` inside the JSON args does not end the directive early.
    expect(calls[1]!.input).toEqual({ x: [[1]] });
    expect(calls[1]!.isError).toBe(false);
    expect(String(calls[1]!.content)).toContain(widget.slug);
    // Malformed args: reported, not silently skipped.
    expect(calls[2]!.isError).toBe(true);
    expect(String(calls[2]!.content)).toMatch(/invalid JSON/);
    expect(lines.find((l) => l.type === "result")!.subtype).toBe("success");
  });
});

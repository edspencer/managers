/**
 * Where a declared MCP server's `env` ACTUALLY ends up once a turn runs — read
 * off a real spawn rather than inferred from anybody's source.
 *
 * `mcp-servers.ts` keeps a resolved credential out of every surface paddock
 * owns: the boot log, an error message, the Settings API. That is complete, and
 * it is still not the whole story, because of what the engine does with the
 * record afterwards — and a process argument is not private on Linux:
 * `/proc/<pid>/cmdline` is world-readable by default and `ps` prints it.
 *
 * This is a **characterisation test** of what the engine does, observed from a
 * real spawn. Until @herdctl/core 5.33.2 the CLI runtime serialised the whole
 * `mcp_servers` map into one `--mcp-config '{"mcpServers":…}'` ARGUMENT, and this
 * test pinned that the token was readable in the spawned argv (the grounds for
 * `mcp-servers.ts`'s `argvExposure` boot warning). herdctl 5.33.2 (#467) writes
 * the config to an owner-only temp file and passes its PATH instead, so the
 * assertions now point the other way:
 *
 *  1. the argv carries a file path, and neither the config nor the token is in
 *     it;
 *  2. the file the child was pointed at holds the whole definition, credential
 *     included, and is mode 0600 — so the server still reaches the model and
 *     `mcp__notion__*` is still allowed (the half that makes the feature work).
 *
 * The `argvExposure` warning predates this and is now stale for the CLI
 * runtime's own spawn; removing it is a separate decision, not this test's.
 *
 * Coverage boundary, stated honestly: this is the CLI/batch runtime, the only
 * one whose argv is observable from outside a test — the SDK runtime resolves
 * its own bundled binary and never shells out. The SDK path does not have this
 * problem: it hands the same record to the SDK in-process, and the stdio server
 * it spawns gets the value in its environment, where `/proc/<pid>/environ` is
 * owner-only. That is where Claude Code itself puts it.
 *
 * The token is synthetic and exists only in this file. `npx-not-real` is never
 * started: the fake `claude` on PATH is what gets spawned, and it only records
 * the flags it was given.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SECRET = "ntn_SYNTHETIC_ARGV_SECRET_2222";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug;

interface Invocation {
  prompt: string;
  allowedTools: string | null;
  mcpConfig: string | null;
  mcpConfigFile: string | null;
  mcpConfigFileMode: string | null;
}

describe("integration: what a declared MCP server puts in the spawned argv (#691)", () => {
  let t: TestApp | undefined;
  let ws: WsClient | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await t?.teardown();
    t = undefined;
  });

  it("keeps the whole definition — credential included — off the command line under batch, in an owner-only file", async () => {
    const logPath = path.join(
      await fs.mkdtemp(path.join((await fs.realpath("/tmp")) + path.sep, "paddock-inv-")),
      "invocations.jsonl",
    );
    // The integration harness pins `driveMode: batch` (it drives turns through
    // the fake `claude`), which is exactly the runtime this test is about.
    t = await startTestApp({
      script: { "Hello there": "Hi!" },
      env: { MANAGERS_FAKE_INVOCATION_LOG: logPath, MANAGERS_TEST_NOTION_TOKEN: SECRET },
      configFile: {
        mcpServers: {
          notion: {
            command: "npx-not-real",
            env: { NOTION_TOKEN: "env:MANAGERS_TEST_NOTION_TOKEN" },
          },
        },
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Mcp Proj" } });
    const { port } = await listen(t.app);
    ws = await connectWs(port);

    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "mcp-proj", sessionId: null, message: "Hello there" },
    });
    await ws.waitFor(isComplete("mcp-proj"), { from: mark });

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    const turn = lines
      .map((l) => JSON.parse(l) as Invocation)
      .find((i) => i.prompt.includes("Hello there"));
    expect(turn, "the fake claude recorded no invocation for this turn").toBeDefined();

    // (1) The argv element is a file path now, not the config: neither the
    // definition nor the credential is on the command line (herdctl >= 5.33.2).
    expect(turn!.mcpConfig).toBeTruthy();
    expect(turn!.mcpConfig!.trim().startsWith("{")).toBe(false);
    expect(turn!.mcpConfig).not.toContain(SECRET);
    expect(turn!.mcpConfig).not.toContain("npx-not-real");

    // (2) The declared server still reached the process that runs the model:
    // declared in managers.config.yaml, resolved out of the environment, written
    // to the owner-only file the child was pointed at.
    expect(turn!.mcpConfigFile, "the --mcp-config file was unreadable while the turn ran").toBeTruthy();
    expect(turn!.mcpConfigFileMode).toBe("600");
    const parsed = JSON.parse(turn!.mcpConfigFile!) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers.notion.command).toBe("npx-not-real");
    expect(parsed.mcpServers.notion.env?.NOTION_TOKEN).toBe(SECRET);
    // …and it is callable: without this pattern every one of its tools is
    // auto-denied with no prompt and nothing in the logs.
    expect(turn!.allowedTools).toContain("mcp__notion__*");
  }, 30_000);
});

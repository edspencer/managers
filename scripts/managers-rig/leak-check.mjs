#!/usr/bin/env node
/**
 * leak-check.mjs — prove the SERVER neutralises an inherited Paddock environment.
 *
 *   node scripts/managers-rig/leak-check.mjs --out <scratch-dir> [--port <N>]
 *
 * Why this exists (M1 finding): the rig wrapper runs under `env -i` and serve.mjs
 * scrubs `PADDOCK_*` itself, so reading the rig server's /proc/<pid>/environ and
 * finding no `PADDOCK_*` proves nothing about the server — the vars never reached
 * it. This script seeds a throwaway rig and boots the server with synthetic,
 * Paddock-shaped vars deliberately injected AFTER serve.mjs's scrub
 * (`startServer({ leakEnv })`), then checks that the server's own boot scrub
 * (packages/server/src/env-scrub.ts) is what makes them harmless:
 *
 *   1. the vars really are in the server process's environ (else the test is vacuous);
 *   2. no Claude credential is, and HOME is the rig's;
 *   3. the server logs that it scrubbed them (count only);
 *   4. /api/projects answers 200 (PADDOCK_AUTH_MODE=jwt would 401) with the SEEDED
 *      projects (PADDOCK_PROJECTS_DIR points at /nonexistent);
 *   5. the served brand is Managers (PADDOCK_BRAND_NAME=Paddock would rebrand it);
 *   6. a real trigger turn's spawned fake `claude` inherited ZERO PADDOCK_* vars and
 *      completed an `[[MCP managers.list_projects {}]]` call against the seeded data.
 *
 * Independent of pm: pick a free --port (default 5098). Exits non-zero on any failure.
 * All leaked values are fake. Never point --out at real data (seed.mjs refuses).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const outArg = arg("out");
if (!outArg) {
  console.error("usage: leak-check.mjs --out <scratch-dir> [--port <N>]");
  process.exit(2);
}
const OUT = path.resolve(outArg);
const PORT = Number(arg("port", "5098"));

const LEAK = {
  PADDOCK_AUTH_MODE: "jwt",
  PADDOCK_DATA_DIR: "/nonexistent",
  PADDOCK_PROJECTS_DIR: "/nonexistent/projects",
  PADDOCK_BRAND_NAME: "Paddock",
  PADDOCK_MCP_TOKEN_QA: "not-a-real-token",
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

execFileSync(process.execPath, [path.join(HERE, "seed.mjs"), "--out", OUT], { stdio: "inherit" });
const logFile = path.join(OUT, "server.log");
const invocationLog = path.join(OUT, "invocations.jsonl");
const server = await startServer({
  dataDir: path.join(OUT, "data"),
  port: PORT,
  home: path.join(OUT, "home"),
  invocationLog,
  logFile,
  leakEnv: LEAK,
});

try {
  // 1–2. The server's real environment.
  const environ = fs
    .readFileSync(`/proc/${server.child.pid}/environ`, "utf8")
    .split("\0")
    .filter(Boolean)
    .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]);
  const names = environ.map(([k]) => k);
  const leaked = names.filter((k) => k.startsWith("PADDOCK_"));
  check(
    "leaked vars really reached the server process",
    leaked.length === Object.keys(LEAK).length,
    `${leaked.length} PADDOCK_* names in /proc/<pid>/environ`,
  );
  check(
    "no Claude credential in the server environ",
    !names.includes("CLAUDE_CODE_OAUTH_TOKEN") && !names.includes("ANTHROPIC_API_KEY"),
  );
  const home = environ.find(([k]) => k === "HOME")?.[1] ?? "";
  check("HOME is the rig's", home.startsWith(`${OUT}/`), home);

  // 3. The boot scrub logged it (count only).
  const log = fs.readFileSync(logFile, "utf8");
  const m = log.match(/env-scrub: removed (\d+) inherited PADDOCK_\*/);
  check("server logged its boot scrub", !!m && Number(m[1]) === leaked.length, m ? m[0] : "no env-scrub line");
  check("server log never prints a leaked value", !Object.values(LEAK).some((v) => v.length > 8 && log.includes(v)));

  // 4. Auth and data dir are Managers', not the leaked ones.
  const pr = await fetch(`${server.base}/api/projects`);
  const slugs = pr.ok ? ((await pr.json()).projects ?? []).map((p) => p.slug) : [];
  check("/api/projects is 200 (no jwt 401)", pr.status === 200, `status ${pr.status}`);
  check(
    "/api/projects lists the seeded projects",
    ["acme-site", "widget-lib", "empty-project"].every((s) => slugs.includes(s)),
    slugs.join(", "),
  );

  // 5. Brand.
  const html = await (await fetch(`${server.base}/`)).text();
  const cfg = html.match(/__MANAGERS_CONFIG__=(\{.*?\});/);
  check("served brand is Managers", !!cfg && /"Managers"/.test(cfg[1]) && !/Paddock/.test(cfg[1]), cfg ? cfg[1] : "no config");

  // 6. A real turn: the spawned child is clean and the MCP call works.
  const put = await fetch(`${server.base}/api/projects/acme-site/triggers/leak-check`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trigger: { type: "schedule", cron: "0 0 1 1 *" },
      run: { prompt: "leak check [[MCP managers.list_projects {}]]" },
      enabled: false,
    }),
  });
  check("trigger created", put.ok, `status ${put.status}`);
  const run = await fetch(`${server.base}/api/projects/acme-site/triggers/leak-check/run`, { method: "POST" });
  const sessionId = run.ok ? (await run.json()).sessionId : null;
  check("Run now started a chat", !!sessionId, `status ${run.status}`);

  const transcript = path.join(OUT, "data", "projects", "acme-site", ".chats", `${sessionId}.jsonl`);
  let lines = [];
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    if (fs.existsSync(transcript)) {
      lines = fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (lines.some((l) => l.type === "result")) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const toolResult = lines
    .flatMap((l) => (l.type === "user" && Array.isArray(l.message?.content) ? l.message.content : []))
    .find((b) => b.type === "tool_result");
  check(
    "turn's MCP call returned the seeded projects",
    !!toolResult && toolResult.is_error === false && String(toolResult.content).includes("widget-lib"),
    toolResult ? `is_error=${toolResult.is_error}` : "no tool_result",
  );
  const inv = fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const turn = inv.find((i) => (i.prompt ?? "").includes("leak check"));
  check(
    "spawned fake claude inherited 0 PADDOCK_* vars",
    !!turn && turn.paddockEnvCount === 0,
    turn ? `paddockEnvCount=${turn.paddockEnvCount}` : "no invocation recorded",
  );
  // M9.5: the rig sets MANAGERS_MCP_PADDOCK_* tokens for the server; no child may inherit one.
  check(
    "spawned fake claude inherited 0 MANAGERS_MCP_* vars",
    !!turn && turn.mcpSecretEnvCount === 0,
    turn ? `mcpSecretEnvCount=${turn.mcpSecretEnvCount}` : "no invocation recorded",
  );
} finally {
  server.stop();
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);

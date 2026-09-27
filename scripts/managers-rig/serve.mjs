/**
 * serve.mjs — boot the built Managers server against a seeded rig, credential-free.
 *
 *   node scripts/managers-rig/serve.mjs --data <rig>/data --port <N> [--home <rig>/home]
 *
 * Forked from scripts/demo-gif/serve.mjs (`demoEnv` → `rigEnv`). Used by the rig
 * wrapper (see README.md), by leak-check.mjs, and importable by any QA script.
 *
 * ── Why the environment is built from a whitelist ───────────────────────────
 * This box runs production Paddock, and its shell exports dozens of `PADDOCK_*`
 * (and, from Managers on, possibly `MANAGERS_*`) vars. Inherited, they would:
 *   • point the rig at production data (`*_DATA_DIR`, `*_PROJECTS_DIR`);
 *   • 401 every request (`*_AUTH_MODE=jwt`);
 *   • rebrand the UI (`*_BRAND_*`);
 *   • leak `*_MCP_TOKEN_*` values into every spawned child.
 * So we DELETE every `PADDOCK_*` / `MANAGERS_*`, plus `CLAUDE_CODE_OAUTH_TOKEN`,
 * `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `NODE_ENV`, then set exactly what the
 * rig needs. The credentials are absent ON PURPOSE: if a change ever slips a turn
 * back onto the SDK runtime it must fail loudly, not bill a real account.
 *
 * ── Why the fake `claude` wins ──────────────────────────────────────────────
 * `MANAGERS_DRIVE_MODE=batch` makes herdctl spawn `claude` from PATH, and
 * `test/bin` goes first on PATH. The fake answers deterministically and supports
 * the `[[MCP <server>.<tool> <json-args>]]` directive (see test/bin/claude), so QA
 * can drive real MCP tool calls with zero Anthropic calls.
 *
 * ── What the rig turns on ───────────────────────────────────────────────────
 *   (Since M5 there is no MANAGERS_SELF_MCP here: the `managers` MCP server is
 *    injected on every keeper and trigger turn for its state tools, and its
 *    chat-read block — list_projects/list_chats/read_chat — is on under the
 *    default `balanced` profile. The rig runs that default posture.)
 *   MANAGERS_FAKE_INVOCATION_LOG=<rig>/invocations.jsonl
 *                         one JSON line per fake-claude spawn: argv-derived flags,
 *                         the --mcp-config, and `paddockEnvCount` (a COUNT of
 *                         inherited PADDOCK_* vars — never names or values), and
 *                         `mcpSecretEnvCount` (M9.5: inherited MANAGERS_MCP_* vars,
 *                         which the server's boot sequester makes 0).
 *   HOST=127.0.0.1        forced, whatever the caller exported — unless
 *                         `--public` is passed (0.0.0.0 + MANAGERS_DANGEROUSLY_ALLOW_OPEN),
 *                         for a LAN-viewable demo of the synthetic fixtures only.
 *
 * ── The fake Paddock /mcp (M9) ──────────────────────────────────────────────
 * `fake-paddock-mcp.mjs` is spawned beside the server on PORT+1 (a free port if
 * that is taken) and killed with it. The rig's `mcp:` connections reach it via
 *   MANAGERS_RIG_PADDOCK_URL=http://127.0.0.1:<port>/mcp
 * and authenticate with SYNTHETIC tokens set here (never real ones):
 *   MANAGERS_MCP_PADDOCK_WIDGET_LIB="Bearer rig-token"     the right one
 *   MANAGERS_MCP_PADDOCK_WRONG_TOKEN="Bearer wrong-secret" the wrong-token fixture
 * `broken-conn` references MANAGERS_MCP_PADDOCK_BROKEN_CONN, which is left UNSET.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Variables that must never reach the rig, whatever the caller's env holds. */
export function isScrubbed(key) {
  return (
    key.startsWith("PADDOCK_") ||
    key.startsWith("MANAGERS_") ||
    key === "CLAUDE_CODE_OAUTH_TOKEN" ||
    key === "ANTHROPIC_API_KEY" ||
    key === "CLAUDE_CONFIG_DIR" ||
    key === "NODE_ENV"
  );
}

/**
 * Build the rig's child environment.
 *
 * `leakEnv` is for isolation QA ONLY (leak-check.mjs): variables merged in AFTER
 * the scrub, so a test can prove the SERVER's own boot scrub (env-scrub.ts) — not
 * this whitelist — is what neutralises an inherited Paddock environment. Without
 * it, checking the server's environ is vacuous: this function already stripped
 * everything. Never pass real values through it.
 */
export function rigEnv({ dataDir, port, home, fakeScript, invocationLog, leakEnv, paddockMcpUrl, publicBind = false }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!isScrubbed(k)) env[k] = v;

  env.HOME = home;
  env.PATH = `${path.join(REPO_ROOT, "test", "bin")}${path.delimiter}${env.PATH ?? "/usr/bin:/bin"}`;
  env.PORT = String(port);
  // Loopback unless `--public` (a LAN-viewable demo of synthetic data only). The
  // server refuses a non-loopback bind under auth=none without ALLOW_OPEN.
  env.HOST = publicBind ? "0.0.0.0" : "127.0.0.1";
  if (publicBind) env.MANAGERS_DANGEROUSLY_ALLOW_OPEN = "1";
  env.MANAGERS_DATA_DIR = dataDir;
  env.MANAGERS_PROJECTS_DIR = path.join(dataDir, "projects");
  env.MANAGERS_WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
  env.MANAGERS_DRIVE_MODE = "batch";
  env.MANAGERS_AUTH_MODE = "none";
  // M14.5: both are refused at boot without their explicit opt-ins
  // (packages/server/src/boot-posture.ts); a credential-free rig is their use.
  env.MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH = "1";
  env.MANAGERS_ALLOW_BATCH_DRIVE = "1";
  // The sweeper would rewrite seeded OVERVIEW.md/CHANGELOG.md mid-QA.
  env.MANAGERS_SWEEP_MIN_INTERVAL_MS = "999999999";
  env.LOG_LEVEL = env.LOG_LEVEL || "warn";
  // M9: the fake Paddock /mcp and the synthetic connection tokens (see the header).
  if (paddockMcpUrl) env.MANAGERS_RIG_PADDOCK_URL = paddockMcpUrl;
  env.MANAGERS_MCP_PADDOCK_WIDGET_LIB = "Bearer rig-token";
  env.MANAGERS_MCP_PADDOCK_WRONG_TOKEN = "Bearer wrong-secret";
  if (fakeScript) env.MANAGERS_FAKE_SCRIPT = fakeScript;
  if (invocationLog) env.MANAGERS_FAKE_INVOCATION_LOG = invocationLog;
  if (leakEnv) Object.assign(env, leakEnv);
  return env;
}

/**
 * Refuse to proceed if anything already holds the port. `/api/health` is answered
 * by ANY Paddock or Managers, so without this a stale server on the port looks like
 * a successful boot while our own child dies of EADDRINUSE. The fix is to fail
 * loudly, NEVER to kill the holder: production runs on this box, and pattern-
 * matching `node …/dist/index.js` would take it down too.
 */
async function assertPortFree(port) {
  const { createServer } = await import("node:net");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use. Pass a different --port; do not kill the holder.`)
          : err,
      ),
    );
    probe.once("listening", () => probe.close(resolve));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Spawn `fake-paddock-mcp.mjs` on `port` (0 = any free port) and resolve with its
 * url once it prints it. Rejects if it exits first (e.g. the port is taken).
 */
function spawnFakePaddock(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "fake-paddock-mcp.mjs"), "--port", String(port)], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      reject(new Error("fake Paddock MCP did not start within 15s"));
    }, 15_000);
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
      const m = /FAKE_PADDOCK_MCP_URL=(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1], stop: () => { try { child.kill("SIGTERM"); } catch {} } });
      }
    });
    child.stderr.on("data", (b) => (err = (err + b.toString("utf8")).slice(-2000)));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake Paddock MCP exited (code ${code}) ${err.trim().split("\n").pop() ?? ""}`));
    });
  });
}

/** The fake Paddock /mcp on PORT+1, or on any free port when that one is taken. */
export async function startFakePaddock(serverPort) {
  try {
    return await spawnFakePaddock(Number(serverPort) + 1);
  } catch {
    return spawnFakePaddock(0);
  }
}

/**
 * Spawn the built server and resolve once /api/health answers. Server output goes
 * to `logFile` and, when `echo` is set, to our own stdout/stderr too (so a process manager's logs
 * shows it).
 */
export async function startServer({ dataDir, port, home, fakeScript, invocationLog, leakEnv, logFile, echo = false, paddockMcpUrl, publicBind = false }) {
  const entry = path.join(REPO_ROOT, "packages", "server", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Server build missing at ${entry}\nRun:  scripts/clean-env.sh npm run build`);
  }
  await assertPortFree(port);

  const log = logFile ? fs.createWriteStream(logFile, { flags: "w" }) : null;
  const child = spawn(process.execPath, [entry], {
    env: rigEnv({ dataDir, port, home, fakeScript, invocationLog, leakEnv, paddockMcpUrl, publicBind }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  let tail = "";
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on("data", (buf) => {
      log?.write(buf);
      if (echo) sink.write(buf);
      tail = (tail + buf.toString("utf8")).slice(-4000);
    });
  }

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (code ${child.exitCode})\n--- server output ---\n${tail}`);
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      try {
        child.kill("SIGTERM");
      } catch {}
      throw new Error(`Server did not become healthy at ${base}\n--- server output ---\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    child,
    base,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}

// Standalone: the rig wrapper's entry point.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? dflt : process.argv[i + 1];
  };
  const dataArg = arg("data");
  const portArg = arg("port", process.env.PORT);
  if (!dataArg || !portArg) {
    console.error("usage: serve.mjs --data <rig>/data --port <N> [--home <rig>/home]");
    process.exit(2);
  }
  const dataDir = path.resolve(dataArg);
  const rigDir = path.dirname(dataDir);
  const port = Number(portArg);
  const home = path.resolve(arg("home", path.join(rigDir, "home")));
  const fakeScript = arg("fake-script", path.join(rigDir, "fake-script.json"));

  let server;
  let fakePaddock;
  try {
    fakePaddock = await startFakePaddock(port);
    console.log(`Fake Paddock MCP up: ${fakePaddock.url}`);
    server = await startServer({
      paddockMcpUrl: fakePaddock.url,
      dataDir,
      port,
      home,
      fakeScript: fs.existsSync(fakeScript) ? fakeScript : undefined,
      invocationLog: path.join(rigDir, "invocations.jsonl"),
      logFile: path.join(rigDir, "server.log"),
      echo: true,
      publicBind: process.argv.includes("--public"),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    fakePaddock?.stop();
    process.exit(1);
  }
  const stopAll = () => {
    server.stop();
    fakePaddock.stop();
  };
  // Take the child down with us, and go down with it: an orphaned server keeps the
  // port and answers the next run's health check with stale data.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      stopAll();
      process.exit(0);
    });
  }
  process.on("exit", stopAll);
  fakePaddock.child.on("exit", (code) => console.error(`Fake Paddock MCP exited (code ${code})`));
  server.child.on("exit", (code, signal) => {
    console.error(`Managers rig server exited (code ${code}, signal ${signal})`);
    process.exit(code ?? 1);
  });
  console.log(`Managers rig up: ${server.base}  (server pid ${server.child.pid})`);
}

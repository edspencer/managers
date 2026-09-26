/**
 * serve.mjs — boot the built Managers server against a seeded rig, credential-free.
 *
 *   node scripts/managers-rig/serve.mjs --data <rig>/data --port <N> [--home <rig>/home]
 *
 * Forked from scripts/demo-gif/serve.mjs (`demoEnv` → `rigEnv`). Used by the pm
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
 *                         inherited PADDOCK_* vars — never names or values).
 *   HOST=127.0.0.1        forced, whatever pm or the caller exported.
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
export function rigEnv({ dataDir, port, home, fakeScript, invocationLog, leakEnv }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!isScrubbed(k)) env[k] = v;

  env.HOME = home;
  env.PATH = `${path.join(REPO_ROOT, "test", "bin")}${path.delimiter}${env.PATH ?? "/usr/bin:/bin"}`;
  env.PORT = String(port);
  env.HOST = "127.0.0.1";
  env.MANAGERS_DATA_DIR = dataDir;
  env.MANAGERS_PROJECTS_DIR = path.join(dataDir, "projects");
  env.MANAGERS_WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
  env.MANAGERS_DRIVE_MODE = "batch";
  env.MANAGERS_AUTH_MODE = "none";
  // The sweeper would rewrite seeded OVERVIEW.md/CHANGELOG.md mid-QA.
  env.MANAGERS_SWEEP_MIN_INTERVAL_MS = "999999999";
  env.LOG_LEVEL = env.LOG_LEVEL || "warn";
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
 * Spawn the built server and resolve once /api/health answers. Server output goes
 * to `logFile` and, when `echo` is set, to our own stdout/stderr too (so `pm logs`
 * shows it).
 */
export async function startServer({ dataDir, port, home, fakeScript, invocationLog, leakEnv, logFile, echo = false }) {
  const entry = path.join(REPO_ROOT, "packages", "server", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Server build missing at ${entry}\nRun:  scripts/clean-env.sh npm run build`);
  }
  await assertPortFree(port);

  const log = logFile ? fs.createWriteStream(logFile, { flags: "w" }) : null;
  const child = spawn(process.execPath, [entry], {
    env: rigEnv({ dataDir, port, home, fakeScript, invocationLog, leakEnv }),
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

// Standalone: the pm wrapper's entry point.
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
  try {
    server = await startServer({
      dataDir,
      port,
      home,
      fakeScript: fs.existsSync(fakeScript) ? fakeScript : undefined,
      invocationLog: path.join(rigDir, "invocations.jsonl"),
      logFile: path.join(rigDir, "server.log"),
      echo: true,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  // Take the child down with us, and go down with it: an orphaned server keeps the
  // port and answers the next run's health check with stale data.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      server.stop();
      process.exit(0);
    });
  }
  process.on("exit", server.stop);
  server.child.on("exit", (code, signal) => {
    console.error(`Managers rig server exited (code ${code}, signal ${signal})`);
    process.exit(code ?? 1);
  });
  console.log(`Managers rig up: ${server.base}  (server pid ${server.child.pid})`);
}

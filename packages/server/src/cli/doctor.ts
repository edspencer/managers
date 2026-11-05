/**
 * `managers doctor [--json] [--offline]` — CLI contract SPEC §1's checks, one
 * `✓` / `!` / `✗` line each, with a `fix:` line under every failure. Exit 1 if
 * any check failed; warnings don't change it.
 *
 * Modelled on Local Review's `server/doctor.ts` (D2b), against Managers' own
 * service layer: the unit checks are the warnings `service status` already
 * computes (one `StatusReport`, so the two can never disagree).
 *
 * The spec's eight ids come first, in its order: `node-engines`,
 * `install-method`, `unit`, `running-version`, `port`, `linger`, `data-home`,
 * `update`. Then Managers' own:
 *
 *  - **`config`** — the configuration this shell resolves loads at all. A
 *    config `serve` would refuse is the likeliest reason a service that was
 *    installed fine never comes up.
 *  - **`security`** — `/api/security`'s checks, folded in (ROADMAP: "doctor,
 *    with `/api/security`'s checks"). One line per dangerous setting the
 *    instance runs with — no authentication, `trusted-header`, a JWT with any
 *    audience, batch drive mode — each a warning, because every one of them is
 *    an explicit opt-in rather than a mistake. A running instance is asked
 *    (its answer is the truth about what IT booted with); with none running,
 *    the posture this shell's configuration would boot with is computed by the
 *    same `evaluateBootPosture` the server runs, and a configuration the server
 *    would refuse is a failure.
 *
 * It only reads, apart from `<data-dir>/update-check.json`: like
 * `update --check`, it writes what it found there, so `service status` can
 * repeat it (SPEC §3). It asks the npm registry only because a person ran it,
 * and `--offline` doesn't.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  describeInstall,
  detectInstall,
  findPackageRoot,
  updateCommand,
  type InstallInfo,
} from "./update/install-method.js";
import { fetchHealth } from "./update/health.js";
import { npmConfigGet, npmGlobalRoot } from "./update/package-manager.js";
import { RegistryError, resolveRegistry, resolveTarget } from "./update/registry.js";
import { readLiveRuntimeFile } from "../runtime-file.js";
import { compareVersions, isPrerelease, satisfiesEngines } from "./update/semver.js";
import { updateNotice, writeUpdateCheck } from "./update/update-check.js";
import { MANAGERS_IMAGE, MANAGERS_PACKAGE, managersChangelogUrl } from "./update-command.js";
import { DEFAULT_PORT } from "./service/spec.js";
import { serviceStatusReport, type ServiceContext, type StatusReport } from "./service/index.js";
import type { PostureWarning } from "../boot-posture.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface Check {
  /** Stable, for scripts: the spec's eight, then `config` and `security`. */
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

/** The fallback when the package's own `engines` can't be read (a checkout, a test). */
const ENGINES_FALLBACK = ">=22";

/** What the server's posture says, or why it couldn't be read. */
export type SecurityReading =
  | { kind: "answer"; warnings: PostureWarning[]; authMode?: string }
  | { kind: "auth-required" }
  | { kind: "refused"; message: string }
  | { kind: "unknown"; message: string };

export interface DoctorInput {
  ctx: ServiceContext;
  /** This CLI's version. */
  version: string;
  /** This invocation's data dir (`--data-dir`, `MANAGERS_DATA_DIR`, else `~/.managers`). */
  dataDir: string;
  /** `process.argv[1]`, for SPEC §6's walk-up. */
  entry: string;
  env: NodeJS.ProcessEnv;
  offline?: boolean;
  // ---- seams, for tests -------------------------------------------------
  nodeVersion?: string;
  /** The package's `engines.node`; read from its package.json when omitted. */
  engines?: string;
  npmGlobalRoot?: () => string | undefined;
  registry?: string;
  fetch?: typeof fetch;
  isListening?: (port: number) => Promise<boolean>;
  /** Linux's linger for this user: true, false, or null when loginctl can't say. */
  linger?: () => Promise<boolean | null>;
  /** The service report; `serviceStatusReport(ctx)` when omitted. */
  status?: () => Promise<StatusReport>;
  /** Whether the configuration this shell resolves loads: undefined, or why not. */
  configProblem?: () => Promise<string | undefined>;
  /** The posture this shell's configuration would boot with (no instance running). */
  localPosture?: () => Promise<SecurityReading>;
}

const tildify = (p: string, home: string): string =>
  p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;

export async function diagnose(i: DoctorInput): Promise<{ checks: Check[]; notice?: string }> {
  const checks: Check[] = [];
  const add = (c: Check): void => {
    checks.push(c);
  };
  const t = (p: string): string => tildify(p, i.ctx.homeDir);
  const doFetch = i.fetch ?? fetch;
  let notice: string | undefined;

  // ---- this Node against the package's engines
  const nodeVersion = i.nodeVersion ?? process.versions.node;
  const enginesRange = i.engines ?? packageEngines(i.entry) ?? ENGINES_FALLBACK;
  const engines = satisfiesEngines(nodeVersion, { node: enginesRange });
  if (engines.ok === false) {
    add({
      id: "node-engines",
      status: "fail",
      message: `Node ${nodeVersion} is too old: Managers ${i.version} needs Node ${enginesRange}`,
      fix: `install Node ${enginesRange} (nvm, fnm, Homebrew, …), then run managers with it`,
    });
  } else {
    add({ id: "node-engines", status: "pass", message: `Node ${nodeVersion} (Managers needs ${enginesRange})` });
  }

  // ---- how it was installed (SPEC §6)
  const info: InstallInfo = detectInstall({
    packageName: MANAGERS_PACKAGE,
    envPrefix: "MANAGERS",
    entry: i.entry,
    env: i.env,
    npmGlobalRoot: i.npmGlobalRoot ?? (() => npmGlobalRoot({ env: i.env })),
  });
  const how = describeInstall(info, MANAGERS_PACKAGE);
  if (info.canUpdate) {
    add({
      id: "install-method",
      status: "pass",
      message: `Managers ${i.version}, ${how}: \`managers update\` can update it`,
    });
  } else {
    const cmd = updateCommand(info, { packageName: MANAGERS_PACKAGE, image: MANAGERS_IMAGE });
    add({
      id: "install-method",
      status: "warn",
      message: `Managers ${i.version}, ${how}: \`managers update\` can't update it`,
      fix: `${cmd.command}${cmd.note ? `    (${cmd.note})` : ""}`,
    });
  }

  // ---- the service: what `service status` warns about
  let report: StatusReport | null = null;
  try {
    report = await (i.status ?? (() => serviceStatusReport(i.ctx)))();
  } catch (e) {
    add({ id: "unit", status: "skip", message: (e as Error).message.split("\n")[0] ?? String(e) });
  }
  if (report && !report.installed) {
    add({
      id: "unit",
      status: "skip",
      message: "it isn't installed as a service (`managers service install` runs it in the background)",
    });
  } else if (report) {
    // The running-version and linger warnings have checks of their own below.
    const warnings = report.warnings.filter((w) => !/^It is running /.test(w) && !/^Lingering is off/.test(w));
    if (warnings.length === 0) {
      add({ id: "unit", status: "pass", message: `the service is installed (${report.manager}): ${t(report.unit)}` });
    }
    for (const w of warnings) {
      add(
        /not there any more/.test(w)
          ? { id: "unit", status: "fail", message: w, fix: "`managers service install` (it keeps the port and the data dir)" }
          : { id: "unit", status: "warn", message: w },
      );
    }
  }

  // ---- the running version is the installed one: the service's, or a `serve` in a terminal
  const home = report?.installed && report.dataDir ? report.dataDir : i.dataDir;
  const live = readLiveRuntimeFile(home);
  const running =
    report?.answering === true
      ? { version: report.runningVersion, where: report.url ?? "the service", installed: report.installedVersion, via: "service" as const }
      : live
        ? { version: live.version, where: live.url, installed: i.version, via: "serve" as const }
        : null;
  if (!running) {
    add({ id: "running-version", status: "skip", message: "Managers isn't running" });
  } else if (running.version && running.installed && running.version !== running.installed) {
    add({
      id: "running-version",
      status: "fail",
      message: `${running.where} is running ${running.version}, but ${running.installed} is installed: it's still running the code it started with`,
      fix:
        running.via === "service"
          ? "`managers service restart`"
          : "stop the `managers serve` in its terminal (Ctrl-C) and start it again",
    });
  } else {
    add({
      id: "running-version",
      status: "pass",
      message: `${running.where} is running ${running.version ?? "an unknown version"}${running.via === "serve" ? " (in a terminal)" : ""}`,
    });
  }

  // ---- the port: free, or held by Managers
  const port = report?.port ?? live?.port ?? Number(DEFAULT_PORT);
  const listening = await (i.isListening ?? defaultIsListening)(port);
  const health = listening ? await fetchHealth({ url: `http://127.0.0.1:${port}`, fetch: doFetch }) : undefined;
  if (!listening) add({ id: "port", status: "pass", message: `port ${port} is free` });
  else if (health) {
    add({ id: "port", status: "pass", message: `port ${port} is Managers'${health.version ? ` (${health.version})` : ""}` });
  } else {
    add({
      id: "port",
      status: "fail",
      message: `something that isn't Managers is listening on port ${port}`,
      fix: report?.installed
        ? "stop it, or move the service: `managers service install --port <n>`"
        : "stop it, or run Managers on another port: `managers serve --port <n>`",
    });
  }

  // ---- linger, on Linux: without it the service stops when you log out
  if (i.ctx.platform !== "linux") add({ id: "linger", status: "skip", message: "linger is a Linux thing" });
  else {
    const user = i.env.USER || safeUser();
    const on = await (i.linger ?? (() => lingerOf(user)))();
    if (on === true) {
      add({ id: "linger", status: "pass", message: `linger is on for ${user}: the service runs while you're logged out, and starts at boot` });
    } else if (on === false && report?.installed) {
      add({
        id: "linger",
        status: "warn",
        message: `linger is off for ${user}: the service stops when you log out, and starts only when you log in`,
        fix: `sudo loginctl enable-linger ${user}`,
      });
    } else if (on === false) {
      add({ id: "linger", status: "pass", message: `linger is off for ${user}, which only matters once it's a service (then: sudo loginctl enable-linger ${user})` });
    } else add({ id: "linger", status: "skip", message: "couldn't ask loginctl about linger" });
  }

  // ---- the data dir
  const writable = writableOrCreatable(home);
  if (writable === true) add({ id: "data-home", status: "pass", message: `the data dir ${t(home)} is writable` });
  else if (writable === "creatable") {
    add({ id: "data-home", status: "pass", message: `the data dir ${t(home)} doesn't exist yet; it's made the first time Managers starts` });
  } else {
    add({
      id: "data-home",
      status: "fail",
      message: `the data dir ${t(home)} isn't writable: ${writable}`,
      fix: "check its permissions, or use another one with --data-dir <path> (or MANAGERS_DATA_DIR)",
    });
  }

  // ---- a newer version (SPEC §1): the only check that asks the network, and --offline skips it
  if (i.offline) add({ id: "update", status: "skip", message: "not asking the registry for a newer version (--offline)" });
  else {
    try {
      const target = await resolveTarget({
        packageName: MANAGERS_PACKAGE,
        registry: i.registry ?? resolveRegistry(i.env, (k) => npmConfigGet(k, { env: i.env })),
        fetch: doFetch,
      });
      const cmp = compareVersions(target.version, i.version);
      const available = cmp > 0 && !isPrerelease(target.version);
      const cmd = info.canUpdate
        ? { command: "managers update" }
        : updateCommand(info, { packageName: MANAGERS_PACKAGE, target: target.version, image: MANAGERS_IMAGE });
      try {
        // The cache `service status` repeats. Never creates the data dir: a
        // doctor run on a machine that has never started Managers is a reading,
        // not a first start.
        if (fs.existsSync(home)) {
          writeUpdateCheck(home, {
            name: "managers",
            current: i.version,
            target: target.version,
            tag: target.tag,
            updateAvailable: available,
            installMethod: info.method,
            canUpdate: info.canUpdate,
            command: available ? cmd.command : null,
            engines: target.engines,
            nodeOk: satisfiesEngines(nodeVersion, target.engines !== null ? { node: target.engines } : undefined).ok !== false,
            changelog: managersChangelogUrl(target.version),
            checkedAt: new Date().toISOString(),
          });
        }
      } catch {
        /* a cache that can't be written is not a doctor finding */
      }
      if (available) {
        notice = updateNotice({
          name: "Managers",
          current: i.version,
          target: target.version,
          command: cmd.command,
          ...(cmd.note ? { note: cmd.note } : {}),
          changelog: managersChangelogUrl(target.version),
        });
        add({ id: "update", status: "warn", message: `Managers ${target.version} is available (you have ${i.version})`, fix: cmd.command });
      } else {
        add({
          id: "update",
          status: "pass",
          message: cmp < 0 ? `${i.version} is newer than the registry's latest (${target.version})` : `${i.version} is the latest`,
        });
      }
    } catch (e) {
      add({
        id: "update",
        status: "warn",
        message: `couldn't ask the registry for a newer version: ${e instanceof RegistryError ? `${e.message} (${e.url})` : (e as Error).message}`,
        fix: "check your network, or skip this check with --offline",
      });
    }
  }

  // ---- Managers' own: the configuration loads
  const configProblem = await (i.configProblem ?? (() => defaultConfigProblem(i.dataDir)))();
  if (configProblem === undefined) {
    add({ id: "config", status: "pass", message: "the configuration loads (`managers config show` prints it)" });
  } else {
    add({
      id: "config",
      status: "fail",
      message: `the configuration won't load, so \`managers serve\` would refuse to start: ${configProblem}`,
      fix: "`managers config show` names the setting; fix it in managers.config.yaml or the environment",
    });
  }

  // ---- Managers' own: /api/security's checks
  const security = await readSecurity({
    url: running?.where.startsWith("http") ? running.where : undefined,
    fetch: doFetch,
    local: i.localPosture ?? (() => defaultLocalPosture(i.dataDir, i.env)),
    skipLocal: configProblem !== undefined,
  });
  const where = running?.where.startsWith("http") ? `${running.where} runs` : "this configuration would run";
  if (security.kind === "auth-required") {
    add({ id: "security", status: "pass", message: `${running?.where ?? "the instance"} requires authentication` });
  } else if (security.kind === "refused") {
    add({
      id: "security",
      status: "fail",
      message: `\`managers serve\` would refuse this configuration: ${security.message}`,
      fix: "set MANAGERS_AUTH_MODE=jwt (see AUTH.md); with no auth, `managers serve` runs only on a loopback bind (--host 127.0.0.1, and no HOST=0.0.0.0 in the environment)",
    });
  } else if (security.kind === "unknown") {
    add({ id: "security", status: "skip", message: `couldn't read the security posture: ${security.message}` });
  } else if (security.warnings.length === 0) {
    add({ id: "security", status: "pass", message: `${where} with authentication on, and no dangerous setting opted into` });
  } else {
    for (const w of security.warnings) {
      add({ id: "security", status: "warn", message: `${where} with ${w.title}: ${w.detail}`, fix: securityFix(w) });
    }
  }

  return { checks, ...(notice ? { notice } : {}) };
}

function securityFix(w: PostureWarning): string {
  switch (w.code) {
    case "no-auth":
      return "set MANAGERS_AUTH_MODE=jwt (see AUTH.md) to close it; it's the laptop default on a loopback bind";
    case "trusted-header":
      return "prefer MANAGERS_AUTH_MODE=jwt, which a process on this host can't forge (see AUTH.md)";
    case "jwt-any-audience":
      return "set MANAGERS_AUTH_JWT_AUDIENCE and drop MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE";
    case "batch-drive":
      return "drop MANAGERS_DRIVE_MODE=batch and MANAGERS_ALLOW_BATCH_DRIVE, so turns run on the SDK session runtime";
  }
}

/** Ask the running instance's `/api/security`, else compute the posture this shell would boot with. */
async function readSecurity(o: {
  url: string | undefined;
  fetch: typeof fetch;
  local: () => Promise<SecurityReading>;
  skipLocal: boolean;
}): Promise<SecurityReading> {
  if (o.url !== undefined) {
    try {
      const res = await o.fetch(new URL("/api/security", o.url), { signal: AbortSignal.timeout(3_000) });
      if (res.status === 401 || res.status === 403) return { kind: "auth-required" };
      if (res.ok) {
        const body = (await res.json()) as { warnings?: PostureWarning[]; authMode?: string };
        return {
          kind: "answer",
          warnings: Array.isArray(body.warnings) ? body.warnings : [],
          ...(body.authMode !== undefined ? { authMode: body.authMode } : {}),
        };
      }
      // An older Managers (404) falls through to the local reading.
    } catch {
      /* not answering: fall through */
    }
  }
  if (o.skipLocal) return { kind: "unknown", message: "the configuration doesn't load (see the config check)" };
  return o.local();
}

/** The posture `serve` would boot with from this shell, by the server's own rule (boot-posture.ts). */
async function defaultLocalPosture(dataDir: string, env: NodeJS.ProcessEnv): Promise<SecurityReading> {
  try {
    const cfg = await loadConfigFor(dataDir);
    const { bootPostureInput, evaluateBootPosture } = await import("../boot-posture.js");
    // The CLI's laptop default (start.ts `loopbackNoAuth`): allowed when nobody
    // set MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH either way.
    const d = evaluateBootPosture(
      bootPostureInput(cfg, { loopbackNoAuth: env.MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH === undefined }),
    );
    if (d.action === "refuse") {
      return { kind: "refused", message: `${d.message.split("\n")[0] ?? d.message} (bind address: ${cfg.host})` };
    }
    return { kind: "answer", warnings: d.posture.warnings, authMode: d.posture.authMode };
  } catch (e) {
    return { kind: "unknown", message: (e as Error).message.split("\n")[0] ?? String(e) };
  }
}

async function defaultConfigProblem(dataDir: string): Promise<string | undefined> {
  try {
    await loadConfigFor(dataDir);
    return undefined;
  } catch (e) {
    return (e as Error).message.split("\n")[0] ?? String(e);
  }
}

/**
 * Resolve the configuration the way `managers config show` does — for THIS
 * data dir, creating nothing. The environment variable is set and restored
 * around the call because `loadPaddockConfig` reads it.
 */
async function loadConfigFor(dataDir: string) {
  const { loadPaddockConfig } = await import("../config.js");
  const before = process.env.MANAGERS_DATA_DIR;
  process.env.MANAGERS_DATA_DIR = dataDir;
  try {
    return loadPaddockConfig({ createDataDir: false });
  } finally {
    if (before === undefined) delete process.env.MANAGERS_DATA_DIR;
    else process.env.MANAGERS_DATA_DIR = before;
  }
}

/** `engines.node` from the installed package's own package.json, when it can be found. */
function packageEngines(entry: string): string | undefined {
  try {
    const { root } = findPackageRoot(entry, MANAGERS_PACKAGE, fs);
    if (root === undefined) return undefined;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
      engines?: { node?: string };
    };
    return pkg.name === MANAGERS_PACKAGE ? pkg.engines?.node : undefined;
  } catch {
    return undefined;
  }
}

/** The checklist, for a person. */
export function renderChecks(checks: Check[]): string {
  return (
    checks
      .map(
        (c) =>
          `${MARK[c.status]} ${c.message}${c.fix && c.status !== "pass" && c.status !== "skip" ? `\n    fix: ${c.fix}` : ""}`,
      )
      .join("\n") + "\n"
  );
}

export const doctorCode = (checks: Check[]): number => (checks.some((c) => c.status === "fail") ? 1 : 0);

/** True if `dir` is writable; 'creatable' if it doesn't exist but its nearest existing parent is; else why not. */
export function writableOrCreatable(dir: string): true | "creatable" | string {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return "no part of it exists";
    probe = parent;
  }
  try {
    if (!fs.statSync(probe).isDirectory()) return `${probe} isn't a directory`;
    fs.accessSync(probe, fs.constants.W_OK);
    return probe === dir ? true : "creatable";
  } catch (e) {
    return (e as Error).message;
  }
}

const defaultIsListening = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(1000);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "$USER";
  }
}

/** `loginctl show-user <user> -p Linger`: true, false, or null when it can't say (no loginctl, no logind). */
export function lingerOf(user: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("loginctl", ["show-user", user, "-p", "Linger"], { timeout: 5000 }, (err, stdout) => {
      const m = /^Linger=(yes|no)$/m.exec(String(stdout ?? ""));
      resolve(err || !m ? null : m[1] === "yes");
    });
  });
}

/** `managers doctor` as a command: the checklist, or one JSON document, and the exit code. */
export async function runDoctor(i: DoctorInput & { json?: boolean }): Promise<number> {
  const { checks, notice } = await diagnose(i);
  const code = doctorCode(checks);
  if (i.json) {
    // Exactly one JSON document on stdout (SPEC §3); the notice is prose, so stderr.
    process.stdout.write(JSON.stringify({ ok: code === 0, version: i.version, checks }, null, 2) + "\n");
  } else {
    process.stdout.write(renderChecks(checks));
  }
  if (notice) process.stderr.write(`\n${notice}\n`);
  return code;
}


/**
 * Managers M14.5: boot-time security posture.
 *
 * Three settings are dangerous enough that Managers refuses to boot with them
 * unless an explicit, loudly named opt-in is also set (audit M9–M14 #1 and #2):
 *
 *  1. `MANAGERS_AUTH_MODE=none`. With no authentication, every local process
 *     running as the same user, which includes every manager agent's Bash, can
 *     call the REST/WS API and act as Ed: flip a behaviour, answer a task, start a
 *     consolidation, or send a chat turn that counts as a human turn. That cannot
 *     be closed in `none` mode (the agent IS a local process as the same user), so
 *     it is an opt-in danger: `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1`.
 *
 *     The one implicit opt-in is the `managers` CLI's laptop default
 *     (`loopbackNoAuth`, passed to `start()` by cli/managers.ts — never an env
 *     var, so no child inherits it): `npx @edspencer/managers` on a laptop has no
 *     identity provider to point at, and refusing would make the first run a
 *     dead end. It applies ONLY when the RESOLVED bind host is loopback (so a
 *     `host:` in the config file is honoured, not guessed at), and it carries the
 *     same warning and banner as the explicit opt-in. The local-agent risk above
 *     is unchanged by it; what the loopback condition rules out is the network.
 *  2. `MANAGERS_AUTH_MODE=jwt` with no `iss`/`aud` check. A token minted by the
 *     same IdP for ANOTHER application verifies against the shared JWKS key and
 *     replays here. Both `MANAGERS_AUTH_JWT_ISSUER` and `MANAGERS_AUTH_JWT_AUDIENCE`
 *     are required, unless `MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE=1`.
 *  3. `driveMode: batch`. herdctl's CLI runtime exposes each turn's injected MCP
 *     servers (the `managers` state tools, including `memory_op`) as an
 *     UNAUTHENTICATED HTTP bridge. herdctl binds it to `0.0.0.0`; Managers rebinds
 *     it to loopback (`herdctl-bridge-bind.ts`), but any local process can still
 *     call it. `MANAGERS_ALLOW_BATCH_DRIVE=1` is required for the instance
 *     default AND for any project that overrides its drive mode to `batch`.
 *
 * Pure: `evaluateBootPosture` decides, `buildApp` acts (throw / warn), and the
 * resulting {@link SecurityPosture} is served at `GET /api/security` for the
 * web banner.
 */
import type { AuthMode, PaddockConfig } from "./config.js";
import { isLoopbackHost } from "./bind-safety.js";
import { type DriveMode, isKnownDriveMode } from "./models.js";

export interface BootPostureInput {
  authMode: AuthMode;
  /** `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH` (truthy). */
  allowNoAuth: boolean;
  /** The resolved bind host (`cfg.host`). */
  host: string;
  /** The CLI's laptop default: allow `none` on a loopback {@link host} only. */
  loopbackNoAuth: boolean;
  jwtIssuer?: string;
  jwtAudience?: string;
  /** `MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE` (truthy). */
  jwtAllowAnyAudience: boolean;
  driveMode: DriveMode;
  /** `MANAGERS_ALLOW_BATCH_DRIVE` (truthy). */
  allowBatchDrive: boolean;
}

/** One opted-in danger, as the doctor/meta output and the banner show it. */
export interface PostureWarning {
  code: "no-auth" | "trusted-header" | "jwt-any-audience" | "batch-drive";
  /** Short banner text. */
  title: string;
  /** The longer boot-log / doctor text. */
  detail: string;
}

export interface SecurityPosture {
  authMode: AuthMode;
  /** Instance default drive mode. */
  driveMode: DriveMode;
  /** Whether a project may run (or be set to) `driveMode: batch`. */
  batchDriveAllowed: boolean;
  warnings: PostureWarning[];
}

export type BootPostureDecision =
  | { action: "refuse"; message: string }
  | { action: "allow"; posture: SecurityPosture };

export const NO_AUTH_BANNER = "No authentication: agents on this host can act as you";

const NO_AUTH_DETAIL =
  "MANAGERS_AUTH_MODE=none with MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH set. Every " +
  "process on this host running as this user, which includes every manager agent's " +
  "Bash, can call this server's REST and WebSocket API as you: turn behaviours on, " +
  "answer tasks, start consolidations and send chat turns that count as yours. " +
  "Use MANAGERS_AUTH_MODE=jwt behind your identity provider (see AUTH.md).";

const NO_AUTH_LOOPBACK_DETAIL =
  "MANAGERS_AUTH_MODE=none on a loopback bind, the managers command's local " +
  "default. Nothing off this machine can reach it, but every process on this " +
  "host running as this user, which includes every manager agent's Bash, can call " +
  "this server's REST and WebSocket API as you: turn behaviours on, answer tasks, " +
  "start consolidations and send chat turns that count as yours. Set " +
  "MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=0 to refuse instead, or use " +
  "MANAGERS_AUTH_MODE=jwt (see AUTH.md).";

const JWT_ANY_AUDIENCE_DETAIL =
  "MANAGERS_AUTH_MODE=jwt with MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE set and no " +
  "issuer/audience check: a token the same identity provider issued for another " +
  "application verifies here. Set MANAGERS_AUTH_JWT_ISSUER and MANAGERS_AUTH_JWT_AUDIENCE.";

const BATCH_DETAIL =
  "MANAGERS_ALLOW_BATCH_DRIVE is set. In driveMode batch, herdctl's CLI runtime " +
  "serves each turn's injected MCP tools (the managers state tools, memory_op " +
  "included) over an unauthenticated HTTP bridge. Managers binds it to 127.0.0.1, " +
  "but any local process that learns the port (it is in the child's argv) can call " +
  "those tools as that turn. Use driveMode session outside a test rig.";

export function evaluateBootPosture(input: BootPostureInput): BootPostureDecision {
  const warnings: PostureWarning[] = [];

  if (input.authMode === "none") {
    const loopbackDefault = input.loopbackNoAuth && isLoopbackHost(input.host);
    if (!input.allowNoAuth && !loopbackDefault) {
      return {
        action: "refuse",
        message:
          "refusing to start: MANAGERS_AUTH_MODE=none. With no authentication, any " +
          "process on this host running as this user, including every manager agent's " +
          "Bash, can call the API as you (turn behaviours on, answer tasks, send chat " +
          "turns that count as yours). Set MANAGERS_AUTH_MODE=jwt (see AUTH.md), or, " +
          "only for a local test rig, set MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1.",
      };
    }
    warnings.push({
      code: "no-auth",
      title: NO_AUTH_BANNER,
      detail: input.allowNoAuth ? NO_AUTH_DETAIL : NO_AUTH_LOOPBACK_DETAIL,
    });
  }

  if (input.authMode === "trusted-header") {
    warnings.push({
      code: "trusted-header",
      title: "Trusted-header auth: agents on this host can forge the identity header",
      detail:
        "MANAGERS_AUTH_MODE=trusted-header trusts whoever can reach this port, and every manager agent's " +
        "Bash runs on this host, so it can send the header itself and act as you. Use MANAGERS_AUTH_MODE=jwt " +
        "(see AUTH.md).",
    });
  }

  if (input.authMode === "jwt") {
    const missing = [
      input.jwtIssuer ? null : "MANAGERS_AUTH_JWT_ISSUER",
      input.jwtAudience ? null : "MANAGERS_AUTH_JWT_AUDIENCE",
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      if (!input.jwtAllowAnyAudience) {
        return {
          action: "refuse",
          message:
            `refusing to start: MANAGERS_AUTH_MODE=jwt without ${missing.join(" and ")}. ` +
            "Without an issuer and audience check, a token your identity provider issued " +
            "for another application verifies against the same JWKS and is accepted " +
            "here. Set both, or set MANAGERS_AUTH_JWT_ALLOW_ANY_AUDIENCE=1 to accept " +
            "that risk.",
        };
      }
      warnings.push({
        code: "jwt-any-audience",
        title: "JWT issuer/audience not checked",
        detail: JWT_ANY_AUDIENCE_DETAIL,
      });
    }
  }

  if (input.driveMode === "batch" && !input.allowBatchDrive) {
    return {
      action: "refuse",
      message:
        "refusing to start: MANAGERS_DRIVE_MODE=batch. herdctl's CLI runtime serves " +
        "each turn's injected MCP tools (memory_op included) over an unauthenticated " +
        "HTTP bridge that any local process can call. Use the default session drive " +
        "mode, or, only for a credential-free test rig, set MANAGERS_ALLOW_BATCH_DRIVE=1.",
    };
  }
  if (input.allowBatchDrive) {
    warnings.push({
      code: "batch-drive",
      title: "Batch drive mode allowed: turn tools are reachable locally",
      detail: BATCH_DETAIL,
    });
  }

  return {
    action: "allow",
    posture: {
      authMode: input.authMode,
      driveMode: input.driveMode,
      batchDriveAllowed: input.allowBatchDrive,
      warnings,
    },
  };
}

/**
 * The drive mode a turn actually uses. A project's `driveMode: batch` override
 * is honoured only when batch is allowed; otherwise the turn runs in `session`
 * (the refused override is logged by the caller once per project).
 */
export function gateDriveMode(mode: DriveMode, allowBatch: boolean): DriveMode {
  return mode === "batch" && !allowBatch ? "session" : mode;
}

/**
 * A project's effective drive mode: its own known `driveMode` override, else the
 * instance default, then gated by {@link gateDriveMode}. The ONE resolver every
 * turn path uses (human turns, trigger fires, recovery nudges, spawned chats).
 */
export function resolveProjectDriveMode(
  project: { driveMode?: string },
  cfg: Pick<PaddockConfig, "driveMode" | "allowBatchDrive">,
): DriveMode {
  const own = project.driveMode;
  const mode = own && isKnownDriveMode(own) ? own : cfg.driveMode;
  return gateDriveMode(mode, cfg.allowBatchDrive);
}

/** The posture inputs, read off a resolved config (plus the CLI's start option). */
export function bootPostureInput(
  cfg: PaddockConfig,
  opts: { loopbackNoAuth?: boolean } = {},
): BootPostureInput {
  return {
    authMode: cfg.auth.mode,
    allowNoAuth: cfg.dangerouslyAllowNoAuth,
    host: cfg.host,
    loopbackNoAuth: opts.loopbackNoAuth === true,
    jwtIssuer: cfg.auth.jwtIssuer,
    jwtAudience: cfg.auth.jwtAudience,
    jwtAllowAnyAudience: cfg.auth.jwtAllowAnyAudience === true,
    driveMode: cfg.driveMode,
    allowBatchDrive: cfg.allowBatchDrive,
  };
}

/** The shared 1/true/yes truthy convention. */
export function envTruthy(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

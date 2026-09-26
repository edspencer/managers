/**
 * Managers M3: the runtime posture every Claude Code process this instance
 * spawns runs under. Plan §2.5; facts from TRANSCRIPT-EXPIRY.md.
 *
 * ## Why the overlay exists
 *
 * Claude Code's `cleanupPeriodDays` deletes transcripts (and sub-agent
 * transcripts, file-history, plans, …) under the Claude home once their mtime
 * is older than the cutoff. The default is 30 days, `0` is a validation error,
 * and there is no environment variable for it — so the ONLY way to keep
 * transcripts is a large value in a settings file. A Managers manager reads its
 * chats back out of band, so a missing transcript is a hard failure, not a
 * cosmetic gap.
 *
 * Upstream Paddock is protected only by accident: herdctl runs agents with
 * `--setting-sources=project`, and with the user source disabled and no enabled
 * source naming the key, Claude Code skips the sweep entirely. Managers turns
 * that into a stated guarantee instead:
 *
 * 1. `<claudeHome>/settings.json` is ALWAYS a file Managers generated: the
 *    (filtered) host settings, or nothing, with {@link MANAGERS_SETTINGS_OVERLAY}
 *    merged on top (`claude-home.ts` `materializeSettings`).
 * 2. Every agent — keeper, trigger, sweeper — declares
 *    {@link MANAGERS_SETTING_SOURCES}, so both runtimes read that file. herdctl's
 *    `toSDKOptions` honours `agent.setting_sources` on the batch SDK path AND on
 *    `openChatSession` (session drive mode), and the CLI runtime passes it as
 *    `--setting-sources`.
 *
 * With the user source enabled the sweep now RUNS — at a 100-year cutoff. That
 * is the point: "skipped by accident" becomes "runs with a value we chose".
 *
 * ## Auto-memory
 *
 * Claude Code's auto-memory writes `<claudeHome>/projects/<enc>/memory/`, a
 * second, hidden store outside the data repo. `autoMemoryDirectory` is ignored
 * in project settings, so it cannot be redirected into the repo either. Managers
 * owns memory itself (`memory/MEMORY.md`, loaded by the briefing), so auto-memory
 * is switched off twice: in the overlay, and by
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the server's own environment, which
 * every spawned child inherits ({@link applyRuntimeEnv}).
 *
 * ## What still outranks it
 *
 * Project settings beat user settings. A project's checked-in
 * `.claude/settings.json` with a SMALLER `cleanupPeriodDays` wins, and — because
 * the sweep is global over the Claude home — shortens retention for every
 * project, not just that one. herdctl has no passthrough for the SDK's
 * flag-settings layer (which would outrank project settings), so the defence is
 * a loud boot notice ({@link findRetentionOverrides}). Transcripts that live
 * behind the `.chats` symlinks are additionally skipped by the sweep, which does
 * not follow symlinked project folders; that is an implementation detail, not a
 * guarantee, and nothing here relies on it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { planHostSettings, type HooksMode } from "../claude-settings.js";

/** ~100 years. The schema's minimum is 1; `0` is rejected, never use it. */
export const MANAGERS_CLEANUP_PERIOD_DAYS = 36500;

/** The keys Managers forces into its own `settings.json`. They win over the host's. */
export const MANAGERS_SETTINGS_OVERLAY = Object.freeze({
  cleanupPeriodDays: MANAGERS_CLEANUP_PERIOD_DAYS,
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
});

/**
 * The setting sources every Managers agent declares. `user` is what makes the
 * generated `<claudeHome>/settings.json` load; `project` keeps the cwd's own
 * `CLAUDE.md` and `.claude/` (the walk-up to the root `CLAUDE.md` included).
 * `local` is deliberately absent: `settings.local.json` is per-machine, and a
 * notebook data repo should behave the same everywhere.
 */
export const MANAGERS_SETTING_SOURCES: readonly ("user" | "project")[] = Object.freeze([
  "user",
  "project",
]);

/** The env var Claude Code reads to disable auto-memory regardless of settings. */
export const DISABLE_AUTO_MEMORY_VAR = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/**
 * Set the process-wide environment the posture needs. Called first thing at
 * boot (`start.ts`), so every child herdctl spawns — on either runtime —
 * inherits it. Mutates `env`.
 */
export function applyRuntimeEnv(env: NodeJS.ProcessEnv = process.env): void {
  env[DISABLE_AUTO_MEMORY_VAR] = "1";
}

/** What Managers' own `settings.json` should contain, and what it did to the host's. */
export interface ManagedSettingsPlan {
  /** The file content to write (always valid JSON, always carrying the overlay). */
  content: string;
  /** Host keys dropped by `claude.hooks: own` (empty when none, or with no host file). */
  dropped: string[];
  /** Host keys the overlay replaced with a different value. */
  overridden: string[];
  /** Why the host file was not used at all, when it exists but could not be. */
  hostUnusable?: string;
}

/**
 * Pure: the host's `settings.json` (or `null` if there is none) plus the hooks
 * lever → the content Managers writes. Never "link": a symlink to the user's
 * file cannot carry the overlay.
 *
 * - no host file → the overlay alone;
 * - an unparseable host file → the overlay alone, and say why (fail closed: an
 *   unfiltered copy would hand over hooks `own` withholds);
 * - `hooks: own` → the host's keys minus `hooks`, overlay on top;
 * - `hooks: host` → the host's keys whole, overlay on top.
 */
export function planManagedSettings(hooks: HooksMode, raw: string | null): ManagedSettingsPlan {
  let base: Record<string, unknown> = {};
  let dropped: string[] = [];
  let hostUnusable: string | undefined;
  if (raw !== null) {
    // `planHostSettings` under `own` is the one place the hooks filter lives;
    // under `host` it only ever says "link", so parse it ourselves then.
    const filtered = planHostSettings("own", raw);
    if (filtered.action === "skip") {
      hostUnusable = filtered.reason;
    } else if (filtered.action === "write" && hooks === "own") {
      base = JSON.parse(filtered.content) as Record<string, unknown>;
      dropped = filtered.dropped;
    } else {
      base = JSON.parse(raw) as Record<string, unknown>;
    }
  }
  const overridden = Object.entries(MANAGERS_SETTINGS_OVERLAY)
    .filter(([k, v]) => k in base && base[k] !== v)
    .map(([k]) => k);
  const merged = { ...base, ...MANAGERS_SETTINGS_OVERLAY };
  return {
    content: `${JSON.stringify(merged, null, 2)}\n`,
    dropped,
    overridden,
    ...(hostUnusable !== undefined ? { hostUnusable } : {}),
  };
}

/**
 * Which overlay guarantees a settings file's content does NOT hold. Used for a
 * `settings.json` in the Claude home that Managers did not write (a human's —
 * left alone, but not silently).
 */
export function overlayViolations(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["the file is not valid JSON"];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["its top level is not a JSON object"];
  }
  const s = parsed as Record<string, unknown>;
  const out: string[] = [];
  const days = s.cleanupPeriodDays;
  if (typeof days !== "number" || days < MANAGERS_CLEANUP_PERIOD_DAYS) {
    out.push(
      `cleanupPeriodDays is ${days === undefined ? "unset (Claude Code's default is 30)" : JSON.stringify(days)}`,
    );
  }
  if (s.autoMemoryEnabled !== false) out.push("autoMemoryEnabled is not false");
  return out;
}

/** A project-level settings file that lowers retention below the overlay. */
export interface RetentionOverride {
  /** Absolute path of the offending `.claude/settings.json`. */
  file: string;
  /** Its `cleanupPeriodDays`. */
  days: number;
}

/**
 * Scan each directory's `.claude/settings.json` for a `cleanupPeriodDays` below
 * {@link MANAGERS_CLEANUP_PERIOD_DAYS}. Project settings outrank the user
 * settings the overlay lives in, and the cleanup sweep is global over the Claude
 * home, so one such file shortens retention for EVERY project. Never throws;
 * unreadable or unparseable files are skipped (Claude Code would skip a broken
 * file's sweep too). `settings.local.json` is not scanned: Managers agents do not
 * load the `local` source.
 */
export async function findRetentionOverrides(dirs: string[]): Promise<RetentionOverride[]> {
  const out: RetentionOverride[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const file = path.join(dir, ".claude", "settings.json");
    if (seen.has(file)) continue;
    seen.add(file);
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const days = (parsed as Record<string, unknown>).cleanupPeriodDays;
    if (typeof days === "number" && days < MANAGERS_CLEANUP_PERIOD_DAYS) out.push({ file, days });
  }
  return out;
}

/** The boot warning for {@link findRetentionOverrides}' hits. */
export function describeRetentionOverrides(hits: RetentionOverride[]): string {
  return (
    `transcript retention: ${hits.length} project settings file(s) set cleanupPeriodDays below ` +
    `Managers' ${MANAGERS_CLEANUP_PERIOD_DAYS}. Project settings outrank the Claude home's ` +
    `settings.json, and Claude Code's cleanup is global over the whole Claude home, so the ` +
    `smallest of these governs EVERY project's transcripts. Remove the key (or raise it) ` +
    `to restore "transcripts never expire":\n` +
    hits.map((h) => `  ${h.file}: cleanupPeriodDays ${h.days}`).join("\n")
  );
}

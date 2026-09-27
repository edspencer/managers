/**
 * data-sync — keep the data repo in step with its remote (M15; opt-in).
 *
 * Autocommit (M5) commits every state write locally; this is the half that was
 * deferred in v1: `git pull --rebase --autostash`, then `git push`, so the data
 * repo on GitHub (or wherever `origin` points) follows the instance and Ed's own
 * edits there come back.
 *
 *   MANAGERS_DATA_SYNC=1               turn it on (default off)
 *   MANAGERS_DATA_SYNC_INTERVAL=10m    the periodic cadence (`30s`, `10m`, `1h`, or ms)
 *
 * When it runs: every interval, and shortly after each run's end-commit (a
 * debounced {@link DataSync.request}, so a burst of turn-ends is one sync). Every
 * sync is serialised with the autocommit queue ({@link DataSyncOptions.serialize}),
 * so a pull never runs in the middle of a commit and vice versa, and two syncs
 * never overlap.
 *
 * Rules:
 *   - No remote → skip quietly (`skipped: "no-remote"`), no alert. An unborn
 *     branch or a detached HEAD is skipped the same way.
 *   - Never forces. `git push` is a plain fast-forward push; a rejected push is a
 *     failure, retried at the next sync (which pulls first).
 *   - A pull whose rebase stops on a conflict is ABORTED (`git rebase --abort`),
 *     leaving the local branch exactly as it was, and raises the
 *     `data-sync-failed` alert (Home's alerts, so it shows on Home and in Needs
 *     you). Any other failure (network, auth, a rejected push) raises it too, at
 *     warning severity. The next successful sync clears it.
 *   - Auth is the process's ordinary git credentials (a deploy key, a credential
 *     helper). Nothing is put in a URL, prompting is disabled, and every git
 *     message that reaches a log line or the alert has URL credentials and
 *     token-shaped strings redacted.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DATA_SYNC_ALERT_KIND = "data-sync-failed" as const;

export interface DataSyncConfig {
  enabled: boolean;
  intervalMs: number;
}

export const DEFAULT_SYNC_INTERVAL_MS = 10 * 60_000;
/** The minimum interval (a typo like `1s` should not hammer the remote). */
export const MIN_SYNC_INTERVAL_MS = 10_000;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parse `30s` / `10m` / `1h` / `1d` / a bare millisecond count. Null when unparseable. */
export function parseSyncInterval(raw: string | undefined): number | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(v);
  if (!m) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

/** `MANAGERS_DATA_SYNC` / `MANAGERS_DATA_SYNC_INTERVAL`. */
export function loadDataSyncConfig(env: NodeJS.ProcessEnv = process.env): DataSyncConfig {
  const enabled = TRUTHY.has((env.MANAGERS_DATA_SYNC ?? "").trim().toLowerCase());
  const parsed = parseSyncInterval(env.MANAGERS_DATA_SYNC_INTERVAL);
  const intervalMs = parsed === null ? DEFAULT_SYNC_INTERVAL_MS : Math.max(MIN_SYNC_INTERVAL_MS, parsed);
  return { enabled, intervalMs };
}

/** Strip credentials from anything git printed before it reaches a log or the UI. */
export function redactGitText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]+@/gi, "$1***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/(authorization:\s*)(basic|bearer)\s+\S+/gi, "$1$2 [redacted]");
}

export type SyncOutcome =
  | { ok: true; skipped?: "no-remote" | "no-commits" | "detached" | "disabled"; pulled: boolean; pushed: boolean }
  | { ok: false; stage: "pull" | "push" | "fetch"; conflict: boolean; error: string };

/** The instance-wide sync state the alerts read. */
export interface DataSyncStatus {
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** The current failure, or null when the last sync succeeded (or none ran). */
  failure: { at: string; stage: string; conflict: boolean; message: string } | null;
}

export interface DataSyncOptions {
  root: string;
  config: DataSyncConfig;
  /** Serialise with the autocommit queue (a sync never overlaps a commit). */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Delay between a {@link DataSync.request} and the sync it causes. */
  debounceMs?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** Extra env for git (tests: an isolated HOME). */
  env?: NodeJS.ProcessEnv;
  /**
   * The committer identity a rebase uses when it replays local commits (their
   * authors are kept). Without it a service user with no git identity fails
   * every pull that has something to rebase. Default `managers-bot`.
   */
  committer?: { name: string; email: string };
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return redactGitText((e.stderr || e.stdout || e.message || String(err)).trim());
}

export class DataSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<SyncOutcome> | null = null;
  private stopped = false;
  private readonly state: DataSyncStatus;

  constructor(private readonly opts: DataSyncOptions) {
    this.state = { enabled: opts.config.enabled, lastAttemptAt: null, lastSuccessAt: null, failure: null };
  }

  get status(): DataSyncStatus {
    return { ...this.state, failure: this.state.failure ? { ...this.state.failure } : null };
  }

  /** Start the periodic sync and kick off one right away. No-op when disabled. */
  start(): void {
    if (!this.opts.config.enabled || this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.syncNow(), this.opts.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    this.request();
  }

  /** Ask for a sync soon (debounced) — called after each run's end-commit. */
  request(): void {
    if (!this.opts.config.enabled || this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, this.opts.debounceMs ?? 5_000);
    (this.debounce as { unref?: () => void }).unref?.();
  }

  /** Stop the timers; waits for an in-flight sync. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
    await this.inflight?.catch(() => undefined);
  }

  /**
   * Sync now (serialised). A call while one is running joins it rather than
   * queueing a second one behind it.
   */
  syncNow(): Promise<SyncOutcome> {
    if (!this.opts.config.enabled) return Promise.resolve({ ok: true, skipped: "disabled", pulled: false, pushed: false });
    if (this.inflight) return this.inflight;
    const body = () => this.syncOnce();
    const p = (this.opts.serialize ? this.opts.serialize(body) : body()).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private git(args: string[]) {
    return run("git", args, {
      cwd: this.opts.root,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...this.opts.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
    });
  }

  private async tryGit(args: string[]): Promise<string | null> {
    try {
      return (await this.git(args)).stdout.trim();
    } catch {
      return null;
    }
  }

  private async rebaseInProgress(): Promise<boolean> {
    const gitDir = await this.tryGit(["rev-parse", "--absolute-git-dir"]);
    if (!gitDir) return false;
    for (const d of ["rebase-merge", "rebase-apply"]) {
      if (await fs.stat(path.join(gitDir, d)).then(() => true, () => false)) return true;
    }
    return false;
  }

  private async syncOnce(): Promise<SyncOutcome> {
    const now = () => new Date().toISOString();
    this.state.lastAttemptAt = now();
    const skip = (skipped: "no-remote" | "no-commits" | "detached"): SyncOutcome => {
      // A skip is not a failure; nothing to alert on.
      this.state.failure = null;
      return { ok: true, skipped, pulled: false, pushed: false };
    };

    const remotes = await this.tryGit(["remote"]);
    if (remotes === null || remotes === "") return skip("no-remote");
    if ((await this.tryGit(["rev-parse", "--verify", "-q", "HEAD"])) === null) return skip("no-commits");
    const branch = await this.tryGit(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch) return skip("detached");
    const list = remotes.split("\n").map((r) => r.trim()).filter(Boolean);
    const configured = await this.tryGit(["config", "--get", `branch.${branch}.remote`]);
    const remote = configured && list.includes(configured) ? configured : list.includes("origin") ? "origin" : list[0]!;

    const fail = (stage: "pull" | "push" | "fetch", conflict: boolean, error: string): SyncOutcome => {
      this.state.failure = { at: now(), stage, conflict, message: error };
      this.opts.log?.warn({ stage, conflict, error }, "managers data sync failed");
      return { ok: false, stage, conflict, error };
    };

    // Does the remote have this branch yet? (A fresh, empty managers-data does not.)
    let remoteHasBranch: boolean;
    try {
      const out = (await this.git(["ls-remote", "--heads", remote, `refs/heads/${branch}`])).stdout.trim();
      remoteHasBranch = out !== "";
    } catch (err) {
      return fail("fetch", false, firstLines(errText(err)));
    }

    let pulled = false;
    if (remoteHasBranch) {
      const before = await this.tryGit(["rev-parse", "HEAD"]);
      try {
        const who = this.opts.committer ?? { name: "managers-bot", email: "managers-bot@localhost" };
        await this.git([
          "-c",
          `user.name=${who.name}`,
          "-c",
          `user.email=${who.email}`,
          "pull",
          "--rebase",
          "--autostash",
          "--no-edit",
          remote,
          branch,
        ]);
      } catch (err) {
        const message = errText(err);
        const inRebase = await this.rebaseInProgress();
        if (inRebase) await this.tryGit(["rebase", "--abort"]);
        // A rebase can stop for reasons other than a conflict (no committer
        // identity, a hook): only git's own conflict report counts as one.
        const conflict = /CONFLICT|could not apply/i.test(message);
        return fail(
          "pull",
          conflict,
          conflict
            ? `The pull from ${remote}/${branch} conflicted and was aborted; the local branch is unchanged. ${firstLines(message)}`
            : firstLines(message),
        );
      }
      pulled = (await this.tryGit(["rev-parse", "HEAD"])) !== before;
    }

    // Anything to push?
    let ahead = true;
    if (remoteHasBranch) {
      const count = await this.tryGit(["rev-list", "--count", `${remote}/${branch}..HEAD`]);
      ahead = count === null ? true : Number(count) > 0;
    }
    let pushed = false;
    if (ahead) {
      const upstream = await this.tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      const args = ["push", ...(upstream ? [] : ["--set-upstream"]), remote, `${branch}:refs/heads/${branch}`];
      try {
        await this.git(args);
        pushed = true;
      } catch (err) {
        return fail("push", false, firstLines(errText(err)));
      }
    }
    this.state.failure = null;
    this.state.lastSuccessAt = now();
    if (pulled || pushed) this.opts.log?.info({ remote, branch, pulled, pushed }, "managers data synced");
    return { ok: true, pulled, pushed };
  }
}

function firstLines(text: string, n = 4): string {
  return text.split("\n").filter((l) => l.trim()).slice(0, n).join(" ").slice(0, 600);
}

/** The `data-sync-failed` alert for a status, or null. */
export function dataSyncAlert(status: DataSyncStatus | null | undefined): {
  id: string;
  kind: typeof DATA_SYNC_ALERT_KIND;
  trigger: string;
  severity: "error" | "warning";
  message: string;
  runId: null;
  at: string;
} | null {
  const f = status?.failure;
  if (!f) return null;
  const lead = f.conflict
    ? "Data repo sync stopped on a conflict: someone changed the same file on the remote. Resolve it by hand in the data repo (pull, fix, push); Managers keeps committing locally meanwhile."
    : `Data repo sync failed at ${f.stage}; Managers keeps committing locally and retries on the next sync.`;
  return {
    id: `${DATA_SYNC_ALERT_KIND}:`,
    kind: DATA_SYNC_ALERT_KIND,
    trigger: "",
    severity: f.conflict ? "error" : "warning",
    message: `${lead} ${f.message}`.trim(),
    runId: null,
    at: f.at,
  };
}

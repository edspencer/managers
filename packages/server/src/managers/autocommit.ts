/**
 * autocommit — every Managers state write lands in git (plan §2.6).
 *
 * Commits ONLY the Managers-owned paths of one workspace
 * ({@link OWNED_STATE_PATHS}: `objectives/ tasks/ log/ runs/ reports/ memory/
 * .gitattributes`, relative to the workspace dir) — and inside them only the
 * files named the way the stores name them ({@link isOwnedStateFile}, M9.5) through
 * `GitService.commitProject(dir, msg, paths, {author})`. Anything else dirty in
 * the workspace — Ed's `notes.md`, a half-edited `CLAUDE.md` — stays exactly as
 * uncommitted as it was. At the root (Home) the same set is used under the
 * projects root; never `.`, which would sweep up every project.
 *
 * Cadence: a write schedules a commit {@link AutocommitOptions.debounceMs} later
 * (10 s by default), coalescing a burst of writes into one commit; a turn ending
 * flushes immediately. `MANAGERS_AUTOCOMMIT=0` disables it. It never pushes.
 *
 * Authorship: agent writes commit as `managers-bot`; UI writes commit as the
 * requesting user (or the configured `MANAGERS_GIT_AUTHOR_*`). A pending commit
 * belongs to one author — before a write by a different author lands, the
 * writer calls {@link Autocommitter.beforeWrite}, which commits the pending one
 * first, so attribution is never merged. Commits run under the workspace's write
 * lock for the same reason.
 *
 * Every workspace shares ONE git repository (the data repo), so commits are
 * serialised globally, not per workspace: two concurrent `git add`s would collide
 * on `.git/index.lock`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { OWNED_STATE_PATHS, isOwnedStateFile } from "./layout.js";

export interface GitAuthor {
  name: string;
  email: string;
}

/** The slice of `GitService` autocommit needs (keeps it unit-testable). */
export interface AutocommitGit {
  commitProject(
    projectDir: string,
    message: string,
    paths?: string[],
    opts?: { author?: GitAuthor },
  ): Promise<{ committed: boolean; hash?: string; error?: string }>;
  /**
   * M9.5: the changed files (modified, deleted or untracked-not-ignored) under
   * `pathspec`, relative to `dir`. When present, autocommit stages only the
   * store-shaped ones ({@link isOwnedStateFile}); without it (unit fakes) it
   * stages the owned directories whole, as before.
   */
  changedPaths?(dir: string, pathspec: string[]): Promise<string[]>;
}

export interface AutocommitOptions {
  git: AutocommitGit;
  enabled: boolean;
  debounceMs: number;
  /** For log lines only. */
  log?: { warn(obj: object, msg: string): void };
  /**
   * The workspace write lock (the state writer's queue). A debounced or turn-end
   * commit runs INSIDE it, so no write can land in the middle of a commit and be
   * swept into it under the wrong author.
   */
  lock?: <T>(dir: string, fn: () => Promise<T>) => Promise<T>;
}

export interface CommitResult {
  committed: boolean;
  hash?: string;
  error?: string;
}

interface Pending {
  dir: string;
  label: string;
  author: GitAuthor;
  timer: ReturnType<typeof setTimeout> | null;
  reasons: Set<string>;
  /** Paths beyond the owned set this commit must also stage (M8: `project.yaml`). */
  extra: Set<string>;
}

const sameAuthor = (a: GitAuthor, b: GitAuthor) => a.name === b.name && a.email === b.email;

/** The owned paths that exist in `dir` (a pathspec that matches nothing makes git fail). */
export async function ownedPathsPresent(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of OWNED_STATE_PATHS) {
    try {
      await fs.lstat(path.join(dir, p));
      out.push(p);
    } catch {
      /* absent */
    }
  }
  return out;
}

/** Which of `rel` exist under `dir` (M8's extra paths, e.g. `project.yaml`). Never `.`. */
async function presentPaths(dir: string, rel: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of rel) {
    if (!p || p === "." || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) continue;
    try {
      await fs.lstat(path.join(dir, p));
      out.push(p);
    } catch {
      /* absent */
    }
  }
  return out;
}

export class Autocommitter {
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: AutocommitOptions) {}

  get enabled(): boolean {
    return this.opts.enabled && !this.closed;
  }

  /**
   * Note a write to the workspace at `dir`. `label` names it in the commit
   * message (`acme-site`, or `Home` for the root); `reason` is a short verb
   * phrase ("record_episode") collected into the message body.
   */
  schedule(dir: string, label: string, author: GitAuthor, reason: string, extraPaths: readonly string[] = []): void {
    if (!this.enabled) return;
    const key = path.resolve(dir);
    const cur = this.pending.get(key);
    // Normally already committed by beforeWrite; this is the fallback when no
    // writer hook is wired (the attribution may then merge — see beforeWrite).
    if (cur && !sameAuthor(cur.author, author)) void this.flush(key);
    let p = this.pending.get(key);
    if (!p) {
      p = { dir: key, label, author, timer: null, reasons: new Set(), extra: new Set() };
      this.pending.set(key, p);
    }
    p.reasons.add(reason);
    for (const x of extraPaths) p.extra.add(x);
    if (p.timer) clearTimeout(p.timer);
    const target = p;
    p.timer = setTimeout(() => {
      if (this.pending.get(key) === target) void this.flush(key);
    }, this.opts.debounceMs);
    // Never hold the process open for a pending commit.
    (p.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Called by the writer INSIDE the workspace lock, just before a write lands: if
   * a commit is pending for a different author, commit it now, so the upcoming
   * write can't be swept into it.
   */
  async beforeWrite(dir: string, author: GitAuthor): Promise<void> {
    if (!this.enabled) return;
    const key = path.resolve(dir);
    const p = this.pending.get(key);
    if (!p || sameAuthor(p.author, author)) return;
    this.pending.delete(key);
    if (p.timer) clearTimeout(p.timer);
    await this.commit(p);
  }

  /**
   * Commit a workspace's pending writes now (a turn ended, or a test wants the
   * commit). Resolves `null` when nothing was pending for it. Runs under the
   * workspace lock when one is wired — never call it from inside that lock.
   */
  async flush(dir: string): Promise<CommitResult | null> {
    const key = path.resolve(dir);
    const p = this.pending.get(key);
    if (!p) return null;
    this.pending.delete(key);
    if (p.timer) clearTimeout(p.timer);
    return this.opts.lock ? this.opts.lock(key, () => this.commit(p)) : this.commit(p);
  }

  /** Flush every pending workspace (shutdown). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((k) => this.flush(k)));
  }

  /** Flush everything and refuse further scheduling. */
  async close(): Promise<void> {
    await this.flushAll();
    this.closed = true;
    await this.chain.catch(() => undefined);
  }

  /**
   * Commit exactly `paths` (relative to `dir`) now, as `author`, with `message`
   * (M9.5). Serialised with every other commit and run under the workspace lock
   * when one is wired. The behaviour switch uses it to commit `project.yaml` edits
   * made outside the switch BEFORE its own write, so they are never attributed to
   * the switch's author. `{ committed: false }` when nothing under `paths` changed.
   */
  async commitPaths(dir: string, message: string, paths: string[], author: GitAuthor): Promise<CommitResult> {
    if (!this.enabled) return { committed: false };
    const key = path.resolve(dir);
    const run = async (): Promise<CommitResult> => {
      const present = await presentPaths(key, paths);
      if (present.length === 0) return { committed: false };
      return this.opts.git.commitProject(key, message, present, { author });
    };
    const chained = () => {
      const next = this.chain.then(run, run);
      this.chain = next.catch(() => undefined);
      return next;
    };
    return this.opts.lock ? this.opts.lock(key, chained) : chained();
  }

  /** Whether a commit is pending for `dir` (tests). */
  isPending(dir: string): boolean {
    return this.pending.has(path.resolve(dir));
  }

  private commit(p: Pending): Promise<CommitResult> {
    const run = async (): Promise<CommitResult> => {
      const owned = await ownedPathsPresent(p.dir);
      // M9.5 (audit #5): only files the stores write, never a stray in an owned folder.
      const ownedFiles =
        this.opts.git.changedPaths && owned.length > 0
          ? (await this.opts.git.changedPaths(p.dir, owned).catch(() => [] as string[])).filter(isOwnedStateFile)
          : owned;
      const paths = [...new Set([...ownedFiles, ...(await presentPaths(p.dir, [...p.extra]))])];
      if (paths.length === 0) return { committed: false };
      const reasons = [...p.reasons].sort();
      const message = `managers: update ${p.label} state\n\n${reasons.map((r) => `- ${r}`).join("\n")}`;
      let r = await this.opts.git.commitProject(p.dir, message, paths, { author: p.author });
      // Someone else (the Changes tab, a human in a shell) held the index lock.
      if (!r.committed && r.error && /index\.lock/.test(r.error)) {
        await new Promise((res) => setTimeout(res, 250));
        r = await this.opts.git.commitProject(p.dir, message, paths, { author: p.author });
      }
      if (!r.committed && r.error && r.error !== "not a repo") {
        this.opts.log?.warn({ workspace: p.label, error: r.error }, "managers autocommit failed");
      }
      return r;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

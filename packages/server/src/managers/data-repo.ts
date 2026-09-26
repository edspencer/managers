/**
 * data-repo — `ensureDataRepo(projectsRoot)`: the data-repo skeleton (plan §4).
 *
 * The projects root is ONE git repo (`managers-data`) holding every project's
 * state. At boot, before herdctl starts, this makes sure it carries:
 *
 *   .managers-data   the ownership marker (claimed only for a root holding no
 *                    projects yet — an ADOPTED root is never marked, keeping the
 *                    M1 guard's "decide again every boot" rule)
 *   .gitignore       transcripts, briefings, the reserved index/ and state/ dirs
 *   .gitattributes   union merge for the append-only journals and logs
 *   README.md        a stub saying what this directory is
 *
 * and `git init`s it when it is not a repo yet (unless `gitInit` is false —
 * `MANAGERS_DATA_GIT_INIT=0`). It never commits: the first commit is autocommit's
 * (M5) or the operator's.
 *
 * Idempotent: every piece is written only when missing, and an existing
 * `.gitignore` / `.gitattributes` only ever gains the lines it lacks.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { claimProjectsRoot, hasDataRepoMarker } from "../data-dir-guard.js";

const run = promisify(execFile);

/** `.gitignore` lines the data repo needs (plan §4). */
export const DATA_REPO_GITIGNORE = [
  "*/.chats/",
  ".chats/",
  "**/.managers/briefings/",
  "**/.managers/index/",
  "**/.managers/state/",
] as const;

/** `.gitattributes` lines: journals and logs are append-only, so union-merge them. */
export const DATA_REPO_GITATTRIBUTES = ["**/journal/*.md merge=union", "**/log/*.md merge=union"] as const;

export const DATA_REPO_README = `# Managers data

This directory is a Managers data repo: one git repository holding every
project's objectives, tasks, episodic log, memory, reports and run records.

- The root of this repo is the **Home** workspace. Its \`CLAUDE.md\` and
  \`memory/\` apply to every project's manager.
- Each subdirectory with a \`project.yaml\` is one project.
- Chat transcripts (\`.chats/\`) are not tracked here.

Managers commits its own state files; everything else is yours.
`;

/** Lines that already satisfy a wanted line (an equivalent spelling). */
const EQUIVALENT: Record<string, string[]> = {
  ".chats/": [".chats/", ".chats", "/.chats/", "/.chats"],
  "*/.chats/": ["*/.chats/", "**/.chats/", "*/.chats"],
};

export interface EnsureDataRepoResult {
  /** Workspace-relative files created or extended. */
  changed: string[];
  gitInitialized: boolean;
  /** True when the root carries the marker after this call. */
  marked: boolean;
}

async function readOr(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Append whichever `wanted` lines `file` lacks, under one header. */
async function ensureLines(file: string, wanted: readonly string[], header: string): Promise<boolean> {
  const existing = (await readOr(file)) ?? "";
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = wanted.filter((w) => !(EQUIVALENT[w] ?? [w]).some((e) => have.has(e)));
  if (missing.length === 0) return false;
  const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.writeFile(file, `${existing}${sep}${header}\n${missing.join("\n")}\n`, "utf8");
  return true;
}

export async function ensureDataRepo(
  projectsRoot: string,
  opts: { gitInit?: boolean } = {},
): Promise<EnsureDataRepoResult> {
  const changed: string[] = [];
  await fs.mkdir(projectsRoot, { recursive: true });

  if (!hasDataRepoMarker(projectsRoot)) {
    claimProjectsRoot(projectsRoot);
    if (hasDataRepoMarker(projectsRoot)) changed.push(".managers-data");
  }

  if (
    await ensureLines(
      path.join(projectsRoot, ".gitignore"),
      DATA_REPO_GITIGNORE,
      "# Managers data repo: transcripts and regenerable state are never tracked.",
    )
  ) {
    changed.push(".gitignore");
  }
  if (
    await ensureLines(
      path.join(projectsRoot, ".gitattributes"),
      DATA_REPO_GITATTRIBUTES,
      "# Managers: journals and logs are append-only; merge both sides.",
    )
  ) {
    changed.push(".gitattributes");
  }
  const readme = path.join(projectsRoot, "README.md");
  if ((await readOr(readme)) === null) {
    await fs.writeFile(readme, DATA_REPO_README, "utf8");
    changed.push("README.md");
  }

  let gitInitialized = false;
  if (opts.gitInit !== false) {
    const isRepo = await fs
      .stat(path.join(projectsRoot, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!isRepo) {
      try {
        await run("git", ["init", "-q"], { cwd: projectsRoot });
        // Name the unborn branch `main` whatever the box's init.defaultBranch says.
        await run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: projectsRoot });
        gitInitialized = true;
      } catch {
        /* no git binary: the store is a plain directory and git features stay dark */
      }
    }
  }
  return { changed, gitInitialized, marked: hasDataRepoMarker(projectsRoot) };
}

/** Whether `MANAGERS_DATA_GIT_INIT` allows `git init` (anything but `0`/`false`/`no`/`off`). */
export function dataGitInitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MANAGERS_DATA_GIT_INIT ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

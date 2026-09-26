/**
 * Data-dir safety guard (Managers M1).
 *
 * Managers runs beside Paddock, on the same machines, from a fork of the same
 * code — so the easiest catastrophic mistake is a Managers server (a dev run, a
 * QA rig, a test) resolving its projects root to a directory full of Paddock's,
 * or anyone else's, real projects, and then curating, committing into and
 * deleting inside it.
 *
 * The rule: a projects root that already holds projects (any `<child>/project.yaml`)
 * must carry the {@link DATA_REPO_MARKER} file saying Managers owns it, or boot
 * refuses. A root with no projects yet — absent, empty, or holding only loose
 * files — is claimed: the marker is written so the projects created in it later
 * keep booting. `MANAGERS_ADOPT_DATA_DIR=1` is the deliberate override for
 * adopting an existing tree; it lets boot proceed but does NOT write the marker,
 * so the choice has to be made again (or the marker added by hand) every time.
 */
import fs from "node:fs";
import path from "node:path";

/** The file at the projects root that says "this data repo belongs to Managers". */
export const DATA_REPO_MARKER = ".managers-data";

/** The env var that deliberately overrides the guard for one boot. */
export const ADOPT_ENV_VAR = "MANAGERS_ADOPT_DATA_DIR";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether the adopt override is set in `env`. */
export function adoptRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env[ADOPT_ENV_VAR] ?? "").trim().toLowerCase());
}

/** Child directory names of `root` holding a `project.yaml`. Empty for a missing root. */
export function projectDirsIn(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (fs.existsSync(path.join(root, e.name, "project.yaml"))) found.push(e.name);
  }
  return found;
}

/** Whether `root` carries the ownership marker. */
export function hasDataRepoMarker(root: string): boolean {
  return fs.existsSync(path.join(root, DATA_REPO_MARKER));
}

/**
 * The refusal message for booting against `projectsRoot`, or `undefined` when
 * boot may proceed. Pure apart from reading the directory.
 */
export function dataDirGuardRefusal(
  projectsRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (hasDataRepoMarker(projectsRoot)) return undefined;
  const projects = projectDirsIn(projectsRoot);
  if (projects.length === 0) return undefined;
  if (adoptRequested(env)) return undefined;
  return (
    `Refusing to start: the projects root ${projectsRoot} already contains ` +
    `${projects.length} project${projects.length === 1 ? "" : "s"} but no ${DATA_REPO_MARKER} marker, ` +
    `so it was not created by Managers. It may be another app's (e.g. Paddock's) live data. ` +
    `Point MANAGERS_DATA_DIR / MANAGERS_PROJECTS_DIR somewhere else, or — only if you really ` +
    `mean to adopt this directory — create ${path.join(projectsRoot, DATA_REPO_MARKER)} ` +
    `or set ${ADOPT_ENV_VAR}=1.`
  );
}

/**
 * Write the marker into a projects root that holds no projects yet, creating
 * the root if needed. A no-op when the marker exists, and — deliberately —
 * when the root already holds projects (that is the adopt case, which never
 * writes). Best-effort: a failure here only means the next boot re-evaluates.
 */
export function claimProjectsRoot(projectsRoot: string): void {
  if (hasDataRepoMarker(projectsRoot)) return;
  if (projectDirsIn(projectsRoot).length > 0) return;
  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectsRoot, DATA_REPO_MARKER),
      "This directory is a Managers data repo. Managers refuses to boot against a\n" +
        "projects root that holds projects but lacks this file. Do not copy it into\n" +
        "a directory another app owns.\n",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * The guard as config loading applies it: throw on refusal, otherwise claim a
 * fresh root (unless `claim` is false, as for a read-only `config show`).
 */
export function enforceDataDirGuard(
  projectsRoot: string,
  opts: { claim: boolean; env?: NodeJS.ProcessEnv },
): void {
  const refusal = dataDirGuardRefusal(projectsRoot, opts.env ?? process.env);
  if (refusal !== undefined) throw new Error(refusal);
  if (opts.claim) claimProjectsRoot(projectsRoot);
}

/**
 * layout — where every piece of Managers domain state lives on disk (plan §4).
 *
 * One {@link WorkspaceLayout} per workspace, built from the workspace's own
 * directory. The root workspace (Home, key `""`) and a project use the SAME
 * layout: the root's `objectives/`, `tasks/`, … are Home's own state, exactly as
 * a project's are. Only `memory/` is additionally SHARED — every project's
 * briefing and memory view include the root's (see {@link sharedMemoryLayout}).
 *
 * Also the id/name grammars the stores and REST routes validate against. These
 * are the one definition: a route that 400s a malformed id and a store that
 * refuses to build a path from one both use the same regex, so a path can never
 * be assembled from an unvalidated segment.
 */
import path from "node:path";

/**
 * Top-level directory names Managers owns inside every workspace. At the ROOT
 * they are Home's state dirs, which is why a project may not take one as its slug
 * (it would be `<projectsRoot>/tasks/project.yaml` — a project squatting on Home's
 * task store). `archive` is reserved for the v2 archive moves.
 */
export const RESERVED_STATE_DIRS = [
  "objectives",
  "tasks",
  "log",
  "runs",
  "reports",
  "memory",
  "archive",
] as const;

/** Whether `slug` collides with a root state dir. */
export function isReservedSlug(slug: string): boolean {
  return (RESERVED_STATE_DIRS as readonly string[]).includes(slug);
}

/**
 * The paths autocommit (M5) may stage, relative to a workspace dir. Never `.`.
 */
export const OWNED_STATE_PATHS = [
  "objectives",
  "tasks",
  "log",
  "runs",
  "reports",
  "memory",
  ".gitattributes",
] as const;

// --- grammars -------------------------------------------------------------

/** Objective slugs, fact names, playbook names and report types: kebab-case. */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A calendar month, `YYYY-MM`. */
export const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** A calendar date, `YYYY-MM-DD`. */
export const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Ids (§2.7). The minted suffix is crypto base32 (`[a-z2-7]`), but reads accept
 * any lowercase alphanumeric suffix of 2–8 chars so a hand-made id still resolves.
 */
export const TASK_ID_RE = /^t-\d{6}-[a-z0-9]{2,8}$/;
export const EPISODE_ID_RE = /^ep-\d{6}-\d{4}-[a-z0-9]{2,8}$/;
export const RUN_ID_RE = /^r-\d{6}-\d{4}-[a-z0-9]{2,8}$/;

export const isName = (s: string): boolean => s.length <= 80 && NAME_RE.test(s);
export const isMonth = (s: string): boolean => MONTH_RE.test(s);
export const isDate = (s: string): boolean => DATE_RE.test(s);
export const isTaskId = (s: string): boolean => TASK_ID_RE.test(s);
export const isEpisodeId = (s: string): boolean => EPISODE_ID_RE.test(s);
export const isRunId = (s: string): boolean => RUN_ID_RE.test(s);

/** The `YYYY-MM` month an id's `YYMMDD` stamp falls in (tasks and runs). */
export function monthOfId(id: string): string | null {
  const m = /^[a-z]+-(\d{2})(\d{2})\d{2}-/.exec(id);
  return m ? `20${m[1]}-${m[2]}` : null;
}

/** Marker in `memory/MEMORY.md` below which the server regenerates the index. */
export const MEMORY_INDEX_MARKER = "<!-- managers:index -->";

// --- the layout -----------------------------------------------------------

export interface WorkspaceLayout {
  /** The workspace directory (the projects root for Home). */
  dir: string;
  objectivesDir: string;
  objectiveDir(slug: string): string;
  objectiveFile(slug: string): string;
  journalDir(slug: string): string;
  journalFile(slug: string, month: string): string;
  logDir: string;
  logFile(month: string): string;
  tasksOpenDir: string;
  tasksDoneDir: string;
  tasksDoneMonthDir(month: string): string;
  memoryDir: string;
  memoryIndexFile: string;
  factsDir: string;
  factFile(name: string): string;
  playbooksDir: string;
  playbookFile(name: string): string;
  reportsDir: string;
  reportTypeDir(type: string): string;
  reportCurrentFile(type: string): string;
  reportDatedFile(type: string, date: string): string;
  runsDir: string;
  runsMonthDir(month: string): string;
  runFile(month: string, id: string): string;
  /** Gitignored "what the manager saw" briefings (M7). */
  briefingsDir: string;
  /** Git-tracked trigger prompt files (`.managers/triggers/`). */
  triggersDir: string;
  /** Workspace-relative POSIX path for a file inside it (for DTOs; never absolute). */
  rel(abs: string): string;
}

function assert(ok: boolean, what: string, value: string): void {
  if (!ok) throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
}

/**
 * The layout for the workspace at `dir`. Every builder validates its segment,
 * so a bad id can never become a path (throws — callers validate first and 400).
 */
export function workspaceLayout(dir: string): WorkspaceLayout {
  const j = (...p: string[]) => path.join(dir, ...p);
  const name = (s: string, what: string) => (assert(isName(s), what, s), s);
  const month = (s: string) => (assert(isMonth(s), "month", s), s);
  return {
    dir,
    objectivesDir: j("objectives"),
    objectiveDir: (s) => j("objectives", name(s, "objective id")),
    objectiveFile: (s) => j("objectives", name(s, "objective id"), "objective.md"),
    journalDir: (s) => j("objectives", name(s, "objective id"), "journal"),
    journalFile: (s, m) => j("objectives", name(s, "objective id"), "journal", `${month(m)}.md`),
    logDir: j("log"),
    logFile: (m) => j("log", `${month(m)}.md`),
    tasksOpenDir: j("tasks", "open"),
    tasksDoneDir: j("tasks", "done"),
    tasksDoneMonthDir: (m) => j("tasks", "done", month(m)),
    memoryDir: j("memory"),
    memoryIndexFile: j("memory", "MEMORY.md"),
    factsDir: j("memory", "facts"),
    factFile: (n) => j("memory", "facts", `${name(n, "fact name")}.md`),
    playbooksDir: j("memory", "playbooks"),
    playbookFile: (n) => j("memory", "playbooks", `${name(n, "playbook name")}.md`),
    reportsDir: j("reports"),
    reportTypeDir: (t) => j("reports", name(t, "report type")),
    reportCurrentFile: (t) => j("reports", name(t, "report type"), "current.md"),
    reportDatedFile: (t, d) => {
      assert(isDate(d), "date", d);
      return j("reports", name(t, "report type"), `${d}.md`);
    },
    runsDir: j("runs"),
    runsMonthDir: (m) => j("runs", month(m)),
    runFile: (m, id) => {
      assert(isRunId(id), "run id", id);
      return j("runs", month(m), `${id}.yaml`);
    },
    briefingsDir: j(".managers", "briefings"),
    triggersDir: j(".managers", "triggers"),
    rel: (abs) => path.relative(dir, abs).split(path.sep).join("/"),
  };
}

/** The layout whose `memory/` every workspace shares: the projects root's. */
export function sharedMemoryLayout(projectsRoot: string): WorkspaceLayout {
  return workspaceLayout(projectsRoot);
}

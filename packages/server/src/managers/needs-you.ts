/**
 * needs-you — Home's cross-project "Needs you" collation (M13).
 *
 * One pass over every workspace (the root, which is Home, plus each project):
 * its awaiting-ed tasks, its alerts, and how old its status report is. Computed
 * on the server from the same mtime caches the per-workspace routes use, with no
 * model involved, so the list is exactly what `…/tasks?status=awaiting-ed` and
 * `…/alerts` would say for each workspace right now.
 *
 * A workspace that cannot be read (a task directory that is not a directory, a
 * permission error, …) becomes `{ slug, name, error }` and never fails the whole
 * collation: one broken project must not hide every other project's asks.
 *
 * Order (deterministic, see {@link orderGroups}):
 *   1. workspaces with asks, the one whose ask has waited LONGEST first;
 *   2. workspaces that could not be read;
 *   3. workspaces with alerts or unreadable task files only, worst severity first;
 *   4. quiet workspaces (only with `all`), by name.
 * Ties go by name, then slug.
 */
import path from "node:path";
import type { Alert, AlertSeverity } from "./alerts.js";
import type { ManagersState } from "./state.js";
import type { TaskSummary } from "./tasks-store.js";
import type { ParseError } from "./store-util.js";

/** A status report older than this is flagged (the M12 status card's "Out of date" threshold). */
export const STATUS_STALE_MS = 48 * 60 * 60 * 1000;

export interface NeedsYouStatus {
  /** When `reports/status/current.md` was generated (else written); null when there is none. */
  generated: string | null;
  /** Older than {@link STATUS_STALE_MS}. Never true without a report. */
  stale: boolean;
}

export interface NeedsYouGroup {
  slug: string;
  name: string;
  needsYou: TaskSummary[];
  alerts: Alert[];
  status: NeedsYouStatus;
  /** Task files in `tasks/open/` that will not parse — a hidden ask could be among them. */
  parseErrors: ParseError[];
}

export interface NeedsYouError {
  slug: string;
  name: string;
  /** What went wrong, with paths relative to the workspace (never absolute). */
  error: string;
}

export type NeedsYouEntry = NeedsYouGroup | NeedsYouError;

export interface NeedsYouTotals {
  /** Workspaces looked at (Home included), whether or not they are listed. */
  checked: number;
  /** Awaiting-ed tasks across every workspace. */
  needsYou: number;
  alerts: number;
  /** Workspaces that could not be read. */
  errors: number;
  /** Workspaces with anything to show (asks, alerts, unreadable task files). */
  withItems: number;
}

export interface NeedsYouResponse {
  generatedAt: string;
  projects: NeedsYouEntry[];
  totals: NeedsYouTotals;
}

/** The slice of a workspace the collation needs. */
export interface NeedsYouWorkspace {
  slug: string;
  name: string;
  dir: string;
}

export const isNeedsYouError = (e: NeedsYouEntry): e is NeedsYouError => "error" in e;

/** Anything to show for this workspace without `all`? */
export function hasItems(g: NeedsYouGroup): boolean {
  return g.needsYou.length > 0 || g.alerts.length > 0 || g.parseErrors.length > 0;
}

export function statusOf(generated: string | null, now: Date): NeedsYouStatus {
  const t = generated ? Date.parse(generated) : NaN;
  return { generated, stale: Number.isFinite(t) && now.getTime() - t > STATUS_STALE_MS };
}

/**
 * An error as one line, with any absolute path inside the workspace rewritten
 * relative to it (the collation is served to a browser; the data dir's location
 * is not its business). A path outside the workspace is dropped entirely.
 */
export function describeError(err: unknown, dir: string): string {
  const e = err as NodeJS.ErrnoException;
  const rel = (p: string) => {
    const r = path.relative(dir, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : "(outside the project)";
  };
  if (e && typeof e.code === "string" && typeof e.path === "string") {
    return `${e.code}: cannot read ${rel(e.path)}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split(dir + path.sep).join("").split(dir).join(".");
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { error: 0, warning: 1, info: 2 };

function worstSeverity(alerts: Alert[]): number {
  return alerts.reduce((w, a) => Math.min(w, SEVERITY_RANK[a.severity] ?? 3), 3);
}

/** When the longest-waiting ask was raised (its `updated`, else `created`); "" when unknown. */
function oldestAsk(tasks: TaskSummary[]): string {
  let oldest: string | null = null;
  for (const t of tasks) {
    const at = t.updated ?? t.created ?? "";
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest ?? "";
}

function rank(e: NeedsYouEntry): number {
  if (isNeedsYouError(e)) return 1;
  if (e.needsYou.length > 0) return 0;
  if (hasItems(e)) return 2;
  return 3;
}

/** The collation's order; see the module doc. Pure, and stable for equal keys. */
export function orderGroups(entries: NeedsYouEntry[]): NeedsYouEntry[] {
  const byName = (a: NeedsYouEntry, b: NeedsYouEntry) =>
    a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  return [...entries].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 0) {
      const ga = a as NeedsYouGroup;
      const gb = b as NeedsYouGroup;
      const w = oldestAsk(ga.needsYou).localeCompare(oldestAsk(gb.needsYou));
      if (w !== 0) return w;
    }
    if (rank(a) === 2) {
      const s = worstSeverity((a as NeedsYouGroup).alerts) - worstSeverity((b as NeedsYouGroup).alerts);
      if (s !== 0) return s;
    }
    return byName(a, b);
  });
}

/**
 * Collate every workspace. `alertsOf` is the per-workspace alerts computation
 * the `…/managers/alerts` route uses (injected so the collation and the route
 * can never disagree).
 */
export async function collectNeedsYou(opts: {
  state: ManagersState;
  workspaces: NeedsYouWorkspace[];
  alertsOf: (slug: string) => Promise<Alert[]>;
  all?: boolean;
  now?: Date;
}): Promise<NeedsYouResponse> {
  const now = opts.now ?? new Date();
  const entries = await Promise.all(
    opts.workspaces.map(async (w): Promise<NeedsYouEntry> => {
      try {
        const layout = opts.state.layout(w.dir);
        const [tasks, alerts, report] = await Promise.all([
          opts.state.tasks.list(layout, { status: ["awaiting-ed"] }),
          opts.alertsOf(w.slug),
          opts.state.reports.read(layout, "status", null),
        ]);
        return {
          slug: w.slug,
          name: w.name,
          needsYou: tasks.tasks,
          alerts,
          status: statusOf(report ? (report.generated ?? report.updated) : null, now),
          parseErrors: tasks.parseErrors,
        };
      } catch (err) {
        return { slug: w.slug, name: w.name, error: describeError(err, w.dir) };
      }
    }),
  );
  const totals: NeedsYouTotals = { checked: entries.length, needsYou: 0, alerts: 0, errors: 0, withItems: 0 };
  for (const e of entries) {
    if (isNeedsYouError(e)) {
      totals.errors += 1;
      continue;
    }
    totals.needsYou += e.needsYou.length;
    totals.alerts += e.alerts.length;
    if (hasItems(e)) totals.withItems += 1;
  }
  const shown = entries.filter((e) => opts.all || isNeedsYouError(e) || hasItems(e));
  return { generatedAt: now.toISOString(), projects: orderGroups(shown), totals };
}

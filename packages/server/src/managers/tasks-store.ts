/**
 * tasks-store — one Markdown file per task (plan §4):
 *
 *   tasks/open/<id>.md            open | doing | blocked | awaiting-ed
 *   tasks/done/YYYY-MM/<id>.md    done | dropped (moved on close; git keeps history)
 *
 * `readdir` plus an mtime-keyed parse cache — no watchers, so a git checkout or
 * a hand edit is visible on the next request. The `done/` tree grows forever, so
 * it is read lazily: a listing covers `open/` unless a `month` is asked for, and
 * reports which done months exist so a client can page into them.
 */
import path from "node:path";
import { MONTH_RE, isTaskId, monthOfId, type WorkspaceLayout } from "./layout.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  TASK_STATUSES,
  describeZodError,
  taskReadSchema,
  type TaskFrontmatter,
  type TaskStatus,
} from "./schemas.js";
import { FileCache, listDirsDesc, listNames, splitSections, type ParseError, type Parsed } from "./store-util.js";

export interface TaskSummary extends TaskFrontmatter {
  /** Which tree the file is in. */
  location: "open" | "done";
  /** The `done/` month dir, when `location` is `done`. */
  month: string | null;
  file: string;
}

export interface TaskDetail extends TaskSummary {
  /** The body above `## Log`. */
  notes: string;
  /** The `## Log` bullet lines, oldest first, without the leading `- `. */
  log: string[];
}

interface ParsedTask {
  fm: TaskFrontmatter;
  notes: string;
  log: string[];
}

function parseTask(text: string, file: string): Parsed<ParsedTask> {
  const idFromName = path.basename(file, ".md");
  const doc = parseFrontmatter(text);
  if (!doc.hasFrontmatter) return { ok: false, error: "task file has no frontmatter" };
  const r = taskReadSchema.safeParse({ id: idFromName, ...doc.data });
  if (!r.success) return { ok: false, error: describeZodError(r.error) };
  if (r.data.id !== idFromName) {
    return { ok: false, error: `frontmatter id ${r.data.id} does not match the file name ${idFromName}` };
  }
  const { preamble, sections } = splitSections(doc.body);
  const notesParts = [preamble];
  let log: string[] = [];
  for (const s of sections) {
    if (s.heading.trim().toLowerCase() === "log" && log.length === 0) {
      log = s.body
        .split("\n")
        .filter((l) => /^\s*[-*] /.test(l))
        .map((l) => l.replace(/^\s*[-*] /, "").trimEnd());
    } else {
      notesParts.push(`## ${s.heading}\n${s.body}`);
    }
  }
  return { ok: true, value: { fm: r.data, notes: notesParts.filter(Boolean).join("\n\n"), log } };
}

export interface TaskFilter {
  status?: TaskStatus[];
  objective?: string;
  /** Read `tasks/done/<month>/` instead of `tasks/open/`. */
  month?: string;
}

export interface TaskList {
  tasks: TaskSummary[];
  /** Done months on disk, newest first — page into them with `month`. */
  doneMonths: string[];
  parseErrors: ParseError[];
}

export const isTaskStatus = (s: string): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s);

/** Awaiting Ed first (it is what the UI leads with), then by status, newest-updated first. */
const STATUS_RANK: Record<TaskStatus, number> = {
  "awaiting-ed": 0,
  doing: 1,
  blocked: 2,
  open: 3,
  done: 4,
  dropped: 5,
};

export class TasksStore {
  private readonly cache = new FileCache<ParsedTask>(parseTask);

  async list(layout: WorkspaceLayout, filter: TaskFilter = {}): Promise<TaskList> {
    const month = filter.month ?? null;
    const dir = month ? layout.tasksDoneMonthDir(month) : layout.tasksOpenDir;
    const tasks: TaskSummary[] = [];
    const parseErrors: ParseError[] = [];
    for (const name of await listNames(dir, ".md")) {
      const abs = path.join(dir, `${name}.md`);
      const got = await this.cache.get(abs);
      if (!got) continue;
      if (!got.ok) {
        parseErrors.push({ file: layout.rel(abs), error: got.error });
        continue;
      }
      const t = got.value.fm;
      if (filter.status && !filter.status.includes(t.status)) continue;
      if (filter.objective && t.objective !== filter.objective) continue;
      tasks.push({ ...t, location: month ? "done" : "open", month, file: layout.rel(abs) });
    }
    tasks.sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (b.updated ?? "").localeCompare(a.updated ?? "") ||
        a.id.localeCompare(b.id),
    );
    return { tasks, doneMonths: await listDirsDesc(layout.tasksDoneDir, MONTH_RE), parseErrors };
  }

  /**
   * One task by id: `open/` first, then the done month its id dates from, then
   * every other done month (a task closed in a later month than it was created).
   */
  async get(layout: WorkspaceLayout, id: string): Promise<TaskDetail | { parseError: ParseError } | null> {
    if (!isTaskId(id)) return null;
    const candidates: { abs: string; month: string | null }[] = [
      { abs: path.join(layout.tasksOpenDir, `${id}.md`), month: null },
    ];
    const months = await listDirsDesc(layout.tasksDoneDir, MONTH_RE);
    const home = monthOfId(id);
    for (const m of [...months.filter((x) => x === home), ...months.filter((x) => x !== home)]) {
      candidates.push({ abs: path.join(layout.tasksDoneMonthDir(m), `${id}.md`), month: m });
    }
    for (const { abs, month } of candidates) {
      const got = await this.cache.get(abs);
      if (!got) continue;
      if (!got.ok) return { parseError: { file: layout.rel(abs), error: got.error } };
      return {
        ...got.value.fm,
        location: month ? "done" : "open",
        month,
        file: layout.rel(abs),
        notes: got.value.notes,
        log: got.value.log,
      };
    }
    return null;
  }
}

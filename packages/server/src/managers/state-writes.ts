/**
 * state-writes — the ONE place Managers domain state is written (M5, plan §2.6).
 *
 * Agents (through the `managers` MCP state tools) and the UI (through the write
 * REST routes) both land here, so the validation rules and the serialisation are
 * shared rather than re-implemented per transport:
 *
 *   • every write runs inside the per-workspace {@link WriteQueue};
 *   • ids are minted under that lock and checked against what is on disk;
 *   • every record is validated through the STRICT `*WriteSchema` before it
 *     touches the disk. An update never echoes the lenient read DTO back: it
 *     re-reads the file's RAW frontmatter, fills only the absent keys with their
 *     defaults, applies the change and validates the result. Keys a human added
 *     by hand that the schema does not know are preserved verbatim after the
 *     validated ones — a write must never silently delete Ed's data.
 *   • after a successful write, {@link StateWriter.onWrite} fires so the
 *     autocommitter can schedule a commit.
 *
 * Errors are {@link StateWriteError}s carrying a REST-shaped `code`
 * (`invalid` → 400, `not_found` → 404, `conflict` → 409); the MCP layer turns the
 * message into an error tool result.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { WriteQueue, appendText, writeFileAtomic } from "./write-queue.js";
import { isName, isRunId, isTaskId, monthOfId, MONTH_RE, type WorkspaceLayout } from "./layout.js";
import { newEpisodeId, newRunId, newTaskId, mintUnique } from "./ids.js";
import { evaluateExpect } from "./expect.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import {
  CLOSED_TASK_STATUSES,
  EPISODE_MAX_TEXT,
  OBJECTIVE_STATUSES,
  TASK_SOURCES,
  TASK_STATUSES,
  describeZodError,
  episodeWriteSchema,
  objectiveWriteSchema,
  runWriteSchema,
  taskWriteSchema,
  type EpisodeWrite,
  type ObjectiveStatus,
  type RunWrite,
  type TaskSource,
  type TaskStatus,
} from "./schemas.js";
import { formatEpisode, type EpisodesStore } from "./episodes-store.js";
import { MemoryStore } from "./memory-store.js";
import { memoryPreamble, renderMemoryFile, isSupersededFact } from "./memory-index.js";
import { CONFIDENCE_LEVELS, FACT_TYPES, factWriteSchema, type FactType } from "./schemas.js";
import { EPISODE_ID_RE } from "./layout.js";
import { listDirsDesc, splitSections } from "./store-util.js";
import type { GitAuthor } from "./autocommit.js";

// --- errors, actors, workspaces ----------------------------------------------

export type StateWriteErrorCode = "invalid" | "not_found" | "conflict";

export class StateWriteError extends Error {
  constructor(
    readonly code: StateWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StateWriteError";
  }
}

const invalid = (msg: string) => new StateWriteError("invalid", msg);

/** Who is writing. Drives the log-line attribution, `source`, and the commit author. */
export interface WriteActor {
  kind: "agent" | "ed";
  /** Shown in task log lines and `answer.by`: `manager`, or Ed's username. */
  name: string;
  /** Commit identity for the autocommit this write schedules. */
  author: GitAuthor;
  /** The Managers run this write belongs to (trigger fires; null until M6). */
  runId?: string | null;
  /** The chat session writing, when there is one. */
  sessionId?: string | null;
}

/** One workspace: its key (`""` is the root, Home) and its layout. */
export interface WriteWorkspace {
  key: string;
  layout: WorkspaceLayout;
}

export const workspaceLabel = (key: string): string => (key === "" ? "Home" : key);

// --- inputs --------------------------------------------------------------------

export interface RecordEpisodeInput {
  text: string;
  importance: number;
  tags?: string[];
  refs?: string[];
  /** File under this objective's journal instead of the project log. */
  objective?: string | null;
}

export interface UpsertTaskInput {
  /** Absent → create. */
  id?: string;
  title?: string;
  status?: TaskStatus;
  objective?: string | null;
  ask?: string | null;
  options?: string[];
  github?: string[];
  due?: string | null;
  shovel_ready?: boolean;
  /** Replaces the task's notes (the body above `## Log`). */
  notes?: string;
  source?: TaskSource;
  /** One line for the task's `## Log`; a summary is generated when absent. */
  log?: string;
}

export interface AnswerTaskInput {
  choice?: string;
  text?: string;
}

export interface UpdateObjectiveInput {
  id: string;
  title?: string;
  status?: ObjectiveStatus;
  success?: string;
  whereWeAre?: string;
  strategy?: string;
  lessons?: string;
  triggers?: string[];
}

export interface WriteReportInput {
  type: string;
  body: string;
}

export interface RecordArtifactInput {
  kind: string;
  ref: string;
  note?: string;
}

/** M14: one `memory_op`. */
export interface MemoryOpInput {
  op: "add" | "update" | "supersede" | "noop";
  name: string;
  type?: FactType;
  description?: string;
  /** The fact's text (above its `## History`). */
  body?: string;
  /** Episode ids that support the op; each must exist in this workspace. */
  evidence?: string[];
  since?: string;
  until?: string;
  confidence?: (typeof CONFIDENCE_LEVELS)[number];
  /** Why, for the `## History` line (supersede, update, noop). */
  reason?: string;
}

/** What a trigger fire knows when its run starts. */
export interface StartRunInput {
  trigger: string;
  kind: RunWrite["kind"];
  objective?: string | null;
  model?: string | null;
  expect?: RunWrite["expect"];
}

/** How a run ended (from the turn engine's completion hook). */
export interface FinishRunInput {
  status: "succeeded" | "failed" | "cancelled";
  sessionId?: string | null;
  model?: string | null;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null;
  mcpCalls?: Record<string, Record<string, number>>;
  /** M9.5: calls that errored (denied or failed), counted apart from `mcpCalls`. */
  mcpErrors?: Record<string, Record<string, number>>;
  error?: string | null;
}

// --- results -------------------------------------------------------------------

export interface WriteResult {
  id: string;
  /** Workspace-relative path of the file written. */
  file: string;
}

export interface EpisodeResult extends WriteResult {
  importance: number;
  objective: string | null;
}
export interface TaskResult extends WriteResult {
  status: TaskStatus;
  created: boolean;
  /** Set when the file moved between `open/` and `done/<month>/`. */
  movedFrom?: string;
}
export interface ObjectiveResult extends WriteResult {
  status: ObjectiveStatus;
  created: boolean;
}
export interface ReportResult {
  type: string;
  date: string;
  file: string;
  currentFile: string;
  /** M10: the previous dated report's date, or null. */
  previous: string | null;
  generated: string;
}
export interface MemoryOpResult {
  op: MemoryOpInput["op"];
  name: string;
  /** The fact file (absent for a noop). */
  file?: string;
  /** The regenerated index (absent for a noop). */
  index?: string;
  type?: FactType;
  until?: string | null;
  evidence?: string[];
  /** noop only: whether a fact of that name exists. */
  exists?: boolean;
}
export interface ArtifactResult {
  run: string;
  file: string;
  artifacts: number;
}

// --- limits and small helpers -------------------------------------------------

export const SECTION_MAX = 8000;
export const TASK_NOTES_MAX = 8000;
export const REPORT_MAX = 50_000;
export const LOG_LINE_MAX = 300;

/** Minute-precision UTC timestamp, `2026-09-26T07:05:00Z`. */
function isoMinute(d: Date): string {
  return `${d.toISOString().slice(0, 16)}:00Z`;
}
/** Second-precision UTC timestamp, `2026-09-26T07:05:13Z`. */
function isoSecond(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const dateOf = (d: Date) => d.toISOString().slice(0, 10);

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Free text that will be embedded in a Markdown file whose structure is `## `
 * headings (episode blocks, objective and task sections). A `## ` line inside it
 * would be read back as a new block/section, so it is refused, not escaped.
 */
function assertNoH2(text: string, what: string): void {
  if (/^## /m.test(text)) {
    throw invalid(`${what} must not contain a line starting with "## " (use "###" for sub-headings)`);
  }
}

function zodFail(what: string, err: z.ZodError): StateWriteError {
  return invalid(`${what}: ${describeZodError(err)}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function rawDoc(text: string, what: string): { data: Record<string, unknown>; body: string } {
  try {
    const doc = parseFrontmatter(text);
    if (!doc.hasFrontmatter) throw new Error("no frontmatter");
    return { data: doc.data, body: doc.body };
  } catch (err) {
    throw new StateWriteError(
      "conflict",
      `${what} does not parse (${(err as Error).message}); fix the file by hand before writing to it`,
    );
  }
}

/** The frontmatter keys each strict write schema owns; anything else is a hand-added extra. */
export const TASK_KEYS = [
  "id", "title", "status", "objective", "source", "ask", "options", "answer",
  "github", "dispatched", "shovel_ready", "due", "created", "updated",
] as const;
const OBJECTIVE_KEYS = Object.keys(objectiveWriteSchema.shape);
const FACT_KEYS = Object.keys(factWriteSchema.shape);
const RUN_KEYS = Object.keys(runWriteSchema.shape);

/** Split raw frontmatter into the schema's keys and the hand-added extras. */
function splitKnown(
  data: Record<string, unknown>,
  keys: readonly string[],
): { known: Record<string, unknown>; extra: Record<string, unknown> } {
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) (keys.includes(k) ? known : extra)[k] = v;
  return { known, extra };
}

/** Absent/null → fallback; a lone scalar → a one-item list (the lenient read's lift). */
function listOr(v: unknown): unknown {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** YAML may hand back `answer.choice: null`; the strict schema wants the key absent. */
function dropNulls(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null));
}

/**
 * Lift a raw (possibly hand-edited, possibly lenient) run mapping into the strict
 * write shape's conventions: nulls where the schema wants empty lists/maps, and
 * no null keys inside the nested objects the strict schema declares optional.
 */
function normaliseRun(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r };
  for (const k of ["episodes", "tasksTouched", "reports"]) out[k] = (listOr(out[k]) as unknown[]).map(String);
  out.artifacts = (listOr(out.artifacts) as unknown[]).map(dropNulls);
  if (out.mcpCalls === undefined || out.mcpCalls === null) out.mcpCalls = {};
  if (out.usage === undefined || out.usage === null) {
    out.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  if (out.expect && typeof out.expect === "object") {
    out.expect = Object.fromEntries(
      Object.entries(out.expect as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined),
    );
  } else out.expect = null;
  for (const k of ["objective", "finished", "sessionId", "model", "expectResult", "briefing", "error"]) {
    if (out[k] === undefined) out[k] = null;
  }
  return out;
}

// --- the writer ------------------------------------------------------------------

export type WriteListener = (dir: string, label: string, author: GitAuthor, reason: string) => void;

export class StateWriter {
  readonly queue = new WriteQueue();
  /** Called after every successful write (autocommit hooks in here). */
  onWrite: WriteListener | null = null;
  /**
   * Awaited INSIDE the workspace lock before every write — autocommit uses it to
   * commit another author's pending writes first.
   */
  beforeWrite: ((dir: string, author: GitAuthor) => Promise<void>) | null = null;

  /** Run `fn` under the workspace's lock, after the {@link beforeWrite} hook. */
  private locked<T>(ws: WriteWorkspace, actor: WriteActor, fn: () => Promise<T>): Promise<T> {
    const dir = path.resolve(ws.layout.dir);
    return this.queue.run(dir, async () => {
      if (this.beforeWrite) await this.beforeWrite(dir, actor.author).catch(() => undefined);
      return fn();
    });
  }

  constructor(
    private readonly episodes: EpisodesStore,
    private readonly now: () => Date = () => new Date(),
    private readonly memory: MemoryStore = new MemoryStore(),
  ) {}

  private notify(ws: WriteWorkspace, actor: WriteActor, reason: string): void {
    try {
      this.onWrite?.(ws.layout.dir, workspaceLabel(ws.key), actor.author, reason);
    } catch {
      /* a commit-scheduling failure must never fail the write */
    }
  }

  private async assertObjective(ws: WriteWorkspace, objective: string): Promise<void> {
    if (!isName(objective)) throw invalid(`objective must be a kebab-case objective id, got ${JSON.stringify(objective)}`);
    if (!(await exists(ws.layout.objectiveFile(objective)))) {
      throw new StateWriteError("not_found", `No such objective: ${objective}`);
    }
  }

  // --- episodes -----------------------------------------------------------------

  /**
   * M14: told after every episode written (outside the lock), except the
   * server's own `internal` ones — the consolidation early-fire check hooks in here.
   */
  onEpisode: ((ws: WriteWorkspace, episode: EpisodeResult, actor: WriteActor) => void) | null = null;

  async recordEpisode(
    ws: WriteWorkspace,
    input: RecordEpisodeInput,
    actor: WriteActor,
    opts: { internal?: boolean } = {},
  ): Promise<EpisodeResult> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw invalid("text is required");
    if (text.length > EPISODE_MAX_TEXT) {
      throw invalid(`text is ${text.length} characters; the limit is ${EPISODE_MAX_TEXT}`);
    }
    assertNoH2(text, "text");
    if (/(^|\n)refs:/i.test(text.split("\n").slice(-1)[0] ?? "")) {
      throw invalid('text must not end with a "refs:" line; pass refs separately');
    }
    const objective = input.objective ?? null;
    if (objective !== null) await this.assertObjective(ws, objective);
    const tags = (input.tags ?? []).map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean);
    const refs = (input.refs ?? []).map((r) => String(r).trim()).filter(Boolean);

    const result = await this.locked(ws, actor, async () => {
      const now = this.now();
      const idx = await this.episodes.index(ws.layout);
      const id = await mintUnique(() => newEpisodeId(now), (x) => idx.has(x));
      const draft: EpisodeWrite = {
        id,
        at: isoMinute(now),
        importance: input.importance,
        ...(actor.runId ? { run: actor.runId } : {}),
        ...(actor.sessionId ? { chat: actor.sessionId } : {}),
        ...(actor.kind === "ed" ? { source: "ed" as const } : {}),
        tags: [...new Set(tags)],
        text,
        refs: [...new Set(refs)],
      };
      const r = episodeWriteSchema.safeParse(draft);
      if (!r.success) throw zodFail("episode", r.error);
      const file = objective === null ? ws.layout.logFile(monthOf(now)) : ws.layout.journalFile(objective, monthOf(now));
      await appendText(file, formatEpisode(r.data));
      await this.touchRun(ws, actor, "episodes", id);
      this.notify(ws, actor, "record_episode");
      return { id, file: ws.layout.rel(file), importance: r.data.importance, objective };
    });
    if (!opts.internal && this.onEpisode) {
      try {
        this.onEpisode(ws, result, actor);
      } catch {
        /* a listener never fails the write */
      }
    }
    return result;
  }

  // --- tasks ------------------------------------------------------------------------

  /** Where a task's file is now: `open/`, or the first done month holding it. */
  private async locateTask(ws: WriteWorkspace, id: string): Promise<{ abs: string; month: string | null } | null> {
    const open = path.join(ws.layout.tasksOpenDir, `${id}.md`);
    if (await exists(open)) return { abs: open, month: null };
    const months = await listDirsDesc(ws.layout.tasksDoneDir, MONTH_RE);
    const home = monthOfId(id);
    for (const m of [...months.filter((x) => x === home), ...months.filter((x) => x !== home)]) {
      const abs = path.join(ws.layout.tasksDoneMonthDir(m), `${id}.md`);
      if (await exists(abs)) return { abs, month: m };
    }
    return null;
  }

  async upsertTask(ws: WriteWorkspace, input: UpsertTaskInput, actor: WriteActor): Promise<TaskResult> {
    if (input.id !== undefined && !isTaskId(input.id)) throw invalid(`Invalid task id: ${input.id}`);
    if (input.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(input.status)) {
      throw invalid(`status must be one of ${TASK_STATUSES.join(", ")}`);
    }
    if (input.source !== undefined && !(TASK_SOURCES as readonly string[]).includes(input.source)) {
      throw invalid(`source must be one of ${TASK_SOURCES.join(", ")}`);
    }
    if (input.source === "ed" && actor.kind !== "ed") throw invalid('source "ed" is reserved for tasks Ed creates');
    if (input.notes !== undefined) {
      if (input.notes.length > TASK_NOTES_MAX) throw invalid(`notes exceed ${TASK_NOTES_MAX} characters`);
      assertNoH2(input.notes, "notes");
    }
    if (input.objective) await this.assertObjective(ws, input.objective);

    return this.locked(ws, actor, async () => {
      const now = this.now();
      const stamp = isoSecond(now);
      let id = input.id;
      let prior: { abs: string; month: string | null; data: Record<string, unknown>; body: string } | null = null;
      if (id !== undefined) {
        const loc = await this.locateTask(ws, id);
        if (!loc) throw new StateWriteError("not_found", `No such task: ${id}`);
        const { data, body } = rawDoc(await fs.readFile(loc.abs, "utf8"), ws.layout.rel(loc.abs));
        prior = { ...loc, data, body };
      } else {
        if (!input.title || !input.title.trim()) throw invalid("title is required to create a task");
        id = await mintUnique(
          () => newTaskId(now),
          async (x) => (await this.locateTask(ws, x)) !== null,
        );
      }

      const { known, extra } = splitKnown(prior?.data ?? {}, TASK_KEYS);
      const base: Record<string, unknown> = {
        id,
        title: known.title,
        status: known.status ?? "open",
        objective: known.objective ?? null,
        source: known.source ?? (actor.kind === "ed" ? "ed" : "manager"),
        ask: known.ask ?? null,
        options: listOr(known.options),
        answer: known.answer ? dropNulls(known.answer) : null,
        github: listOr(known.github),
        dispatched: listOr(known.dispatched),
        shovel_ready: known.shovel_ready ?? false,
        due: known.due ?? null,
        created: known.created ?? stamp,
        updated: stamp,
      };
      const oldStatus = prior ? String(base.status) : null;
      const changed: string[] = [];
      const set = (k: string, v: unknown) => {
        if (v === undefined) return;
        if (JSON.stringify(base[k]) !== JSON.stringify(v)) changed.push(k);
        base[k] = v;
      };
      set("title", input.title?.trim());
      set("status", input.status);
      set("objective", input.objective);
      set("ask", input.ask === undefined ? undefined : input.ask === null ? null : input.ask.trim() || null);
      set("options", input.options);
      set("github", input.github);
      set("due", input.due);
      set("shovel_ready", input.shovel_ready);
      if (!prior) set("source", input.source ?? (actor.kind === "ed" ? "ed" : "manager"));
      // A fresh question supersedes the previous answer.
      if (prior && base.status === "awaiting-ed" && input.ask) base.answer = null;

      const r = taskWriteSchema.safeParse(base);
      if (!r.success) throw zodFail("task", r.error);
      const task = r.data;

      // Body: notes (everything but `## Log`) + the log, with one new line.
      const { notes: oldNotes, log } = splitTaskBody(prior?.body ?? "");
      const notes = input.notes !== undefined ? input.notes.trim() : oldNotes;
      const who = actor.kind === "ed" ? actor.name || "ed" : "manager";
      const where = actor.runId ? ` (run ${actor.runId})` : "";
      const summary = input.log
        ? oneLine(input.log, LOG_LINE_MAX)
        : !prior
          ? `created, ${task.status}`
          : oldStatus !== task.status
            ? `${oldStatus} → ${task.status}`
            : `updated ${changed.filter((k) => k !== "updated").join(", ") || "notes"}`;
      log.push(`${isoMinute(now).replace(":00Z", "Z")} ${who}${where}: ${summary}`);
      const body = `${notes ? `${notes}\n\n` : ""}## Log\n${log.map((l) => `- ${l}`).join("\n")}\n`;

      const closed = CLOSED_TASK_STATUSES.includes(task.status);
      const target = closed
        ? path.join(ws.layout.tasksDoneMonthDir(prior?.month ?? monthOf(now)), `${id}.md`)
        : path.join(ws.layout.tasksOpenDir, `${id}.md`);
      await writeFileAtomic(target, stringifyFrontmatter({ ...task, ...extra }, body));
      let movedFrom: string | undefined;
      if (prior && prior.abs !== target) {
        await fs.rm(prior.abs, { force: true });
        movedFrom = ws.layout.rel(prior.abs);
      }
      await this.touchRun(ws, actor, "tasksTouched", id!);
      this.notify(ws, actor, prior ? "upsert_task (update)" : "upsert_task (create)");
      return {
        id: id!,
        file: ws.layout.rel(target),
        status: task.status,
        created: !prior,
        ...(movedFrom ? { movedFrom } : {}),
      };
    });
  }

  /**
   * Ed answers an `awaiting-ed` task: records `answer`, reopens it, and journals
   * an `#answer` episode (`source: ed`) so the next wake's briefing sees it.
   */
  async answerTask(
    ws: WriteWorkspace,
    id: string,
    input: AnswerTaskInput,
    actor: WriteActor,
  ): Promise<{ task: TaskResult; episode: EpisodeResult }> {
    if (!isTaskId(id)) throw invalid(`Invalid task id: ${id}`);
    const choice = typeof input.choice === "string" ? input.choice.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!choice && !text) throw invalid("an answer needs a choice or some text");
    if (text.length > 4000) throw invalid("answer text exceeds 4000 characters");

    let title = "";
    let objective: string | null = null;
    const task = await this.locked(ws, actor, async () => {
      const loc = await this.locateTask(ws, id);
      if (!loc) throw new StateWriteError("not_found", `No such task: ${id}`);
      const { data, body } = rawDoc(await fs.readFile(loc.abs, "utf8"), ws.layout.rel(loc.abs));
      if (data.status !== "awaiting-ed") {
        throw new StateWriteError("conflict", `Task ${id} is ${String(data.status)}, not awaiting-ed`);
      }
      const options = listOr(data.options) as unknown[];
      if (choice && options.length > 0 && !options.map(String).includes(choice)) {
        throw invalid(`choice must be one of: ${options.map(String).join(", ")}`);
      }
      title = typeof data.title === "string" ? data.title : "";
      objective = typeof data.objective === "string" && isName(data.objective) ? data.objective : null;
      const now = this.now();
      const stamp = isoSecond(now);
      const { known, extra } = splitKnown(data, TASK_KEYS);
      const next = {
        id,
        title: known.title,
        status: "open",
        objective: known.objective ?? null,
        source: known.source ?? "manager",
        ask: known.ask ?? null,
        options: listOr(known.options),
        answer: {
          by: actor.name || "ed",
          at: stamp,
          ...(choice ? { choice } : {}),
          ...(text ? { text } : {}),
        },
        github: listOr(known.github),
        dispatched: listOr(known.dispatched),
        shovel_ready: known.shovel_ready ?? false,
        due: known.due ?? null,
        created: known.created ?? stamp,
        updated: stamp,
      };
      const r = taskWriteSchema.safeParse(next);
      if (!r.success) throw zodFail("task", r.error);
      const { notes, log } = splitTaskBody(body);
      log.push(
        `${isoMinute(now).replace(":00Z", "Z")} ${actor.name || "ed"}: answered${choice ? ` "${oneLine(choice, 80)}"` : ""}, awaiting-ed → open`,
      );
      const target = path.join(ws.layout.tasksOpenDir, `${id}.md`);
      await writeFileAtomic(
        target,
        stringifyFrontmatter({ ...r.data, ...extra }, `${notes ? `${notes}\n\n` : ""}## Log\n${log.map((l) => `- ${l}`).join("\n")}\n`),
      );
      if (loc.abs !== target) await fs.rm(loc.abs, { force: true });
      this.notify(ws, actor, "answer task");
      return { id, file: ws.layout.rel(target), status: "open" as const, created: false };
    });

    const said = [choice && `"${oneLine(choice, 80)}"`, text && oneLine(text, 600)].filter(Boolean).join(" — ");
    let epText = `Ed answered ${id}${title ? ` (${oneLine(title, 120)})` : ""}: ${said}`;
    if (epText.length > EPISODE_MAX_TEXT) epText = `${epText.slice(0, EPISODE_MAX_TEXT - 1)}…`;
    epText = epText.replace(/^## /gm, "\\## ");
    const episode = await this.recordEpisode(
      ws,
      { text: epText, importance: 6, tags: ["answer"], refs: [id], objective },
      { ...actor, kind: "ed" },
    );
    return { task, episode };
  }

  // --- objectives ------------------------------------------------------------------

  async updateObjective(ws: WriteWorkspace, input: UpdateObjectiveInput, actor: WriteActor): Promise<ObjectiveResult> {
    const id = input.id;
    if (typeof id !== "string" || !isName(id)) throw invalid(`id must be a kebab-case objective id, got ${JSON.stringify(id)}`);
    if (input.status !== undefined && !(OBJECTIVE_STATUSES as readonly string[]).includes(input.status)) {
      throw invalid(`status must be one of ${OBJECTIVE_STATUSES.join(", ")}`);
    }
    const sections: [keyof UpdateObjectiveInput, string][] = [
      ["whereWeAre", "Where we are"],
      ["strategy", "Strategy"],
      ["lessons", "Lessons"],
    ];
    for (const [k, heading] of sections) {
      const v = input[k];
      if (v === undefined) continue;
      if (typeof v !== "string") throw invalid(`${heading} must be text`);
      if (v.length > SECTION_MAX) throw invalid(`${heading} exceeds ${SECTION_MAX} characters`);
      assertNoH2(v, heading);
    }

    return this.locked(ws, actor, async () => {
      const now = this.now();
      const stamp = isoSecond(now);
      const file = ws.layout.objectiveFile(id);
      const existing = await exists(file);
      if (!existing && (!input.title?.trim() || !input.success?.trim())) {
        throw new StateWriteError(
          "not_found",
          `No such objective: ${id}. To create it, pass both title and success.`,
        );
      }
      const prior = existing ? rawDoc(await fs.readFile(file, "utf8"), ws.layout.rel(file)) : null;
      const { known, extra } = splitKnown(prior?.data ?? {}, OBJECTIVE_KEYS);
      const fm: Record<string, unknown> = {
        title: input.title?.trim() ?? known.title,
        status: input.status ?? known.status ?? "active",
        success: input.success?.trim() ?? known.success,
        ...(input.triggers !== undefined
          ? { triggers: input.triggers }
          : known.triggers !== undefined && known.triggers !== null
            ? { triggers: listOr(known.triggers) }
            : {}),
        created: known.created ?? stamp,
        updated: stamp,
      };
      const r = objectiveWriteSchema.safeParse(fm);
      if (!r.success) throw zodFail("objective", r.error);

      // Replace the named sections in place; keep everything else (preamble,
      // Ed's own sections, their order). Missing known sections are appended in
      // the canonical order.
      const { preamble, sections: have } = splitSections(prior?.body ?? "");
      const byHeading = new Map(sections.map(([k, h]) => [h.toLowerCase(), k]));
      const used = new Set<string>();
      const out: { heading: string; body: string }[] = have.map((s) => {
        const k = byHeading.get(s.heading.trim().toLowerCase());
        if (k && !used.has(k) && input[k] !== undefined) {
          used.add(k);
          return { heading: s.heading, body: String(input[k]).trim() };
        }
        if (k) used.add(k);
        return s;
      });
      for (const [k, heading] of sections) {
        if (!used.has(k) && input[k] !== undefined) out.push({ heading, body: String(input[k]).trim() });
      }
      const parts = [preamble, ...out.map((s) => `## ${s.heading}\n${s.body}`)].filter((p) => p.length > 0);
      await writeFileAtomic(file, stringifyFrontmatter({ ...r.data, ...extra }, `${parts.join("\n\n")}\n`));
      this.notify(ws, actor, existing ? "update_objective" : "update_objective (create)");
      return { id, file: ws.layout.rel(file), status: r.data.status, created: !existing };
    });
  }

  // --- reports (M10) ---------------------------------------------------------------------

  /**
   * Write a report: `reports/<type>/YYYY-MM-DD.md` (the last write of a day wins)
   * and `current.md`, atomically, under the workspace lock, and note the type on
   * the current run. The caller validates the type against the workspace's
   * effective report types and supplies `compose`, which turns the stripped body
   * plus the server's facts (`date`, `generated`, `previous` — the latest dated
   * report before today, found under the lock) into the file's frontmatter and
   * body (`reports.ts` `composeReport`). Without `compose` the body is written
   * under a minimal frontmatter (tests, and any caller outside the MCP tool).
   */
  async writeReport(
    ws: WriteWorkspace,
    input: WriteReportInput,
    actor: WriteActor,
    compose?: (c: { date: string; generated: string; previous: string | null; runId: string | null }) =>
      | { frontmatter: Record<string, unknown>; body: string }
      | Promise<{ frontmatter: Record<string, unknown>; body: string }>,
  ): Promise<ReportResult> {
    const type = typeof input.type === "string" ? input.type.trim() : "";
    if (!isName(type)) throw invalid(`type must be a kebab-case report type, got ${JSON.stringify(input.type)}`);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw invalid("body is required");
    if (body.length > REPORT_MAX) throw invalid(`body exceeds ${REPORT_MAX} characters`);
    return this.locked(ws, actor, async () => {
      const now = this.now();
      const date = dateOf(now);
      const generated = isoSecond(now);
      const runId = actor.runId ?? null;
      const previous =
        (await fs.readdir(ws.layout.reportTypeDir(type)).catch(() => [] as string[]))
          .map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1])
          .filter((d): d is string => typeof d === "string" && d < date)
          .sort()
          .pop() ?? null;
      const composed = compose
        ? await compose({ date, generated, previous, runId })
        : { frontmatter: { type, generated, run: runId, previous }, body: `${body}\n` };
      const text = stringifyFrontmatter(composed.frontmatter, composed.body);
      const dated = ws.layout.reportDatedFile(type, date);
      const current = ws.layout.reportCurrentFile(type);
      await writeFileAtomic(dated, text);
      await writeFileAtomic(current, text);
      await this.touchRun(ws, actor, "reports", type);
      this.notify(ws, actor, `write_report (${type})`);
      return { type, date, file: ws.layout.rel(dated), currentFile: ws.layout.rel(current), previous, generated };
    });
  }


  // --- semantic memory (M14) ----------------------------------------------------------

  /**
   * One `memory_op` on this workspace's `memory/facts/`, then the regenerated
   * `MEMORY.md` index (Ed's preamble above the marker kept verbatim). Under the
   * workspace lock. NEVER deletes: `supersede` sets `until` and appends to
   * `## History`; `update` appends to it; `noop` writes nothing. Every evidence id
   * must exist in this workspace's journals or log, and a `pattern` needs two.
   * WHO may call it is the caller's business (state-ops.ts): only Ed's live turn
   * and a consolidation run. `who` is the `## History` attribution.
   */
  async memoryOp(ws: WriteWorkspace, input: MemoryOpInput, actor: WriteActor, who: string): Promise<MemoryOpResult> {
    const OPS = ["add", "update", "supersede", "noop"] as const;
    const op = input.op;
    if (!(OPS as readonly string[]).includes(op)) throw invalid(`op must be one of ${OPS.join(", ")}`);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!isName(name)) throw invalid(`name must be a kebab-case fact name, got ${JSON.stringify(input.name)}`);
    if (input.type !== undefined && !(FACT_TYPES as readonly string[]).includes(input.type)) {
      throw invalid(`type must be one of ${FACT_TYPES.join(", ")}`);
    }
    if (input.confidence !== undefined && !(CONFIDENCE_LEVELS as readonly string[]).includes(input.confidence)) {
      throw invalid(`confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
    }
    const evidence = [...new Set((input.evidence ?? []).map((e) => String(e).trim()).filter(Boolean))];
    const badId = evidence.find((e) => !EPISODE_ID_RE.test(e));
    if (badId) throw invalid(`evidence must be episode ids (ep-YYMMDD-HHMM-xx), got ${JSON.stringify(badId)}`);
    const description = input.description === undefined ? undefined : oneLine(String(input.description), 300);
    const body = input.body === undefined ? undefined : String(input.body).replace(/\r\n?/g, "\n").trim();
    if (body !== undefined) {
      if (body.length > SECTION_MAX) throw invalid(`body exceeds ${SECTION_MAX} characters`);
      assertNoH2(body, "body");
    }
    const reason = input.reason === undefined ? undefined : oneLine(String(input.reason), 300);
    if (op === "add") {
      if (!input.type) throw invalid("add needs a type");
      if (!description) throw invalid("add needs a description (one line: what the fact says)");
    }
    if (op !== "supersede" && input.until !== undefined) throw invalid("until is set only by supersede");

    return this.locked(ws, actor, async () => {
      const now = this.now();
      const today = dateOf(now);
      const file = ws.layout.factFile(name);
      const rel = ws.layout.rel(file);
      const existing = (await exists(file)) ? rawDoc(await fs.readFile(file, "utf8"), rel) : null;

      if (op === "noop") return { op, name, exists: existing !== null };

      // Evidence must EXIST (an index lookup over this workspace's journals and log).
      const idx = evidence.length ? await this.episodes.index(ws.layout) : new Map();
      const missing = evidence.filter((e) => !idx.has(e));
      if (missing.length) {
        throw invalid(
          `evidence not found in this workspace's journals or log: ${missing.join(", ")}. Cite episode ids from the briefing.`,
        );
      }
      const stamp = `${isoMinute(now).slice(0, 10)} ${isoMinute(now).slice(11, 16)}Z`;
      const cite = (ids: string[]) => (ids.length ? ` — evidence ${ids.join(", ")}` : "");

      let fm: Record<string, unknown>;
      let extra: Record<string, unknown> = {};
      let text: string;
      if (op === "add") {
        if (existing) {
          throw new StateWriteError("conflict", `Fact ${name} already exists; update or supersede it instead`);
        }
        fm = {
          name,
          description,
          type: input.type,
          since: input.since ?? today,
          until: null,
          confidence: input.confidence ?? "medium",
          evidence,
        };
        text = `${body || description}\n\n## History\n- ${stamp} added by ${who}${cite(evidence)}\n`;
      } else {
        if (!existing) throw new StateWriteError("not_found", `No such fact: ${name} (add it instead)`);
        const split = splitKnown(existing.data, FACT_KEYS);
        extra = split.extra;
        const known = split.known;
        const prior = (listOr(known.evidence) as unknown[]).map(String);
        const merged = [...new Set([...prior, ...evidence])];
        const wasUntil = typeof known.until === "string" ? known.until : null;
        if (wasUntil && isSupersededFact({ until: wasUntil }, today)) {
          throw new StateWriteError(
            "conflict",
            `Fact ${name} was superseded on ${wasUntil.slice(0, 10)}; it is kept as history. Add a new fact instead`,
          );
        }
        const { preamble: oldBody, history } = splitFactBody(existing.body);
        const changed: string[] = [];
        fm = {
          name,
          description: known.description,
          type: known.type,
          since: known.since ?? today,
          until: known.until ?? null,
          confidence: known.confidence ?? "medium",
          evidence: merged,
        };
        if (op === "update") {
          if (description !== undefined && description !== known.description) (fm.description = description), changed.push("description");
          if (input.type !== undefined && input.type !== known.type) (fm.type = input.type), changed.push("type");
          if (input.confidence !== undefined && input.confidence !== known.confidence) (fm.confidence = input.confidence), changed.push("confidence");
          if (input.since !== undefined && input.since !== known.since) (fm.since = input.since), changed.push("since");
          if (body !== undefined && body !== oldBody.trim()) changed.push("body");
          const added = merged.length - prior.length;
          if (added > 0) changed.push(`evidence +${added}`);
        } else {
          fm.until = input.until ?? today;
        }
        const line =
          op === "update"
            ? `- ${stamp} updated by ${who}${changed.length ? ` (${changed.join(", ")})` : " (confirmed, no change)"}${cite(evidence)}${reason ? `: ${reason}` : ""}`
            : `- ${stamp} superseded by ${who}, until ${String(fm.until).slice(0, 10)}${cite(evidence)}${reason ? `: ${reason}` : ""}`;
        const newBody = op === "update" && body !== undefined ? body : oldBody.trim();
        text = `${newBody}\n\n## History\n${[...history, line].join("\n")}\n`;
      }
      if (fm.type === "pattern") {
        // Every id cited by THIS op was checked above; an older id on the fact may dangle.
        const existingIds = op === "add" ? evidence : await this.existingIds(ws, fm.evidence as string[]);
        if (existingIds.length < 2) {
          throw invalid(
            `a pattern needs at least 2 evidence episodes that exist (it has ${existingIds.length}); cite the episodes it was seen in`,
          );
        }
      }
      const r = factWriteSchema.safeParse(fm);
      if (!r.success) throw zodFail("fact", r.error);
      await writeFileAtomic(file, stringifyFrontmatter({ ...r.data, ...extra }, text));
      const index = await this.rewriteMemoryIndex(ws, today);
      this.notify(ws, actor, `memory_op (${op} ${name})`);
      return { op, name, file: rel, index, type: r.data.type, until: r.data.until, evidence: r.data.evidence };
    });
  }

  /** The ids among `ids` that exist in the workspace's episode index. */
  private async existingIds(ws: WriteWorkspace, ids: string[]): Promise<string[]> {
    const idx = await this.episodes.index(ws.layout);
    return ids.filter((e) => idx.has(e));
  }

  /** Regenerate `memory/MEMORY.md`'s index from `memory/facts/`. Call under the lock. */
  private async rewriteMemoryIndex(ws: WriteWorkspace, today: string): Promise<string> {
    const file = ws.layout.memoryIndexFile;
    const current = await fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    const view = await this.memory.view({ project: null, root: ws.layout });
    const facts = view.facts.filter((f) => f.scope === "root");
    await writeFileAtomic(file, renderMemoryFile(memoryPreamble(current), facts, today));
    return ws.layout.rel(file);
  }

  // --- artifacts -------------------------------------------------------------------------

  async recordArtifact(ws: WriteWorkspace, input: RecordArtifactInput, actor: WriteActor): Promise<ArtifactResult> {
    const runId = actor.runId ?? null;
    if (!runId) {
      throw new StateWriteError(
        "conflict",
        "record_artifact only works inside a trigger run, and this turn has no run",
      );
    }
    if (!isRunId(runId)) throw invalid(`Invalid run id: ${runId}`);
    const kind = typeof input.kind === "string" ? input.kind.trim() : "";
    const ref = typeof input.ref === "string" ? input.ref.trim() : "";
    if (!isName(kind)) throw invalid(`kind must be kebab-case (e.g. "commit", "pull-request"), got ${JSON.stringify(input.kind)}`);
    if (!ref || ref.length > 300 || /\s/.test(ref)) throw invalid("ref must be a single token of at most 300 characters");
    const note = input.note === undefined ? undefined : oneLine(String(input.note), 500);

    return this.locked(ws, actor, async () => {
      const { file, run } = await this.mutateRun(ws, runId, (known) => ({
        ...known,
        artifacts: [
          ...(listOr(known.artifacts) as unknown[]).map(dropNulls),
          { kind, ref, ...(note ? { note } : {}), at: isoSecond(this.now()) },
        ],
      }));
      this.notify(ws, actor, "record_artifact");
      return { run: runId, file: ws.layout.rel(file), artifacts: run.artifacts.length };
    });
  }

  // --- runs (M6) -----------------------------------------------------------------------

  /** The run record's file, looking in its id's month first, or null. Call under the lock. */
  private async findRunFile(ws: WriteWorkspace, runId: string): Promise<string | null> {
    const month = monthOfId(runId);
    const candidates = month ? [ws.layout.runFile(month, runId)] : [];
    for (const m of await listDirsDesc(ws.layout.runsDir, MONTH_RE)) {
      const f = ws.layout.runFile(m, runId);
      if (!candidates.includes(f)) candidates.push(f);
    }
    for (const f of candidates) if (await exists(f)) return f;
    return null;
  }

  /**
   * Read-modify-write one run record, strictly validated, keeping hand-added keys.
   * Call under the workspace lock.
   */
  private async mutateRun(
    ws: WriteWorkspace,
    runId: string,
    mutate: (known: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ file: string; run: RunWrite }> {
    const file = await this.findRunFile(ws, runId);
    if (!file) throw new StateWriteError("not_found", `No such run: ${runId}`);
    let data: Record<string, unknown>;
    try {
      const parsed = YAML.parse(await fs.readFile(file, "utf8"), { schema: "core" }) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a mapping");
      data = parsed as Record<string, unknown>;
    } catch (err) {
      throw new StateWriteError("conflict", `${ws.layout.rel(file)} does not parse (${(err as Error).message})`);
    }
    const { known, extra } = splitKnown(data, RUN_KEYS);
    const next = mutate({ ...known, id: known.id ?? runId });
    const r = runWriteSchema.safeParse(normaliseRun(next));
    if (!r.success) throw zodFail("run record", r.error);
    await writeFileAtomic(file, YAML.stringify({ ...r.data, ...extra }, { lineWidth: 0 }));
    return { file, run: r.data };
  }

  /**
   * Note on the current run that this write touched `id` (an episode, a task, a
   * report type). Best effort, under the caller's lock: a missing or hand-broken
   * run record must never fail the write that is being recorded.
   */
  private async touchRun(
    ws: WriteWorkspace,
    actor: WriteActor,
    field: "episodes" | "tasksTouched" | "reports",
    id: string,
  ): Promise<void> {
    const runId = actor.runId;
    if (!runId || !isRunId(runId)) return;
    await this.mutateRun(ws, runId, (known) => {
      const list = (listOr(known[field]) as unknown[]).map(String);
      return list.includes(id) ? known : { ...known, [field]: [...list, id] };
    }).catch(() => undefined);
  }

  /**
   * Start a run: mint its id under the lock (unique against the disk) and write
   * the record with `status: running`. Trigger fires only (plan M6).
   */
  async startRun(ws: WriteWorkspace, input: StartRunInput, actor: WriteActor): Promise<{ id: string; file: string }> {
    return this.locked(ws, actor, async () => {
      const now = this.now();
      const id = await mintUnique(
        () => newRunId(now),
        async (x) => (await this.findRunFile(ws, x)) !== null,
      );
      const rec = normaliseRun({
        id,
        trigger: input.trigger,
        kind: input.kind,
        objective: input.objective ?? null,
        status: "running",
        started: isoSecond(now),
        finished: null,
        sessionId: null,
        model: input.model ?? null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        episodes: [],
        tasksTouched: [],
        reports: [],
        artifacts: [],
        mcpCalls: {},
        expect: input.expect ?? null,
        expectResult: null,
        briefing: null,
        error: null,
      });
      const r = runWriteSchema.safeParse(rec);
      if (!r.success) throw zodFail("run record", r.error);
      const file = ws.layout.runFile(monthOf(now), id);
      await writeFileAtomic(file, YAML.stringify(r.data, { lineWidth: 0 }));
      this.notify(ws, actor, `run start (${input.trigger})`);
      return { id, file: ws.layout.rel(file) };
    });
  }

  /**
   * Keep "what the manager saw" (M7): write the briefing a run was woken with to
   * the gitignored `.managers/briefings/<run>.md` and note its path and sha256 on
   * the run record.
   */
  async recordBriefing(
    ws: WriteWorkspace,
    runId: string,
    text: string,
    actor: WriteActor,
  ): Promise<{ path: string; sha256: string }> {
    if (!isRunId(runId)) throw invalid(`Invalid run id: ${runId}`);
    return this.locked(ws, actor, async () => {
      const abs = path.join(ws.layout.briefingsDir, `${runId}.md`);
      await writeFileAtomic(abs, text);
      const briefing = { path: ws.layout.rel(abs), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
      await this.mutateRun(ws, runId, (known) => ({ ...known, briefing }));
      this.notify(ws, actor, `run briefing (${runId})`);
      return briefing;
    });
  }

  /**
   * Finish a running run: its outcome, usage and MCP call counts, then evaluate
   * `expect` against what the run recorded. Refuses (409) a run that is not
   * `running`, so a run is finished exactly once.
   */
  async finishRun(ws: WriteWorkspace, runId: string, input: FinishRunInput, actor: WriteActor): Promise<RunWrite> {
    if (!isRunId(runId)) throw invalid(`Invalid run id: ${runId}`);
    return this.locked(ws, actor, async () => {
      const now = this.now();
      const { run } = await this.mutateRun(ws, runId, (known) => {
        if (known.status !== "running") {
          throw new StateWriteError("conflict", `Run ${runId} is already ${String(known.status)}`);
        }
        const merged: Record<string, unknown> = {
          ...known,
          status: input.status,
          finished: isoSecond(now),
          sessionId: input.sessionId ?? known.sessionId ?? null,
          model: input.model ?? known.model ?? null,
          usage: input.usage
            ? {
                inputTokens: input.usage.inputTokens,
                outputTokens: input.usage.outputTokens,
                cacheReadTokens: input.usage.cacheReadTokens,
                cacheCreationTokens: input.usage.cacheCreationTokens,
              }
            : known.usage,
          mcpCalls: input.mcpCalls ?? known.mcpCalls ?? {},
          ...(input.mcpErrors && Object.keys(input.mcpErrors).length > 0 ? { mcpErrors: input.mcpErrors } : {}),
          error: input.error ? oneLine(input.error, 500) : null,
        };
        const probe = runWriteSchema.safeParse(normaliseRun(merged));
        merged.expectResult = probe.success ? evaluateExpect(probe.data) : "missing";
        return merged;
      });
      this.notify(ws, actor, `run finish (${run.trigger}, ${run.status})`);
      return run;
    });
  }
}

/** A fact body → its text (everything but `## History`) and its history lines. */
export function splitFactBody(body: string): { preamble: string; history: string[] } {
  const { preamble, sections } = splitSections(body);
  const rest = [preamble];
  let history: string[] = [];
  let seen = false;
  for (const s of sections) {
    if (!seen && s.heading.trim().toLowerCase() === "history") {
      seen = true;
      history = s.body.split("\n").filter((l) => /^\s*[-*] /.test(l)).map((l) => l.trimEnd());
    } else rest.push(`## ${s.heading}\n${s.body}`);
  }
  return { preamble: rest.filter(Boolean).join("\n\n"), history };
}

/** A task body → its notes (everything but `## Log`) and its log lines. */
export function splitTaskBody(body: string): { notes: string; log: string[] } {
  const { preamble, sections } = splitSections(body);
  const notes = [preamble];
  let log: string[] = [];
  let seenLog = false;
  for (const s of sections) {
    if (!seenLog && s.heading.trim().toLowerCase() === "log") {
      seenLog = true;
      log = s.body
        .split("\n")
        .filter((l) => /^\s*[-*] /.test(l))
        .map((l) => l.replace(/^\s*[-*] /, "").trimEnd());
    } else {
      notes.push(`## ${s.heading}\n${s.body}`);
    }
  }
  return { notes: notes.filter(Boolean).join("\n\n"), log };
}

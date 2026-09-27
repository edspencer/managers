/**
 * The Managers state tools on the `managers` MCP server (M5, plan §2.3).
 *
 *   state-read   get_briefing, list_objectives, read_objective, list_tasks, read_task, list_memory, list_alerts
 *   state-write  record_episode, upsert_task, update_objective, write_report, record_artifact
 *   memory       memory_op (M14): add / update / supersede / noop one fact; refused unless Ed's own
 *                message drives the turn, or the turn is a consolidation run
 *
 *   list_alerts  (M6) the dead-man's-switch alerts, computed fresh
 *
 *   get_briefing (M7) the deterministic wake briefing, built fresh
 *
 * The block is injected on EVERY keeper and trigger turn (unlike the chat-read
 * and spawn-write blocks, which keep their opt-in gates): the tools start no
 * turn, so there is no remote-code-execution risk and no depth gate. Writes are
 * serialised by the server (managers/write-queue.ts) and auto-committed.
 *
 * List-typed arguments are declared as STRINGS (one per line, or comma-separated)
 * for the same reason `fork_chat_batch` does it: the CLI-runtime MCP transport has
 * dropped array-typed args in practice. A real JSON array is accepted too.
 *
 * Every tool result is plain JSON for the agent to read. Write results carry the
 * written id and its workspace-relative file, so the agent can Read the file.
 */
import type { InjectedMcpServerDef, McpToolCallResult } from "@herdctl/core";
import type { ManagementStateOps } from "./managers/state-ops.js";
import { ok, fail, errText, redactPaths, coerceToolList, coerceBoolean } from "./self-mcp-util.js";
import { isMonth, isName, isTaskId } from "./managers/layout.js";
import {
  OBJECTIVE_STATUSES,
  TASK_SOURCES,
  TASK_STATUSES,
  EPISODE_MAX_TEXT,
  FACT_TYPES,
  CONFIDENCE_LEVELS,
} from "./managers/schemas.js";
import type { MemoryOpInput } from "./managers/state-writes.js";
import { isTaskStatus } from "./managers/tasks-store.js";
import { isParseFailure } from "./managers/store-util.js";
import type { TaskStatus, TaskSource, ObjectiveStatus } from "./managers/schemas.js";
import {
  LIST_OBJECTIVES_DESC,
  READ_OBJECTIVE_DESC,
  LIST_TASKS_DESC,
  READ_TASK_DESC,
  LIST_MEMORY_DESC,
  LIST_ALERTS_DESC,
  GET_BRIEFING_DESC,
  RECORD_EPISODE_DESC,
  UPSERT_TASK_DESC,
  UPDATE_OBJECTIVE_DESC,
  WRITE_REPORT_DESC,
  RECORD_ARTIFACT_DESC,
  MEMORY_OP_DESC,
} from "./self-mcp-descriptions.js";

type ServerTools = InjectedMcpServerDef["tools"];
type Args = Record<string, unknown>;

/** The target workspace: the arg when given (`""` is Home), else the current one. */
function projectOf(state: ManagementStateOps, args: Args): string {
  return typeof args.project === "string" ? args.project.trim() : state.currentProjectSlug;
}

/** An optional string arg: `undefined` when absent, the trimmed string otherwise. */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/** An optional, nullable string: `null` passes through (to clear a field). */
function optStrOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  return undefined;
}
function optList(v: unknown): string[] | undefined {
  return v === undefined || v === null ? undefined : coerceToolList(v);
}
function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Wrap a handler so any thrown error becomes an isError result with a clean message. */
function guarded(what: string, fn: (args: Args) => Promise<McpToolCallResult>) {
  return async (args: Args = {}): Promise<McpToolCallResult> => {
    try {
      return await fn(args ?? {});
    } catch (error) {
      return fail(`Error: ${what}: ${redactPaths(errText(error))}`);
    }
  };
}

const projectProp = {
  project: {
    type: "string",
    description:
      'Workspace to target: a project slug, or "" for Home (the root). Omit to use the ' +
      "current project — the only one you may WRITE to.",
  },
} as const;

/** Build the state tools (always) and `memory_op` (always registered; refuses unless allowed). */
export function stateTools(state: ManagementStateOps): ServerTools {
  return [
    // --- reads -----------------------------------------------------------------
    {
      name: "list_objectives",
      description: LIST_OBJECTIVES_DESC,
      inputSchema: { type: "object", properties: { ...projectProp } },
      handler: guarded("listing objectives", async (args) => {
        const project = projectOf(state, args);
        const r = await state.listObjectives(project);
        return ok({
          project,
          count: r.objectives.length,
          objectives: r.objectives.map((o) => ({
            id: o.id,
            title: o.title,
            status: o.status,
            success: o.success,
            updated: o.updated,
            file: o.file,
          })),
          ...(r.parseErrors.length ? { parseErrors: r.parseErrors } : {}),
        });
      }),
    },
    {
      name: "read_objective",
      description: READ_OBJECTIVE_DESC,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The objective id (its kebab-case directory name)." },
          before: { type: "string", description: "Journal paging: only months before this YYYY-MM." },
          months: { type: "number", description: "Journal paging: month files to include (default 3)." },
          ...projectProp,
        },
        required: ["id"],
      },
      handler: guarded("reading the objective", async (args) => {
        const project = projectOf(state, args);
        const id = optStr(args.id)?.trim() ?? "";
        if (!isName(id)) return fail(`Error: id must be a kebab-case objective id, got ${JSON.stringify(args.id)}`);
        const before = optStr(args.before);
        if (before !== undefined && !isMonth(before)) return fail("Error: before must be YYYY-MM");
        const months = num(args.months);
        const got = await state.readObjective(project, id, {
          ...(before ? { before } : {}),
          ...(months ? { months: Math.max(1, Math.min(24, Math.floor(months))) } : {}),
        });
        if (!got) return fail(`Error: no such objective: ${id}`);
        if (isParseFailure(got)) return fail(`Error: ${got.parseError.file} does not parse: ${got.parseError.error}`);
        return ok({ project, objective: got });
      }),
    },
    {
      name: "list_tasks",
      description: LIST_TASKS_DESC,
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: `Only these statuses, comma-separated (${TASK_STATUSES.join(", ")}).`,
          },
          objective: { type: "string", description: "Only tasks for this objective id." },
          month: {
            type: "string",
            description: "Read the closed tasks of this YYYY-MM instead of the open ones.",
          },
          ...projectProp,
        },
      },
      handler: guarded("listing tasks", async (args) => {
        const project = projectOf(state, args);
        let status: TaskStatus[] | undefined;
        const rawStatus = optList(args.status);
        if (rawStatus && rawStatus.length) {
          const bad = rawStatus.filter((s) => !isTaskStatus(s));
          if (bad.length) return fail(`Error: unknown task status: ${bad.join(", ")}`);
          status = rawStatus as TaskStatus[];
        }
        const objective = optStr(args.objective)?.trim() || undefined;
        if (objective !== undefined && !isName(objective)) return fail("Error: objective must be a kebab-case id");
        const month = optStr(args.month)?.trim() || undefined;
        if (month !== undefined && !isMonth(month)) return fail("Error: month must be YYYY-MM");
        const r = await state.listTasks(project, { status, objective, month });
        return ok({
          project,
          count: r.tasks.length,
          tasks: r.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            objective: t.objective,
            ask: t.ask,
            answer: t.answer,
            updated: t.updated,
            file: t.file,
          })),
          doneMonths: r.doneMonths,
          ...(r.parseErrors.length ? { parseErrors: r.parseErrors } : {}),
        });
      }),
    },
    {
      name: "read_task",
      description: READ_TASK_DESC,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The task id, t-YYMMDD-xxxx." }, ...projectProp },
        required: ["id"],
      },
      handler: guarded("reading the task", async (args) => {
        const project = projectOf(state, args);
        const id = optStr(args.id)?.trim() ?? "";
        if (!isTaskId(id)) return fail(`Error: id must be a task id (t-YYMMDD-xxxx), got ${JSON.stringify(args.id)}`);
        const got = await state.readTask(project, id);
        if (!got) return fail(`Error: no such task: ${id}`);
        if (isParseFailure(got)) return fail(`Error: ${got.parseError.file} does not parse: ${got.parseError.error}`);
        return ok({ project, task: got });
      }),
    },
    {
      name: "list_memory",
      description: LIST_MEMORY_DESC,
      inputSchema: { type: "object", properties: { ...projectProp } },
      handler: guarded("listing memory", async (args) => {
        const project = projectOf(state, args);
        const v = await state.listMemory(project);
        return ok({
          project,
          indexes: v.indexes,
          facts: v.facts.map((f) => ({
            name: f.name,
            description: f.description,
            type: f.type,
            scope: f.scope,
            confidence: f.confidence,
            file: f.file,
          })),
          playbooks: v.playbooks,
          ...(v.parseErrors.length ? { parseErrors: v.parseErrors } : {}),
        });
      }),
    },

    {
      name: "list_alerts",
      description: LIST_ALERTS_DESC,
      inputSchema: { type: "object", properties: { ...projectProp } },
      handler: guarded("listing alerts", async (args) => {
        const project = projectOf(state, args);
        const alerts = await state.listAlerts(project);
        return ok({ project, count: alerts.length, alerts });
      }),
    },

    {
      name: "get_briefing",
      description: GET_BRIEFING_DESC,
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Objective id to brief on in full (kebab-case)." },
          trigger: { type: "string", description: "Trigger name: brief as a wake of that trigger would." },
          ...projectProp,
        },
      },
      handler: guarded("building the briefing", async (args) => {
        const project = projectOf(state, args);
        const objective = optStr(args.objective)?.trim() || undefined;
        const trigger = optStr(args.trigger)?.trim() || undefined;
        if (objective !== undefined && !isName(objective)) return fail(`Error: objective must be a kebab-case id, got ${JSON.stringify(objective)}`);
        const b = await state.getBriefing(project, { objective, trigger });
        return ok({ project, objective: b.objective, sections: b.sections, text: b.text });
      }),
    },

    // --- writes --------------------------------------------------------------------
    {
      name: "record_episode",
      description: RECORD_EPISODE_DESC,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: `What happened, in your own words (≤${EPISODE_MAX_TEXT} chars).` },
          importance: { type: "number", description: "1 (routine) to 10 (pivotal)." },
          tags: { type: "string", description: "Tags, comma-separated, each [a-z0-9-] (e.g. \"dispatch, issues\")." },
          refs: {
            type: "string",
            description: "References, comma-separated: plain ids (t-…, ep-…, r-…) or owner/repo#N.",
          },
          objective: {
            type: "string",
            description: "File it in this objective's journal. Omit for the project log.",
          },
          ...projectProp,
        },
        required: ["text", "importance"],
      },
      handler: guarded("recording the episode", async (args) => {
        const project = projectOf(state, args);
        const importance = num(args.importance);
        if (importance === undefined || !Number.isInteger(importance) || importance < 1 || importance > 10) {
          return fail("Error: importance must be an integer from 1 to 10");
        }
        const r = await state.recordEpisode(project, {
          text: optStr(args.text) ?? "",
          importance,
          tags: optList(args.tags),
          refs: optList(args.refs),
          objective: optStr(args.objective)?.trim() || null,
        });
        return ok({ project, ...r });
      }),
    },
    {
      name: "upsert_task",
      description: UPSERT_TASK_DESC,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task to update. Omit to CREATE a task." },
          title: { type: "string", description: "Short title (required to create)." },
          status: {
            type: "string",
            enum: [...TASK_STATUSES],
            description: "New status. done/dropped move the file to tasks/done/<month>/. awaiting-ed needs `ask`.",
          },
          ask: { type: "string", description: "The question for Ed (required with awaiting-ed)." },
          options: { type: "string", description: "Answer choices for Ed, comma-separated (≤10)." },
          objective: { type: "string", description: "The objective id this task serves." },
          github: { type: "string", description: "GitHub refs, comma-separated (owner/repo#N)." },
          due: { type: "string", description: "Due date, YYYY-MM-DD." },
          shovel_ready: { type: "boolean", description: "Ready to dispatch without further thought." },
          notes: { type: "string", description: "Replaces the task's notes (the body above its log)." },
          source: { type: "string", enum: [...TASK_SOURCES], description: "On create: manager (default) or harvested." },
          log: { type: "string", description: "One line for the task's log. A summary is written when omitted." },
          ...projectProp,
        },
      },
      handler: guarded("upserting the task", async (args) => {
        const project = projectOf(state, args);
        const status = optStr(args.status)?.trim();
        if (status !== undefined && !isTaskStatus(status)) {
          return fail(`Error: status must be one of ${TASK_STATUSES.join(", ")}`);
        }
        const source = optStr(args.source)?.trim();
        if (source !== undefined && !(TASK_SOURCES as readonly string[]).includes(source)) {
          return fail(`Error: source must be one of ${TASK_SOURCES.join(", ")}`);
        }
        const r = await state.upsertTask(project, {
          id: optStr(args.id)?.trim() || undefined,
          title: optStr(args.title),
          status: status as TaskStatus | undefined,
          ask: optStrOrNull(args.ask),
          options: optList(args.options),
          objective: optStrOrNull(args.objective),
          github: optList(args.github),
          due: optStrOrNull(args.due),
          shovel_ready: args.shovel_ready === undefined ? undefined : coerceBoolean(args.shovel_ready, false),
          notes: optStr(args.notes),
          source: source as TaskSource | undefined,
          log: optStr(args.log),
        });
        return ok({ project, ...r });
      }),
    },
    {
      name: "update_objective",
      description: UPDATE_OBJECTIVE_DESC,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The objective id (kebab-case)." },
          title: { type: "string", description: "Title (required, with `success`, to create)." },
          success: { type: "string", description: "What success looks like (required to create)." },
          status: { type: "string", enum: [...OBJECTIVE_STATUSES], description: "New status." },
          where_we_are: { type: "string", description: "Replaces the rolling `## Where we are` summary." },
          strategy: { type: "string", description: "Replaces the `## Strategy` section." },
          lessons: { type: "string", description: "Replaces the `## Lessons` section." },
          triggers: { type: "string", description: "Trigger names bound to this objective, comma-separated." },
          ...projectProp,
        },
        required: ["id"],
      },
      handler: guarded("updating the objective", async (args) => {
        const project = projectOf(state, args);
        const status = optStr(args.status)?.trim();
        if (status !== undefined && !(OBJECTIVE_STATUSES as readonly string[]).includes(status)) {
          return fail(`Error: status must be one of ${OBJECTIVE_STATUSES.join(", ")}`);
        }
        const r = await state.updateObjective(project, {
          id: optStr(args.id)?.trim() ?? "",
          title: optStr(args.title),
          success: optStr(args.success),
          status: status as ObjectiveStatus | undefined,
          whereWeAre: optStr(args.where_we_are),
          strategy: optStr(args.strategy),
          lessons: optStr(args.lessons),
          triggers: optList(args.triggers),
        });
        return ok({ project, ...r });
      }),
    },
    {
      name: "write_report",
      description: WRITE_REPORT_DESC,
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: 'The report type (kebab-case), e.g. "status".' },
          body: { type: "string", description: "The report, in Markdown." },
          ...projectProp,
        },
        required: ["type", "body"],
      },
      handler: guarded("writing the report", async (args) => {
        const project = projectOf(state, args);
        const r = await state.writeReport(project, { type: optStr(args.type) ?? "", body: optStr(args.body) ?? "" });
        return ok({ project, ...r });
      }),
    },
    {
      name: "record_artifact",
      description: RECORD_ARTIFACT_DESC,
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: 'What it is, kebab-case: "commit", "pull-request", "comment", …' },
          ref: { type: "string", description: "Its reference: owner/repo#N, a commit sha, a URL." },
          note: { type: "string", description: "Optional one-line note (≤500 chars)." },
          ...projectProp,
        },
        required: ["kind", "ref"],
      },
      handler: guarded("recording the artifact", async (args) => {
        const project = projectOf(state, args);
        const r = await state.recordArtifact(project, {
          kind: optStr(args.kind) ?? "",
          ref: optStr(args.ref) ?? "",
          ...(typeof args.note === "string" ? { note: args.note } : {}),
        });
        return ok({ project, ...r });
      }),
    },
    {
      name: "memory_op",
      description: MEMORY_OP_DESC,
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["add", "update", "supersede", "noop"],
            description:
              "add: a new fact. update: refine or confirm an active one. supersede: an active fact is no longer " +
              "true (it is kept, with `until`). noop: an episode is already captured by `name`.",
          },
          name: { type: "string", description: "The fact's kebab-case name (its file is memory/facts/<name>.md)." },
          type: {
            type: "string",
            enum: [...FACT_TYPES],
            description: "What kind of fact (required for add). A `pattern` needs at least 2 evidence episodes.",
          },
          description: { type: "string", description: "One line: what the fact says (required for add; ≤300 chars)." },
          body: { type: "string", description: "The fact's text, in Markdown (no `## ` headings; use `###`)." },
          evidence: {
            type: "string",
            description:
              "Episode ids supporting the op (one per line, or comma-separated; a JSON array works too). Each must " +
              "exist in this project's journals or log.",
          },
          since: { type: "string", description: "When the fact became true (YYYY-MM-DD; default today)." },
          until: { type: "string", description: "supersede only: when it stopped being true (YYYY-MM-DD; default today)." },
          confidence: { type: "string", enum: [...CONFIDENCE_LEVELS], description: "low, medium (default) or high." },
          reason: { type: "string", description: "Why (one line, for the fact's History)." },
          ...projectProp,
        },
        required: ["op", "name"],
      },
      handler: guarded("memory_op", async (args) => {
        const project = projectOf(state, args);
        const r = await state.memoryOp(project, {
          op: (optStr(args.op)?.trim() ?? "") as MemoryOpInput["op"],
          name: optStr(args.name) ?? "",
          ...(optStr(args.type) ? { type: optStr(args.type)!.trim() as MemoryOpInput["type"] } : {}),
          ...(optStr(args.description) !== undefined ? { description: optStr(args.description) } : {}),
          ...(optStr(args.body) !== undefined ? { body: optStr(args.body) } : {}),
          ...(optList(args.evidence) ? { evidence: optList(args.evidence) } : {}),
          ...(optStr(args.since) ? { since: optStr(args.since)!.trim() } : {}),
          ...(optStr(args.until) ? { until: optStr(args.until)!.trim() } : {}),
          ...(optStr(args.confidence) ? { confidence: optStr(args.confidence)!.trim() as MemoryOpInput["confidence"] } : {}),
          ...(optStr(args.reason) !== undefined ? { reason: optStr(args.reason) } : {}),
        });
        return ok({ project, ...r });
      }),
    },
  ];
}

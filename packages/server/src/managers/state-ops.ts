/**
 * state-ops — the Managers state operations, bound to one caller (M5, plan §2.3).
 *
 * The transport-agnostic middle of the `managers` MCP state tools: it binds the
 * app-wide {@link ManagersState} stores and writer to the calling turn's
 * `currentProjectSlug`, `currentSessionId()` and `currentRunId()` (the trigger run
 * the turn belongs to, M6), and resolves a workspace key to its layout. Policy — which
 * principal may call which op on which project — is NOT here: it is applied by
 * `enforceManagementPolicy` (management-ops.ts), exactly as for the chat ops.
 *
 * Every op takes an explicit `project` (a workspace key; `""` is Home). The MCP
 * handlers default it to `currentProjectSlug` when the agent omits it.
 */
import type { ManagersState } from "./state.js";
import type { WorkspaceLayout } from "./layout.js";
import type { GitAuthor } from "./autocommit.js";
import type { TurnOrigin } from "../run-provenance.js";
import type { ObjectiveDetail, ObjectiveSummary } from "./objectives-store.js";
import type { TaskDetail, TaskFilter, TaskList } from "./tasks-store.js";
import type { MemoryView } from "./memory-store.js";
import type { PageOpts } from "./episodes-store.js";
import type { ParseError } from "./store-util.js";
import type { Alert } from "./alerts.js";
import type { Briefing } from "./briefing.js";
import { isName } from "./layout.js";
import { BUILTIN_REPORT_TYPES, composeReport, stripServerSections } from "./reports.js";
import {
  StateWriteError,
  type ArtifactResult,
  type EpisodeResult,
  type ObjectiveResult,
  type RecordArtifactInput,
  type RecordEpisodeInput,
  type ReportResult,
  type TaskResult,
  type UpdateObjectiveInput,
  type UpsertTaskInput,
  type WriteActor,
  type WriteReportInput,
  type WriteWorkspace,
} from "./state-writes.js";

/** A single-file read's outcome: the record, absent, or a file that won't parse. */
export type ReadOutcome<T> = T | null | { parseError: ParseError };

export interface ManagementStateOps {
  /** The workspace the calling turn runs in (`""` for Home, and for the external /mcp). */
  currentProjectSlug: string;
  /**
   * Whether `memory_op` may run in this turn: only when Ed is present
   * (a human-origin turn). M14 adds consolidation runs.
   */
  memoryAvailable: boolean;

  listObjectives(project: string): Promise<{ objectives: ObjectiveSummary[]; parseErrors: ParseError[] }>;
  readObjective(project: string, id: string, journal?: PageOpts): Promise<ReadOutcome<ObjectiveDetail>>;
  listTasks(project: string, filter?: TaskFilter): Promise<TaskList>;
  readTask(project: string, id: string): Promise<ReadOutcome<TaskDetail>>;
  listMemory(project: string): Promise<MemoryView>;
  /** The workspace's dead-man's-switch alerts (M6), computed fresh. */
  listAlerts(project: string): Promise<Alert[]>;
  /** The workspace's briefing (M7), built fresh: what a wake of `trigger` would see. */
  getBriefing(project: string, opts?: BriefingRequest): Promise<Briefing>;

  recordEpisode(project: string, input: RecordEpisodeInput): Promise<EpisodeResult>;
  upsertTask(project: string, input: UpsertTaskInput): Promise<TaskResult>;
  updateObjective(project: string, input: UpdateObjectiveInput): Promise<ObjectiveResult>;
  writeReport(project: string, input: WriteReportInput): Promise<ReportResult>;
  recordArtifact(project: string, input: RecordArtifactInput): Promise<ArtifactResult>;
  /** Stub until M14: refuses unless {@link memoryAvailable}, then reports "not implemented". */
  memoryOp(project: string, input: Record<string, unknown>): Promise<never>;
}

/** What `get_briefing` / the REST preview may ask for. */
export interface BriefingRequest {
  objective?: string | null;
  trigger?: string | null;
  kind?: "wake" | "chat";
}

export interface StateOpsParams {
  state: ManagersState;
  /** Resolve a workspace key to its directory (throws the ProjectStore's not-found). */
  resolveDir: (project: string) => Promise<string>;
  currentProjectSlug: string;
  currentSessionId: () => string | null;
  currentRunId: () => string | null;
  /** How the calling turn started; `external` for the /mcp transport. */
  origin: TurnOrigin | "external";
  /** Commit identity for agent writes (`managers-bot`). */
  botAuthor: GitAuthor;
  /** Compute a workspace's alerts (M6; shared with the REST route). */
  loadAlerts: (project: string) => Promise<Alert[]>;
  /** Build a workspace's briefing (M7; shared with the REST preview). */
  loadBriefing: (project: string, opts: BriefingRequest) => Promise<Briefing>;
  /**
   * M10: what `write_report` needs to know about a workspace — its display name
   * and its effective report types. Absent (bare tests): the built-in types and
   * the key as the name.
   */
  loadReportContext?: (project: string) => Promise<ReportContext>;
}

export interface ReportContext {
  name: string;
  types: string[];
}

export const MEMORY_OP_UNAVAILABLE =
  "memory_op is not available in this turn: memory is only edited while Ed is present " +
  "(a chat he started) or in a consolidation run.";

export function buildStateOps(p: StateOpsParams): ManagementStateOps {
  const { state } = p;
  const layoutOf = async (project: string): Promise<WorkspaceLayout> => state.layout(await p.resolveDir(project));
  const ws = async (project: string): Promise<WriteWorkspace> => ({ key: project, layout: await layoutOf(project) });
  const actor = (): WriteActor => ({
    kind: "agent",
    name: "manager",
    author: p.botAuthor,
    runId: p.currentRunId(),
    sessionId: p.currentSessionId(),
  });
  const memoryAvailable = p.origin === "human";

  return {
    currentProjectSlug: p.currentProjectSlug,
    memoryAvailable,
    listObjectives: async (project) => state.objectives.list(await layoutOf(project)),
    readObjective: async (project, id, journal) => state.objectives.get(await layoutOf(project), id, journal),
    listTasks: async (project, filter) => state.tasks.list(await layoutOf(project), filter),
    readTask: async (project, id) => state.tasks.get(await layoutOf(project), id),
    listMemory: async (project) => {
      const layout = await layoutOf(project);
      return state.memory.view({ project: project === "" ? null : layout, root: state.rootLayout });
    },
    listAlerts: (project) => p.loadAlerts(project),
    getBriefing: (project, opts = {}) => p.loadBriefing(project, opts),
    recordEpisode: async (project, input) => state.writer.recordEpisode(await ws(project), input, actor()),
    upsertTask: async (project, input) => state.writer.upsertTask(await ws(project), input, actor()),
    updateObjective: async (project, input) => state.writer.updateObjective(await ws(project), input, actor()),
    writeReport: async (project, input) => {
      // M10: the type must be one this workspace has; the server renders "Needs
      // you" and "Alerts" itself, so the model's own copies are dropped.
      const type = typeof input.type === "string" ? input.type.trim() : "";
      if (!isName(type)) {
        throw new StateWriteError("invalid", `type must be a kebab-case report type, got ${JSON.stringify(input.type)}`);
      }
      const ctx: ReportContext = p.loadReportContext
        ? await p.loadReportContext(project)
        : { name: project === "" ? "Home" : project, types: Object.keys(BUILTIN_REPORT_TYPES) };
      if (!ctx.types.includes(type)) {
        throw new StateWriteError(
          "invalid",
          `Unknown report type "${type}" here. This workspace's report types: ${ctx.types.join(", ") || "(none)"}. ` +
            "A new type is defined in project.yaml `reports:`.",
        );
      }
      const body = stripServerSections(typeof input.body === "string" ? input.body : "");
      if (!body.trim()) {
        throw new StateWriteError(
          "invalid",
          'body is empty once the server-rendered "Needs you" and "Alerts" sections are removed; write the report\'s own sections (e.g. "## In flight", "## Notes")',
        );
      }
      const w = await ws(project);
      const [tasks, alerts] = await Promise.all([
        state.tasks.list(w.layout, { status: ["awaiting-ed"] }),
        (p.loadAlerts?.(project) ?? Promise.resolve([])).catch(() => []),
      ]);
      return state.writer.writeReport(w, { type, body }, actor(), (c) =>
        composeReport({
          type,
          slug: project,
          projectName: ctx.name,
          date: c.date,
          generated: c.generated,
          runId: c.runId,
          previous: c.previous,
          body,
          tasks: tasks.tasks,
          alerts,
        }),
      );
    },
    recordArtifact: async (project, input) => state.writer.recordArtifact(await ws(project), input, actor()),
    memoryOp: async () => {
      if (!memoryAvailable) throw new StateWriteError("conflict", MEMORY_OP_UNAVAILABLE);
      throw new StateWriteError("conflict", "memory_op is not implemented yet (it lands with consolidation, M14)");
    },
  };
}

/**
 * Managers read routes (M4) — the domain state of one workspace, read-only.
 *
 * Registered once per workspace mount (see `workspace-mount.ts`), so every path
 * exists at both `/api/root/managers/…` (Home) and `/api/projects/:slug/managers/…`.
 * Everything sits under `managers/` so nothing collides with Paddock's own
 * `/runs` (chat History) routes (plan §2.7).
 *
 *   GET managers/objectives             list
 *   GET managers/objectives/:id         one, with a page of its journal (?before=YYYY-MM&months=N)
 *   GET managers/log                    the project-level episodic log, paged the same way
 *   GET managers/tasks                  open tasks (?status=a,b&objective=x), or a done month (?month=YYYY-MM)
 *   GET managers/tasks/:id
 *   GET managers/memory                 MEMORY.md + facts + playbooks, root and project, scope-tagged
 *   GET managers/memory/facts/:name     (?scope=root|project)
 *   GET managers/runs                   paged by month (?before&months&trigger&status)
 *   GET managers/runs/:id               the record + durationSeconds, chat, the alerts naming it (M6)
 *                                       and briefingText, the briefing the run was woken with (M7)
 *   GET managers/alerts                 the dead-man's-switch alerts, computed fresh (M6)
 *   GET managers/briefing               the wake briefing preview (M7) (?objective=&trigger=&kind=wake|chat)
 *   GET managers/reports                every report type with its current report's metadata
 *   GET managers/reports/:type          current report + dated list
 *   GET managers/reports/:type/:date
 *
 * Writes (M5) — through the same serialised writer the agents' MCP state tools
 * use (`managers/state-writes.ts`), so validation and ordering are shared, and
 * auto-committed as the requesting user:
 *
 *   POST  managers/tasks                 create a task
 *   PATCH managers/tasks/:id             update fields / status (done|dropped move it)
 *   POST  managers/tasks/:id/answer      Ed answers an awaiting-ed task {choice?, text?, wake?}
 *   POST  managers/objectives            create {id, title, success, …}
 *   PATCH managers/objectives/:id        update fields / sections
 *
 * Behaviours (M8): the one sanctioned way to switch autonomy.
 *
 *   GET   managers/behaviours                    effective behaviours + bound triggers + out-of-UI flag
 *   PATCH managers/behaviours/:name              {enabled}: writes project.yaml, re-arms, #autonomy episode, commit
 *   POST  managers/behaviours/acknowledge        accept an out-of-UI change (clears the alert)
 *
 * Connections (M9): the project's `mcp:` block, secret-free.
 *
 *   GET   managers/connections                   name, redacted url, header KEYS, env var names + set?, allowlist, errors
 *   POST  managers/connections/:name/probe       initialize + tools/list against the connection (10 s), sanitised error
 *
 * Write errors: 400 `invalid` (validation), 404 `not_found`, 409 `conflict`
 * (e.g. answering a task that is not awaiting-ed, creating an objective that exists).
 *
 * Errors: 404 `not_found` for an unknown workspace or id, 400 `invalid` for a
 * malformed id or query value (validated here, so the body keeps the house
 * `{ error, code }` shape), and 422 `parse_error` when the addressed file exists
 * but will not parse. LIST responses never fail on a bad file: it is skipped and
 * reported in `parseErrors` (present only when non-empty).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isRootKey } from "../project-paths.js";
import { sendProjectError } from "../route-errors.js";
import type { RouteCtx } from "../route-context.js";
import { ManagersState } from "../managers/state.js";
import { loadAlerts, type Alert } from "../managers/alerts.js";
import { briefingForWorkspace } from "../managers/briefing.js";
import { boundObjective } from "../managers/trigger-runs.js";
import {
  CONFIG_UNREADABLE_BEHAVIOUR,
  behavioursFor,
  isBehaviourName,
  triggerGate,
  type EffectiveBehaviour,
} from "../managers/behaviours.js";
import { behavioursChangedOutsideUi, writeBaseline } from "../managers/behaviour-state.js";
import { WriteQueue } from "../managers/write-queue.js";
import { mcpResolveEnv } from "../managers/mcp-secret-env.js";
import { workspaceLabel } from "../managers/state-writes.js";
import { resolveProjectMcp, type ProjectConnection, type ProjectMcpResolution } from "../managers/project-mcp.js";
import { probeConnection } from "../managers/mcp-probe.js";
import type { Project } from "../projects.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDate, isMonth, isName, isRunId, isTaskId, type WorkspaceLayout } from "../managers/layout.js";
import { RUN_STATUSES, type TaskStatus } from "../managers/schemas.js";
import { MAX_PAGE_MONTHS, type PageOpts } from "../managers/episodes-store.js";
import { isTaskStatus } from "../managers/tasks-store.js";
import { isParseFailure, type ParseError } from "../managers/store-util.js";
import {
  StateWriteError,
  type UpdateObjectiveInput,
  type UpsertTaskInput,
  type WriteActor,
  type WriteWorkspace,
} from "../managers/state-writes.js";
import type { ObjectiveStatus, TaskSource, TaskStatus as TStatus } from "../managers/schemas.js";

const TAGS = ["Managers"];

const slugParam = { slug: { type: "string", description: "Project slug (absent on the /api/root mount)." } };

function paramsSchema(extra: Record<string, { description: string }> = {}) {
  const props: Record<string, unknown> = { ...slugParam };
  for (const [k, v] of Object.entries(extra)) props[k] = { type: "string", description: v.description };
  return { type: "object", properties: props, required: ["slug", ...Object.keys(extra)] };
}

const pagingQuery = {
  before: { type: "string", description: "Only months strictly before this `YYYY-MM` (the previous page's `nextBefore`)." },
  months: { type: "string", description: `Month files per page, 1–${MAX_PAGE_MONTHS} (default 3).` },
};

const ok200 = (description: string) => ({
  200: { description, type: "object", additionalProperties: true },
});

type Q = Record<string, string | undefined>;

class Invalid extends Error {}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message, code: "invalid" });
}
function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: message, code: "not_found" });
}
function unparseable(reply: FastifyReply, parseError: ParseError) {
  return reply
    .code(422)
    .send({ error: `${parseError.file} does not parse: ${parseError.error}`, code: "parse_error", parseError });
}

/** `?before=&months=` → PageOpts, or throws {@link Invalid}. */
function paging(q: Q): PageOpts {
  const out: PageOpts = {};
  if (q.before !== undefined) {
    if (!isMonth(q.before)) throw new Invalid(`before must be YYYY-MM, got ${JSON.stringify(q.before)}`);
    out.before = q.before;
  }
  if (q.months !== undefined) {
    const n = Number(q.months);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_MONTHS) {
      throw new Invalid(`months must be an integer 1–${MAX_PAGE_MONTHS}`);
    }
    out.months = n;
  }
  return out;
}

/** Drop an empty `parseErrors` so a clean list is exactly `{ <items>: [...] }`. */
function tidy<T extends { parseErrors?: unknown[] }>(body: T): T {
  if (body.parseErrors && body.parseErrors.length === 0) {
    const { parseErrors: _drop, ...rest } = body;
    return rest as T;
  }
  return body;
}

/** A write failure → its REST status, keeping the house `{ error, code }` body. */
function writeError(reply: FastifyReply, err: StateWriteError) {
  const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
  return reply.code(status).send({ error: err.message, code: err.code });
}

type Body = Record<string, unknown>;

const bodySchema = (description: string) => ({
  type: "object",
  additionalProperties: true,
  description,
});

/** A string list from a JSON body: an array of strings, or absent. */
function listField(b: Body, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Invalid(`${key} must be an array of strings`);
  return v as string[];
}
function strField(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Invalid(`${key} must be a string`);
  return v;
}
function strOrNullField(b: Body, key: string): string | null | undefined {
  if (b[key] === null) return null;
  return strField(b, key);
}

function taskInput(b: Body): UpsertTaskInput {
  const shovel = b.shovel_ready;
  if (shovel !== undefined && typeof shovel !== "boolean") throw new Invalid("shovel_ready must be a boolean");
  return {
    title: strField(b, "title"),
    status: strField(b, "status") as TStatus | undefined,
    objective: strOrNullField(b, "objective"),
    ask: strOrNullField(b, "ask"),
    options: listField(b, "options"),
    github: listField(b, "github"),
    due: strOrNullField(b, "due"),
    shovel_ready: shovel as boolean | undefined,
    notes: strField(b, "notes"),
    source: strField(b, "source") as TaskSource | undefined,
    log: strField(b, "log"),
  };
}

function objectiveInput(id: string, b: Body): UpdateObjectiveInput {
  return {
    id,
    title: strField(b, "title"),
    success: strField(b, "success"),
    status: strField(b, "status") as ObjectiveStatus | undefined,
    whereWeAre: strField(b, "whereWeAre") ?? strField(b, "where_we_are"),
    strategy: strField(b, "strategy"),
    lessons: strField(b, "lessons"),
    triggers: listField(b, "triggers"),
  };
}

/** M9.5: behaviour switches are serialised per workspace directory (both mounts share it). */
const toggleLocks = new WriteQueue();

export function registerManagerWorkspaceRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { projects } = ctx;
  const state = ctx.managers ?? new ManagersState(ctx.cfg.projectsRoot);

  /**
   * The browser user as a write actor: commits carry their name when auth knows
   * it, else the configured `MANAGERS_GIT_AUTHOR_*` (plan §2.6).
   */
  function actorFor(req: FastifyRequest): WriteActor {
    const u = req.user;
    if (u && !u.anonymous && u.username) {
      return {
        kind: "ed",
        name: u.username,
        author: { name: u.username, email: u.email ?? `${u.username}@users.managers.invalid` },
      };
    }
    return { kind: "ed", name: "ed", author: ctx.cfg.gitAuthor };
  }

  /** Like {@link withWorkspace}, for writes: also maps {@link StateWriteError}. */
  async function withWrite(
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
    fn: (w: { ws: WriteWorkspace; actor: WriteActor; layout: WorkspaceLayout }) => Promise<unknown>,
  ) {
    try {
      const project = await projects.get(req.params.slug);
      const layout = state.layout(project.dir);
      return await fn({ ws: { key: req.params.slug, layout }, actor: actorFor(req), layout });
    } catch (err) {
      if (err instanceof Invalid) return invalid(reply, err.message);
      if (err instanceof StateWriteError) return writeError(reply, err);
      return sendProjectError(reply, err);
    }
  }

  /**
   * Resolve the workspace, then run `fn` with its layout. Unknown workspace →
   * 404 (via `sendProjectError`); a query/param the handler rejects → 400.
   */
  async function withWorkspace(
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
    fn: (w: { layout: WorkspaceLayout; isRoot: boolean }) => Promise<unknown>,
  ) {
    try {
      const project = await projects.get(req.params.slug);
      return await fn({ layout: state.layout(project.dir), isRoot: isRootKey(req.params.slug) });
    } catch (err) {
      if (err instanceof Invalid) return invalid(reply, err.message);
      return sendProjectError(reply, err);
    }
  }

  // --- objectives -------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    "/managers/objectives",
    {
      schema: {
        tags: TAGS,
        summary: "List the workspace's objectives",
        description:
          "Every `objectives/<id>/objective.md`, parsed: `{ objectives: [{ id, title, status, success, triggers, " +
          "created, updated, file }] }`, active first. A file that will not parse is skipped and listed in " +
          "`parseErrors` (present only when non-empty).",
        params: paramsSchema(),
        response: ok200("`{ objectives, parseErrors? }`."),
      },
    },
    (req, reply) => withWorkspace(req, reply, async ({ layout }) => tidy(await state.objectives.list(layout))),
  );

  app.get<{ Params: { slug: string; id: string }; Querystring: Q }>(
    "/managers/objectives/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Get one objective with a page of its journal",
        description:
          "The objective's frontmatter, its `whereWeAre` / `strategy` / `lessons` sections (plus `otherSections`), " +
          "and `journal`: one page of `journal/YYYY-MM.md` episodes, newest first, `months` files per page. " +
          "Pass `journal.nextBefore` as `before` for the next page. 400 for a malformed id or query, 404 for an " +
          "unknown objective, 422 when its file does not parse.",
        params: paramsSchema({ id: { description: "Objective id (kebab-case directory name)." } }),
        querystring: { type: "object", properties: pagingQuery },
        response: ok200("`{ objective }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const { id } = req.params;
        if (!isName(id)) throw new Invalid(`Invalid objective id: ${id}`);
        const got = await state.objectives.get(layout, id, paging(req.query));
        if (!got) return notFound(reply, `No such objective: ${id}`);
        if (isParseFailure(got)) return unparseable(reply, got.parseError);
        return { objective: { ...got, journal: tidy(got.journal) } };
      }),
  );

  // --- the project-level log ---------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: Q }>(
    "/managers/log",
    {
      schema: {
        tags: TAGS,
        summary: "Page through the workspace's episodic log",
        description:
          "Episodes in `log/YYYY-MM.md` (those not tied to an objective), newest first, paged by month exactly " +
          "like an objective's journal: `{ log: { entries, months, nextBefore, parseErrors? } }`.",
        params: paramsSchema(),
        querystring: { type: "object", properties: pagingQuery },
        response: ok200("`{ log }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => ({
        log: tidy(await state.episodes.page(layout, null, paging(req.query))),
      })),
  );

  // --- tasks ---------------------------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: Q }>(
    "/managers/tasks",
    {
      schema: {
        tags: TAGS,
        summary: "List tasks",
        description:
          "Tasks in `tasks/open/` — or, with `month=YYYY-MM`, the closed tasks in `tasks/done/<month>/` — " +
          "filtered by `status` (comma-separated: open, doing, blocked, awaiting-ed, done, dropped) and " +
          "`objective`. `awaiting-ed` sorts first. `doneMonths` lists the closed months on disk, newest first.",
        params: paramsSchema(),
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", description: "Comma-separated statuses to keep." },
            objective: { type: "string", description: "Only tasks for this objective id." },
            month: { type: "string", description: "Read this `YYYY-MM` done month instead of open tasks." },
          },
        },
        response: ok200("`{ tasks, doneMonths, parseErrors? }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const q = req.query;
        let status: TaskStatus[] | undefined;
        if (q.status !== undefined) {
          const parts = q.status.split(",").map((s) => s.trim()).filter(Boolean);
          const bad = parts.filter((s) => !isTaskStatus(s));
          if (bad.length || parts.length === 0) throw new Invalid(`Unknown task status: ${bad.join(", ") || "(empty)"}`);
          status = parts as TaskStatus[];
        }
        if (q.objective !== undefined && !isName(q.objective)) throw new Invalid(`Invalid objective id: ${q.objective}`);
        if (q.month !== undefined && !isMonth(q.month)) throw new Invalid(`month must be YYYY-MM, got ${JSON.stringify(q.month)}`);
        return tidy(await state.tasks.list(layout, { status, objective: q.objective, month: q.month }));
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/managers/tasks/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Get one task",
        description:
          "The task's frontmatter plus `notes` (the body above `## Log`), `log` (its log lines), `location` " +
          "(open|done) and `month`. Found in `open/` or any done month. 400 for a malformed id (t-YYMMDD-xxxx), " +
          "404 when absent, 422 when the file does not parse.",
        params: paramsSchema({ id: { description: "Task id, t-YYMMDD-xxxx." } }),
        response: ok200("`{ task }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const { id } = req.params;
        if (!isTaskId(id)) throw new Invalid(`Invalid task id: ${id}`);
        const got = await state.tasks.get(layout, id);
        if (!got) return notFound(reply, `No such task: ${id}`);
        if (isParseFailure(got)) return unparseable(reply, got.parseError);
        return { task: got };
      }),
  );

  // --- memory ----------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    "/managers/memory",
    {
      schema: {
        tags: TAGS,
        summary: "The workspace's semantic memory, with the shared root memory",
        description:
          "`indexes` (`MEMORY.md` split into Ed's `preamble` and the generated `index`, per scope), `facts` and " +
          "`playbooks`, each tagged `scope: project | root`. The root workspace's memory is shared with every " +
          "project, so a project sees both; the root sees only `root` (and `indexes.project` is null).",
        params: paramsSchema(),
        response: ok200("`{ indexes, facts, playbooks, parseErrors? }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout, isRoot }) =>
        tidy(await state.memory.view({ project: isRoot ? null : layout, root: state.rootLayout })),
      ),
  );

  app.get<{ Params: { slug: string; name: string }; Querystring: Q }>(
    "/managers/memory/facts/:name",
    {
      schema: {
        tags: TAGS,
        summary: "Get one memory fact",
        description:
          "One `memory/facts/<name>.md`: frontmatter, `body`, `history` and `scope`. Without `scope`, a project " +
          "fact wins over a root fact of the same name. 400 for a malformed name or scope, 404 when absent, 422 " +
          "when the file does not parse.",
        params: paramsSchema({ name: { description: "Fact name (kebab-case)." } }),
        querystring: {
          type: "object",
          properties: { scope: { type: "string", description: "`root` or `project`." } },
        },
        response: ok200("`{ fact }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout, isRoot }) => {
        const { name } = req.params;
        const scope = req.query.scope;
        if (!isName(name)) throw new Invalid(`Invalid fact name: ${name}`);
        if (scope !== undefined && scope !== "root" && scope !== "project") {
          throw new Invalid("scope must be root or project");
        }
        const got = await state.memory.getFact(
          { project: isRoot ? null : layout, root: state.rootLayout },
          name,
          scope,
        );
        if (!got) return notFound(reply, `No such fact: ${name}`);
        if (isParseFailure(got)) return unparseable(reply, got.parseError);
        return { fact: got };
      }),
  );

  // --- runs ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: Q }>(
    "/managers/runs",
    {
      schema: {
        tags: TAGS,
        summary: "List run records",
        description:
          "Trigger-run records (`runs/YYYY-MM/<id>.yaml`), newest first, paged by month; filter by `trigger` and " +
          "`status` (running, succeeded, failed, cancelled). These are Managers runs, not the chat History.",
        params: paramsSchema(),
        querystring: {
          type: "object",
          properties: {
            ...pagingQuery,
            trigger: { type: "string", description: "Only runs of this trigger." },
            status: { type: "string", description: "Only runs with this status." },
          },
        },
        response: ok200("`{ runs, months, nextBefore, parseErrors? }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const q = req.query;
        if (q.status !== undefined && !(RUN_STATUSES as readonly string[]).includes(q.status)) {
          throw new Invalid(`Unknown run status: ${q.status}`);
        }
        if (q.trigger !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(q.trigger)) {
          throw new Invalid(`Invalid trigger name: ${q.trigger}`);
        }
        return tidy(
          await state.runs.list(layout, {
            ...paging(q),
            trigger: q.trigger,
            status: q.status as (typeof RUN_STATUSES)[number] | undefined,
          }),
        );
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/managers/runs/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Get one run record",
        description: "400 for a malformed id (r-YYMMDD-HHMM-xx), 404 when absent, 422 when the file does not parse.",
        params: paramsSchema({ id: { description: "Run id, r-YYMMDD-HHMM-xx." } }),
        response: ok200("`{ run }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const { id } = req.params;
        if (!isRunId(id)) throw new Invalid(`Invalid run id: ${id}`);
        const got = await state.runs.get(layout, id);
        if (!got) return notFound(reply, `No such run: ${id}`);
        if (isParseFailure(got)) return unparseable(reply, got.parseError);
        const start = got.started ? Date.parse(got.started) : NaN;
        const end = got.finished ? Date.parse(got.finished) : NaN;
        const alerts = (await alertsFor(req.params.slug).catch(() => [] as Alert[])).filter((a) => a.runId === id);
        // M7: the briefing the run was woken with. Only ever read from the
        // workspace's own `.managers/briefings/`, whatever the record says.
        let briefingText: string | null = null;
        const bp = got.briefing?.path;
        if (bp && /^\.managers\/briefings\/r-[a-z0-9-]+\.md$/.test(bp)) {
          briefingText = await fs.readFile(path.join(layout.dir, bp), "utf8").catch(() => null);
        }
        return {
          run: got,
          durationSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 1000) : null,
          chat: got.sessionId ? { project: req.params.slug, sessionId: got.sessionId } : null,
          alerts,
          briefingText,
        };
      }),
  );

  /** A workspace's alerts: its triggers, recent runs and live herdctl schedules. */
  async function alertsFor(slug: string): Promise<Alert[]> {
    const project = await projects.get(slug);
    return loadAlerts({
      state,
      project,
      schedules: () => ctx.herdctl.listAgentSchedules(project),
      behaviours: await behavioursFor(projects, project),
    });
  }

  app.get<{ Params: { slug: string } }>(
    "/managers/alerts",
    {
      schema: {
        tags: TAGS,
        summary: "List alerts",
        description:
          "The dead-man's switch over this workspace's triggers, computed fresh: `run-failed`, `artifact-missing`, " +
          "`stale` (no `met` run inside `expect.within`), `schedule-stalled` (nextRunAt over 15 min past) and " +
          "`run-stuck` (running over 2 h). A JSON ARRAY of `{ id, kind, trigger, severity, message, runId, at }`, " +
          "errors first; `[]` when nothing is wrong.",
        params: paramsSchema(),
        response: {
          200: {
            description: "The alerts, errors first.",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    (req, reply) => withWorkspace(req, reply, async () => alertsFor(req.params.slug)),
  );

  // --- briefing (M7) ----------------------------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: Q }>(
    "/managers/briefing",
    {
      schema: {
        tags: TAGS,
        summary: "Preview the wake briefing",
        description:
          "The deterministic briefing a wake starts from (the same builder the fire path, the new-chat preload " +
          "and the `get_briefing` tool use), built fresh with no run id: `{ text, sections: [{ name, chars }], " +
          "objective }`. `?objective=` briefs on one objective in full; `?trigger=` briefs as a wake of that " +
          "trigger would (its bound objective, its runs); `?kind=chat` is the new-chat preload. 400 for a " +
          "malformed objective or kind, 404 for an unknown trigger.",
        params: paramsSchema(),
        querystring: {
          type: "object",
          properties: {
            objective: { type: "string", description: "Objective id to brief on in full." },
            trigger: { type: "string", description: "Trigger name to brief as." },
            kind: { type: "string", description: "`wake` (default) or `chat`." },
          },
        },
        response: ok200("`{ text, sections, objective }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async () => {
        const q = req.query;
        if (q.objective !== undefined && !isName(q.objective)) throw new Invalid(`Invalid objective id: ${q.objective}`);
        if (q.kind !== undefined && q.kind !== "wake" && q.kind !== "chat") {
          throw new Invalid(`kind must be wake or chat, got ${JSON.stringify(q.kind)}`);
        }
        const project = await projects.get(req.params.slug);
        const trig = q.trigger ? project.triggers?.[q.trigger] : undefined;
        if (q.trigger && !trig) return notFound(reply, `No such trigger: ${q.trigger}`);
        const objective =
          q.objective ??
          (trig && q.trigger ? await boundObjective({ state, dir: project.dir, trigger: { name: q.trigger, ...trig } }) : null);
        const b = await briefingForWorkspace(
          { state, projects, herdctl: ctx.herdctl },
          req.params.slug,
          { kind: (q.kind as "wake" | "chat" | undefined) ?? "wake", trigger: q.trigger ?? null, objective, now: new Date() },
          project,
        );
        return { text: b.text, sections: b.sections, objective: b.objective };
      }),
  );

  // --- reports ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    "/managers/reports",
    {
      schema: {
        tags: TAGS,
        summary: "List report types",
        description:
          "Every `reports/<type>/` directory: `{ reports: [{ type, current, dates }] }`, where `current` is " +
          "`current.md`'s metadata (no body) or null, and `dates` the dated reports on disk, newest first.",
        params: paramsSchema(),
        response: ok200("`{ reports }`."),
      },
    },
    (req, reply) => withWorkspace(req, reply, async ({ layout }) => state.reports.list(layout)),
  );

  app.get<{ Params: { slug: string; type: string } }>(
    "/managers/reports/:type",
    {
      schema: {
        tags: TAGS,
        summary: "Get a report type's current report",
        description:
          "`{ type, current, dates }` with `current` the full `current.md` (frontmatter, title, body, updated) or " +
          "null when only dated reports exist. 400 for a malformed type, 404 when the type has no directory.",
        params: paramsSchema({ type: { description: "Report type (kebab-case), e.g. `status`." } }),
        response: ok200("`{ type, current, dates }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const { type } = req.params;
        if (!isName(type)) throw new Invalid(`Invalid report type: ${type}`);
        if (!(await state.reports.hasType(layout, type))) return notFound(reply, `No such report type: ${type}`);
        return {
          type,
          current: await state.reports.read(layout, type, null),
          dates: await state.reports.dates(layout, type),
        };
      }),
  );

  app.get<{ Params: { slug: string; type: string; date: string } }>(
    "/managers/reports/:type/:date",
    {
      schema: {
        tags: TAGS,
        summary: "Get one dated report",
        description: "`{ report }` for `reports/<type>/<date>.md`. 400 for a malformed type or date, 404 when absent.",
        params: paramsSchema({
          type: { description: "Report type (kebab-case)." },
          date: { description: "`YYYY-MM-DD`." },
        }),
        response: ok200("`{ report }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async ({ layout }) => {
        const { type, date } = req.params;
        if (!isName(type)) throw new Invalid(`Invalid report type: ${type}`);
        if (!isDate(date)) throw new Invalid(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
        const report = await state.reports.read(layout, type, date);
        if (!report) return notFound(reply, `No ${type} report for ${date}`);
        return { report };
      }),
  );

  // --- writes (M5) -----------------------------------------------------------------------

  const bodyOf = (req: FastifyRequest): Body => {
    const b = req.body;
    if (b === undefined || b === null) return {};
    if (typeof b !== "object" || Array.isArray(b)) throw new Invalid("body must be a JSON object");
    return b as Body;
  };

  app.post<{ Params: { slug: string } }>(
    "/managers/tasks",
    {
      schema: {
        tags: TAGS,
        summary: "Create a task",
        description:
          "Creates `tasks/open/<id>.md` (or `done/<month>/` for a done/dropped status) with a fresh " +
          "`t-YYMMDD-xxxx` id, validated strictly: `title` is required, `awaiting-ed` requires `ask`, GitHub " +
          "refs must be `owner/repo#N`. Body fields: title, status, objective, ask, options[], github[], due, " +
          "shovel_ready, notes, source (ed|manager|harvested; default ed), log. Returns 201 `{ task }` (the " +
          "re-read task). Auto-committed as the requesting user.",
        params: paramsSchema(),
        body: bodySchema("The task fields."),
        response: { 201: { description: "`{ task }`.", type: "object", additionalProperties: true } },
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor, layout }) => {
        const r = await state.writer.upsertTask(ws, { ...taskInput(bodyOf(req)), id: undefined }, actor);
        return reply.code(201).send({ task: await state.tasks.get(layout, r.id) });
      }),
  );

  app.patch<{ Params: { slug: string; id: string } }>(
    "/managers/tasks/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Update a task",
        description:
          "Changes only the fields given (same fields as create), appends a line to the task's `## Log`, and " +
          "moves the file to `tasks/done/<month>/` when the status becomes done or dropped (back to `open/` when " +
          "it reopens). 400 for invalid fields, 404 for an unknown task, 409 when the file on disk does not parse.",
        params: paramsSchema({ id: { description: "Task id, t-YYMMDD-xxxx." } }),
        body: bodySchema("The fields to change."),
        response: ok200("`{ task }`."),
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor, layout }) => {
        const { id } = req.params;
        if (!isTaskId(id)) throw new Invalid(`Invalid task id: ${id}`);
        const r = await state.writer.upsertTask(ws, { ...taskInput(bodyOf(req)), id }, actor);
        return { task: await state.tasks.get(layout, r.id) };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/managers/tasks/:id/answer",
    {
      schema: {
        tags: TAGS,
        summary: "Answer an awaiting-ed task",
        description:
          "Ed's reply to a task's `ask`: `{ choice?, text?, wake? }` (at least one of choice/text; `choice` " +
          "must be one of the task's `options` when it has any). Sets `answer`, returns the task to `open`, " +
          "and records an `#answer` episode (`source ed`) in the objective's journal or the project log. With " +
          "`wake: true` it also fires the project's `wake` trigger when that trigger exists, is enabled and every " +
          "behaviour gating it is on (M8). " +
          "409 when the task is not awaiting-ed. Returns `{ task, episode, wake? }`.",
        params: paramsSchema({ id: { description: "Task id, t-YYMMDD-xxxx." } }),
        body: bodySchema("`{ choice?, text?, wake? }`."),
        response: ok200("`{ task, episode, wake? }`."),
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor, layout }) => {
        const { id } = req.params;
        if (!isTaskId(id)) throw new Invalid(`Invalid task id: ${id}`);
        const b = bodyOf(req);
        const wakeArg = b.wake;
        if (wakeArg !== undefined && typeof wakeArg !== "boolean") throw new Invalid("wake must be a boolean");
        const r = await state.writer.answerTask(
          ws,
          id,
          { choice: strField(b, "choice"), text: strField(b, "text") },
          actor,
        );
        let wake: { fired: boolean; sessionId?: string; reason?: string } | undefined;
        if (wakeArg === true) {
          const project = await projects.get(req.params.slug);
          const rec = project.triggers?.wake;
          // M8: the M5 follow-up — the wake's behaviour gate, checked up front so the
          // reason is specific (the fire path would refuse it anyway).
          const gate = rec ? triggerGate("wake", rec, await behavioursFor(projects, project)) : null;
          if (!rec) wake = { fired: false, reason: "this project has no wake trigger" };
          else if (rec.enabled !== true) wake = { fired: false, reason: "the wake trigger is disabled" };
          else if (gate && !gate.open) {
            wake = {
              fired: false,
              reason: `the wake trigger's behaviour ${gate.off.map((n) => `"${n}"`).join(", ")} is off`,
            };
          } else if (!ctx.fireTrigger) wake = { fired: false, reason: "trigger firing is unavailable" };
          else {
            try {
              const sessionId = await ctx.fireTrigger(req.params.slug, "wake");
              wake = sessionId ? { fired: true, sessionId } : { fired: false, reason: "the wake trigger did not start" };
            } catch (err) {
              wake = { fired: false, reason: (err as Error).message };
            }
          }
        }
        return {
          task: await state.tasks.get(layout, id),
          episode: r.episode,
          ...(wake ? { wake } : {}),
        };
      }),
  );

  app.post<{ Params: { slug: string } }>(
    "/managers/objectives",
    {
      schema: {
        tags: TAGS,
        summary: "Create an objective",
        description:
          "Creates `objectives/<id>/objective.md`. Body: `id` (kebab-case), `title` and `success` (required), " +
          "`status`, `whereWeAre`, `strategy`, `lessons`, `triggers[]`. Section text must not contain `## ` " +
          "headings. 409 when the objective already exists. Returns 201 `{ objective }`.",
        params: paramsSchema(),
        body: bodySchema("The objective."),
        response: { 201: { description: "`{ objective }`.", type: "object", additionalProperties: true } },
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor, layout }) => {
        const b = bodyOf(req);
        const id = strField(b, "id") ?? "";
        if (!isName(id)) throw new Invalid(`id must be a kebab-case objective id, got ${JSON.stringify(b.id)}`);
        if ((await state.objectives.get(layout, id, { months: 1 })) !== null) {
          throw new StateWriteError("conflict", `Objective ${id} already exists`);
        }
        const input = objectiveInput(id, b);
        if (!input.title?.trim() || !input.success?.trim()) throw new Invalid("title and success are required");
        await state.writer.updateObjective(ws, input, actor);
        return reply.code(201).send({ objective: await state.objectives.get(layout, id, { months: 1 }) });
      }),
  );

  app.patch<{ Params: { slug: string; id: string } }>(
    "/managers/objectives/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Update an objective",
        description:
          "Changes only the fields given (`title`, `success`, `status`, `whereWeAre`, `strategy`, `lessons`, " +
          "`triggers[]`); a section is replaced in place and Ed's other sections are kept. 404 for an unknown " +
          "objective, 409 when its file does not parse. Returns `{ objective }`.",
        params: paramsSchema({ id: { description: "Objective id (kebab-case)." } }),
        body: bodySchema("The fields to change."),
        response: ok200("`{ objective }`."),
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor, layout }) => {
        const { id } = req.params;
        if (!isName(id)) throw new Invalid(`Invalid objective id: ${id}`);
        if ((await state.objectives.get(layout, id, { months: 1 })) === null) {
          return notFound(reply, `No such objective: ${id}`);
        }
        await state.writer.updateObjective(ws, objectiveInput(id, bodyOf(req)), actor);
        return { objective: await state.objectives.get(layout, id, { months: 1 }) };
      }),
  );

  // --- behaviours (M8) -----------------------------------------------------------------

  /** A behaviour plus the triggers it gates (by its list or their `run.behaviour`). */
  function behaviourView(b: EffectiveBehaviour, project: Project) {
    const t = project.triggers ?? {};
    const names = [
      ...new Set([...b.triggers, ...Object.entries(t).filter(([, v]) => v.run.behaviour === b.name).map(([n]) => n)]),
    ].sort();
    return {
      ...b,
      boundTriggers: names.map((name) => ({
        name,
        exists: !!t[name],
        enabled: t[name]?.enabled === true,
        type: t[name]?.trigger.type ?? null,
      })),
    };
  }

  app.get<{ Params: { slug: string } }>(
    "/managers/behaviours",
    {
      schema: {
        tags: TAGS,
        summary: "List the workspace's behaviours",
        description:
          "Every behaviour that applies here — built in, defined by Home (the root) or by this project — merged " +
          "field by field, with `enabled` from this workspace's own `project.yaml` only (default OFF). Each has " +
          "`origin` (`builtin|home|project`), `inherited`, `overridden` and `boundTriggers` (`{ name, exists, " +
          "enabled, type }`). `changedOutsideUi` is true when autonomy changed other than through the PATCH route " +
          "(the `behaviours-changed-outside-ui` alert). Returns `{ behaviours, changedOutsideUi, changedSince }`.",
        params: paramsSchema(),
        response: ok200("`{ behaviours, changedOutsideUi, changedSince }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async () => {
        const project = await projects.get(req.params.slug);
        const list = await behavioursFor(projects, project);
        const drift = await behavioursChangedOutsideUi(project.dir, list, project.triggers).catch(() => ({
          changed: false,
          since: null,
        }));
        return {
          behaviours: list.map((b) => behaviourView(b, project)),
          changedOutsideUi: drift.changed,
          changedSince: drift.changed ? drift.since : null,
        };
      }),
  );

  app.patch<{ Params: { slug: string; name: string } }>(
    "/managers/behaviours/:name",
    {
      schema: {
        tags: TAGS,
        summary: "Switch a behaviour on or off",
        description:
          "Ed's autonomy switch: `{ enabled: boolean }`. Writes `behaviours.<name>.enabled` into THIS workspace's " +
          "`project.yaml` (creating a `{ enabled }` entry for an inherited behaviour), re-registers the keeper and " +
          "trigger agents (so schedules are re-armed or disarmed and tools denied or allowed), records an " +
          "`#autonomy` episode (`source ed`) in the project log, and commits `project.yaml` with the log at once. " +
          "No agent tool can do this. 400 for a malformed name or body, 404 for a behaviour not defined here. " +
          "Returns `{ behaviour, changed, episode? }` (`changed: false` and no episode when it already had that value).",
        params: paramsSchema({ name: { description: "Behaviour name (kebab-case)." } }),
        body: bodySchema("`{ enabled: boolean }`."),
        response: ok200("`{ behaviour, changed, episode? }`."),
      },
    },
    (req, reply) =>
      withWrite(req, reply, async ({ ws, actor }) => {
        const { name } = req.params;
        if (!isBehaviourName(name)) throw new Invalid(`Invalid behaviour name: ${name}`);
        const enabled = bodyOf(req).enabled;
        if (typeof enabled !== "boolean") throw new Invalid("enabled must be a boolean");
        // M9.5 (audit #4): one switch per workspace at a time, so the before/after
        // comparison below is not raced — two identical switches give ONE change
        // and ONE #autonomy episode, not two.
        return toggleLocks.run(ws.layout.dir, () => toggle(req, reply, ws, actor, name, enabled));
      }),
  );

  async function toggle(
    req: FastifyRequest<{ Params: { slug: string; name: string } }>,
    reply: FastifyReply,
    ws: WriteWorkspace,
    actor: WriteActor,
    name: string,
    enabled: boolean,
  ) {
    const project = await projects.get(req.params.slug);
    const list = await behavioursFor(projects, project);
    // M9.5 (audit #2): while a project.yaml (here or Home's) is unreadable every
    // behaviour is forced OFF; a switch could not take effect, so refuse it.
    const broken = list.find((b) => b.name === CONFIG_UNREADABLE_BEHAVIOUR);
    if (broken) {
      return reply.code(409).send({ error: broken.description, code: "config_unreadable" });
    }
    const before = list.find((b) => b.name === name);
    if (!before) return notFound(reply, `No such behaviour: ${name}`);
    if (before.enabled === enabled) return { behaviour: behaviourView(before, project), changed: false };

    // M9.5 (audit #6): project.yaml edits that are not this switch (Triggers-tab
    // saves, an agent's set_trigger, hand edits) are committed on their own
    // first, as the bot, so the switch's commit holds only the switch.
    if (ctx.autocommit) {
      await ctx.autocommit
        .commitPaths(
          project.dir,
          `managers: record ${workspaceLabel(req.params.slug)} project.yaml edits\n\n` +
            `- uncommitted before Ed switched behaviour ${name}; made outside Settings → Behaviours ` +
            `(Triggers tab, set_trigger or a hand edit), so the author is not known`,
          ["project.yaml"],
          ctx.cfg.botGitAuthor,
        )
        .catch(() => null);
    }

    const updated = await projects.setBehaviourEnabled(req.params.slug, name, enabled);
    const after = await behavioursFor(projects, updated);
    const now = after.find((b) => b.name === name)!;
    // Re-arm schedules and re-deny tools from the new state. A registration
    // failure must not undo Ed's switch: the fire path re-checks the gate.
    await ctx.herdctl.ensureProjectAgent(updated).catch((err: unknown) => {
      req.log.warn({ err, behaviour: name }, "behaviour switched but agent re-registration failed");
    });
    const scope = [
      now.triggers.length || behaviourView(now, updated).boundTriggers.length
        ? `triggers: ${behaviourView(now, updated).boundTriggers.map((t) => t.name).join(", ")}`
        : null,
      now.tools.length ? `tools: ${now.tools.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    const episode = await state.writer.recordEpisode(
      ws,
      {
        text:
          `Ed turned behaviour ${name} ${enabled ? "ON: it may now act" : "OFF: it must not happen, nor be proposed"}` +
          `${scope ? ` (${scope})` : ""}.`,
        importance: 7,
        tags: ["autonomy"],
      },
      actor,
    );
    await writeBaseline(updated.dir, after, updated.triggers, "ed").catch(() => undefined);
    // project.yaml rides in the same commit as the log, committed now rather than debounced.
    if (ctx.autocommit) {
      ctx.autocommit.schedule(
        updated.dir,
        workspaceLabel(req.params.slug),
        actor.author,
        `behaviour ${name} ${enabled ? "on" : "off"}`,
        ["project.yaml"],
      );
      await ctx.autocommit.flush(updated.dir).catch(() => null);
    }
    return { behaviour: behaviourView(now, updated), changed: true, episode };
  }

  app.post<{ Params: { slug: string } }>(
    "/managers/behaviours/acknowledge",
    {
      schema: {
        tags: TAGS,
        summary: "Accept an out-of-UI behaviour change",
        description:
          "Records the workspace's CURRENT autonomy as known-good, clearing the `behaviours-changed-outside-ui` " +
          "alert. Changes nothing else. Returns `{ ok: true }`.",
        params: paramsSchema(),
        response: ok200("`{ ok: true }`."),
      },
    },
    (req, reply) =>
      withWrite(req, reply, async () => {
        const project = await projects.get(req.params.slug);
        await writeBaseline(project.dir, await behavioursFor(projects, project), project.triggers, "acknowledged");
        return { ok: true };
      }),
  );

  // --- connections (M9) ---------------------------------------------------------

  /** A workspace's resolved connections: the live resolver when herdctl has one. */
  const connectionsOf = (project: Project): ProjectMcpResolution =>
    typeof ctx.herdctl?.projectMcpOf === "function"
      ? ctx.herdctl.projectMcpOf(project)
      : resolveProjectMcp(project, mcpResolveEnv());

  /** The secret-free view of a connection (drops the resolved server). */
  const connectionView = (c: ProjectConnection) => {
    const { server: _server, ...view } = c;
    void _server;
    return view;
  };

  app.get<{ Params: { slug: string } }>(
    "/managers/connections",
    {
      schema: {
        tags: TAGS,
        summary: "List the workspace's MCP connections",
        description:
          "The `mcp:` block of THIS workspace's `project.yaml` (never inherited from Home), resolved against the " +
          "server's environment. Each connection has `name`, `description`, `transport`, `url` (query and userinfo " +
          "stripped), `command` (basename), `headerKeys` (names only), `envRefs` (`{ name, where, set }` — variable " +
          "names and whether each is set, never values), `tools` (the narrowing, or null), `allow` (the exact " +
          "allowlist patterns the keeper gets), `attached`, `errors` and `warnings`. No value from the environment " +
          "is ever returned. Returns `{ connections }`.",
        params: paramsSchema(),
        response: ok200("`{ connections }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async () => {
        const project = await projects.get(req.params.slug);
        return { connections: connectionsOf(project).connections.map(connectionView) };
      }),
  );

  app.post<{ Params: { slug: string; name: string } }>(
    "/managers/connections/:name/probe",
    {
      schema: {
        tags: TAGS,
        summary: "Test an MCP connection",
        description:
          "Connects to the named connection the way an agent would (streamable HTTP or SSE, with its resolved " +
          "headers), runs `initialize` then `tools/list` with a 10 s timeout, and disconnects. A connection that " +
          "does not resolve (an unset env var, an inline secret, a reserved name…) is not contacted: `ok: false` " +
          "with its first resolution error. Errors are sanitised to a short category (`401 Unauthorized`, " +
          "`ECONNREFUSED`, `timed out after 10s`) with no stack, url or header text. 404 for an unknown connection. " +
          "Returns `{ name, ok, tools, error, ms }`.",
        params: paramsSchema({ name: { description: "Connection name." } }),
        response: ok200("`{ name, ok, tools, error, ms }`."),
      },
    },
    (req, reply) =>
      withWorkspace(req, reply, async () => {
        const project = await projects.get(req.params.slug);
        const conn = connectionsOf(project).connections.find((c) => c.name === req.params.name);
        if (!conn) return notFound(reply, `No such connection: ${req.params.name}`);
        if (!conn.attached || !conn.server) {
          return { name: conn.name, ok: false, tools: [], error: conn.errors[0] ?? "not attached", ms: 0 };
        }
        const r = await probeConnection(conn.server);
        return { name: conn.name, ...r };
      }),
  );
}

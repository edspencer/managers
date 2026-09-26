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
 *   GET managers/runs/:id
 *   GET managers/reports                every report type with its current report's metadata
 *   GET managers/reports/:type          current report + dated list
 *   GET managers/reports/:type/:date
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
import { isDate, isMonth, isName, isRunId, isTaskId, type WorkspaceLayout } from "../managers/layout.js";
import { RUN_STATUSES, type TaskStatus } from "../managers/schemas.js";
import { MAX_PAGE_MONTHS, type PageOpts } from "../managers/episodes-store.js";
import { isTaskStatus } from "../managers/tasks-store.js";
import { isParseFailure, type ParseError } from "../managers/store-util.js";

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

export function registerManagerWorkspaceRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { projects } = ctx;
  const state = ctx.managers ?? new ManagersState(ctx.cfg.projectsRoot);

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
        return { run: got };
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
}

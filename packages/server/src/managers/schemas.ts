/**
 * schemas — zod for the Managers domain files (plan §4).
 *
 * Two schemas per record, because the house rule is **lenient on read, strict
 * on write**:
 *
 *   • `*ReadSchema` accepts what a human (or git) plausibly left on disk: optional
 *     fields default, unknown keys pass through, timestamps are any string. A file
 *     that still fails is SKIPPED with a `parseError` entry by the store — one bad
 *     hand edit must never blank a page.
 *   • `*WriteSchema` is what the server itself writes (M5+): exact enums, ISO
 *     timestamps, bounded strings, no unknown keys. Anything written through it
 *     reads back through the read schema unchanged (pinned by the round-trip tests).
 */
import { z } from "zod";
import { NAME_RE, TASK_ID_RE, RUN_ID_RE, EPISODE_ID_RE } from "./layout.js";

// --- shared pieces ----------------------------------------------------------

/** Strict UTC timestamp: `2026-09-26T07:05:00Z` (seconds and millis optional). */
export const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
/** A plain `YYYY-MM-DD` date or a full UTC timestamp. */
const DATE_OR_TS_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;
/** A GitHub reference: `repo#12` or `owner/repo#12`. */
export const GITHUB_REF_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?#\d+$/;

const isoTs = z.string().regex(ISO_TS_RE, "must be a UTC timestamp like 2026-09-26T07:05:00Z");
const dateOrTs = z.string().regex(DATE_OR_TS_RE, "must be YYYY-MM-DD or a UTC timestamp");
const name = z.string().max(80).regex(NAME_RE, "must be kebab-case (a-z, 0-9, hyphens)");

/** Read side: a timestamp is any non-empty string, or absent/null → `null`. */
const tsRead = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === undefined || v === null || v === "" ? null : String(v)));
/** Read side: an optional string, normalised to `string | null`. */
const strOrNull = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === undefined || v === null ? null : String(v)));
/** Read side: a list of strings; a lone scalar is lifted to a one-item list. */
const strList = z
  .union([z.array(z.union([z.string(), z.number()])), z.string()])
  .nullish()
  .transform((v) =>
    v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [v],
  );

// --- objective ----------------------------------------------------------------

export const OBJECTIVE_STATUSES = ["active", "paused", "done", "retired"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const objectiveReadSchema = z.looseObject({
  title: z.string().trim().min(1),
  status: z.enum(OBJECTIVE_STATUSES).default("active"),
  success: strOrNull,
  triggers: strList,
  created: tsRead,
  updated: tsRead,
});
export type ObjectiveFrontmatter = z.output<typeof objectiveReadSchema>;

export const objectiveWriteSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  status: z.enum(OBJECTIVE_STATUSES),
  success: z.string().trim().min(1).max(2000),
  triggers: z.array(name).optional(),
  created: isoTs,
  updated: isoTs,
});
export type ObjectiveWrite = z.infer<typeof objectiveWriteSchema>;

// --- task ------------------------------------------------------------------------

export const TASK_STATUSES = ["open", "doing", "blocked", "awaiting-ed", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses whose file lives under `tasks/done/YYYY-MM/`. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "dropped"];
export const TASK_SOURCES = ["ed", "manager", "harvested"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

const answerRead = z.looseObject({
  by: strOrNull,
  at: tsRead,
  choice: strOrNull,
  text: strOrNull,
});
const dispatchedRead = z.looseObject({
  connection: strOrNull,
  project: strOrNull,
  chat: strOrNull,
  at: tsRead,
});

export const taskReadSchema = z.looseObject({
  id: z.string().regex(TASK_ID_RE, "is not a task id (t-YYMMDD-xxxx)"),
  title: z.string().trim().min(1),
  status: z.enum(TASK_STATUSES),
  objective: strOrNull,
  source: z.enum(TASK_SOURCES).default("manager"),
  ask: strOrNull,
  options: strList,
  answer: answerRead.nullish().transform((v) => v ?? null),
  github: strList,
  dispatched: z
    .array(dispatchedRead)
    .nullish()
    .transform((v) => v ?? []),
  shovel_ready: z.boolean().nullish().transform((v) => v ?? false),
  due: tsRead,
  created: tsRead,
  updated: tsRead,
});
export type TaskFrontmatter = z.output<typeof taskReadSchema>;

export const taskWriteSchema = z
  .strictObject({
    id: z.string().regex(TASK_ID_RE),
    title: z.string().trim().min(1).max(200),
    status: z.enum(TASK_STATUSES),
    objective: name.nullable(),
    source: z.enum(TASK_SOURCES),
    ask: z.string().trim().min(1).max(1000).nullable(),
    options: z.array(z.string().trim().min(1).max(80)).max(10),
    answer: z
      .strictObject({
        by: z.string().trim().min(1),
        at: isoTs,
        choice: z.string().optional(),
        text: z.string().max(4000).optional(),
      })
      .nullable(),
    github: z.array(z.string().regex(GITHUB_REF_RE, "must be repo#N or owner/repo#N")),
    dispatched: z.array(
      z.strictObject({
        connection: name,
        project: z.string().min(1),
        chat: z.string().min(1),
        at: isoTs,
      }),
    ),
    shovel_ready: z.boolean(),
    due: dateOrTs.nullable(),
    created: isoTs,
    updated: isoTs,
  })
  .superRefine((t, ctx) => {
    if (t.status === "awaiting-ed" && !t.ask) {
      ctx.addIssue({ code: "custom", path: ["ask"], message: "awaiting-ed requires an ask" });
    }
  });
export type TaskWrite = z.infer<typeof taskWriteSchema>;

// --- fact ------------------------------------------------------------------------

export const FACT_TYPES = ["user", "feedback", "project", "reference", "pattern", "playbook"] as const;
export type FactType = (typeof FACT_TYPES)[number];
export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

/**
 * `MEMORY-RESEARCH.md` §3.2 put `type` under `metadata:` (Claude Code's
 * auto-memory shape); the plan lifts it to the top level. Read both.
 */
export const factReadSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      const meta = r.metadata as Record<string, unknown> | undefined;
      if (r.type === undefined && meta && typeof meta === "object" && meta.type !== undefined) {
        return { ...r, type: meta.type };
      }
    }
    return raw;
  },
  z.looseObject({
    name: z.string().trim().min(1),
    description: strOrNull,
    type: z.enum(FACT_TYPES),
    since: tsRead,
    until: tsRead,
    confidence: z.enum(CONFIDENCE_LEVELS).nullish().transform((v) => v ?? null),
    evidence: strList,
  }),
);
export type FactFrontmatter = z.output<typeof factReadSchema>;

export const factWriteSchema = z.strictObject({
  name,
  description: z.string().trim().min(1).max(300),
  type: z.enum(FACT_TYPES),
  since: dateOrTs,
  until: dateOrTs.nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidence: z.array(z.string().regex(EPISODE_ID_RE, "must be an episode id")),
});
export type FactWrite = z.infer<typeof factWriteSchema>;

// --- run ---------------------------------------------------------------------------

export const RUN_KINDS = ["wake", "report", "consolidation", "event"] as const;
export const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export const EXPECT_KINDS = ["episode", "report", "artifact", "none"] as const;
export const EXPECT_RESULTS = ["met", "missing", "n/a"] as const;
export const EXPECT_WITHIN_RE = /^\d+[hd]$/;

const count = z.number().int().nonnegative();
const usageRead = z.looseObject({
  inputTokens: count.default(0),
  outputTokens: count.default(0),
  cacheReadTokens: count.default(0),
  cacheCreationTokens: count.default(0),
});
const expectRead = z.looseObject({
  kind: z.enum(EXPECT_KINDS),
  within: strOrNull,
  report: strOrNull,
  description: strOrNull,
});

export const runReadSchema = z.looseObject({
  id: z.string().regex(RUN_ID_RE, "is not a run id (r-YYMMDD-HHMM-xx)"),
  trigger: strOrNull,
  kind: z.enum(RUN_KINDS).default("wake"),
  objective: strOrNull,
  status: z.enum(RUN_STATUSES),
  started: tsRead,
  finished: tsRead,
  sessionId: strOrNull,
  model: strOrNull,
  usage: usageRead.nullish().transform((v) => v ?? null),
  episodes: strList,
  tasksTouched: strList,
  reports: strList,
  artifacts: z
    .array(z.looseObject({ kind: strOrNull, ref: strOrNull, note: strOrNull, at: tsRead }))
    .nullish()
    .transform((v) => v ?? []),
  mcpCalls: z
    .record(z.string(), z.record(z.string(), count))
    .nullish()
    .transform((v) => v ?? {}),
  /** M9.5: MCP calls that came back as errors (denied by permissions, or failed); not in `mcpCalls`. */
  mcpErrors: z
    .record(z.string(), z.record(z.string(), count))
    .nullish()
    .transform((v) => v ?? {}),
  /**
   * M14.5: a consolidation run's memory ops, recorded as each one is applied, so a
   * run interrupted by a restart can still get its `#reflection` episode.
   */
  memoryOps: z
    .array(z.looseObject({ op: strOrNull, name: strOrNull, type: strOrNull }))
    .nullish()
    .transform((v) => v ?? []),
  expect: expectRead.nullish().transform((v) => v ?? null),
  expectResult: z.enum(EXPECT_RESULTS).nullish().transform((v) => v ?? null),
  briefing: z
    .looseObject({ path: strOrNull, sha256: strOrNull })
    .nullish()
    .transform((v) => v ?? null),
  error: strOrNull,
});
export type RunRecord = z.output<typeof runReadSchema>;

export const runWriteSchema = z.strictObject({
  id: z.string().regex(RUN_ID_RE),
  trigger: z.string().min(1),
  kind: z.enum(RUN_KINDS),
  objective: name.nullable(),
  status: z.enum(RUN_STATUSES),
  started: isoTs,
  finished: isoTs.nullable(),
  sessionId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheCreationTokens: count,
  }),
  episodes: z.array(z.string().regex(EPISODE_ID_RE)),
  tasksTouched: z.array(z.string().regex(TASK_ID_RE)),
  reports: z.array(z.string().min(1)),
  artifacts: z.array(
    z.strictObject({
      kind: z.string().min(1),
      ref: z.string().min(1),
      note: z.string().max(500).optional(),
      at: isoTs,
    }),
  ),
  mcpCalls: z.record(z.string(), z.record(z.string(), count)),
  /** M9.5: written only when a call errored (so older records round-trip unchanged). */
  mcpErrors: z.record(z.string(), z.record(z.string(), count)).optional(),
  /** M14.5: written only by a consolidation run's memory ops (older records round-trip unchanged). */
  memoryOps: z
    .array(
      z.strictObject({
        op: z.enum(["add", "update", "supersede", "noop"]),
        name: z.string().min(1),
        type: z.string().min(1).optional(),
      }),
    )
    .optional(),
  expect: z
    .strictObject({
      kind: z.enum(EXPECT_KINDS),
      within: z.string().regex(EXPECT_WITHIN_RE).optional(),
      report: name.optional(),
      description: z.string().max(300).optional(),
    })
    .nullable(),
  expectResult: z.enum(EXPECT_RESULTS).nullable(),
  briefing: z.strictObject({ path: z.string().min(1), sha256: z.string().min(1) }).nullable(),
  error: z.string().nullable(),
});
export type RunWrite = z.infer<typeof runWriteSchema>;

// --- episode (the data inside one journal/log block) -------------------------

export const EPISODE_TAG_RE = /^[a-z0-9-]+$/;
export const EPISODE_MAX_TEXT = 1200;

export const episodeWriteSchema = z.strictObject({
  id: z.string().regex(EPISODE_ID_RE),
  /** Minute precision; the header carries `YYYY-MM-DD HH:MMZ`. */
  at: isoTs,
  importance: z.number().int().min(1).max(10),
  run: z.string().regex(RUN_ID_RE).optional(),
  chat: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  source: z.enum(["ed", "manager"]).optional(),
  tags: z.array(z.string().regex(EPISODE_TAG_RE)).max(12),
  text: z.string().trim().min(1).max(EPISODE_MAX_TEXT),
  refs: z.array(
    z.union([
      z.string().regex(GITHUB_REF_RE),
      z.string().regex(/^(?:t|ep|r)-[a-z0-9-]+$/, "must be a plain id or owner/repo#n"),
    ]),
  ),
});
export type EpisodeWrite = z.infer<typeof episodeWriteSchema>;

// --- errors ------------------------------------------------------------------------

/** One-line human summary of a zod failure, for `parseError` entries. */
export function describeZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

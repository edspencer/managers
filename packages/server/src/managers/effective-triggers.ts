/**
 * effective-triggers — a workspace's declared triggers plus the ones the server
 * DERIVES (M10, plan §5 M10).
 *
 * The derived set is one `report-<type>` per effective report type
 * (`reports.ts`), plus `consolidate` (M14), derived from the built-in
 * `consolidate-memory` behaviour in every workspace — armed only while that
 * behaviour is ON here (and, like every trigger it names, gated by it at every
 * fire). They are never written to
 * `project.yaml` — they are computed from the `reports:` config (and the
 * built-ins) wherever triggers are armed, registered or fired:
 *
 *   - `buildAgentConfig` (the keeper's `schedules`), via HerdctlService;
 *   - `HerdctlService.registerTriggerAgents` (a report runs on its own scoped
 *     `trigger-<slug>-report-<type>` agent: Read, Grep, Glob + the injected
 *     `managers` state tools, and nothing else);
 *   - the `ws-triggers.ts` schedule-handler lookup;
 *   - `fireTrigger` (Run now, `run_trigger`, the report Refresh route).
 *
 * THE NAMES ARE RESERVED: `report-*` and `consolidate`. `ProjectStore.setTrigger`
 * refuses them for every caller (the Triggers REST and `set_trigger`), and the
 * agent trigger guard refuses `remove_trigger` on them.
 *
 * Derived triggers are NOT a way round a behaviour gate:
 *
 *   - they pass through the same `triggerGate` at arming and at every fire
 *     (Refresh included — it ignores `enabled`, never a behaviour), so a
 *     behaviour listing `report-status` in its `triggers:`, or the fail-closed
 *     `config-unreadable` wildcard, gates them exactly like a declared trigger;
 *   - a hand-written trigger that collides with a derived name is REPLACED by the
 *     derived one, but its `run.behaviour` binding is carried over, so replacing
 *     it can only keep a gate, never drop one;
 *   - their capability is fixed here, not configurable: `tools: [Read, Grep,
 *     Glob]`, no `permissionMode`, no connection (a scoped trigger only gets a
 *     connection its `run.tools` names). The report config chooses only the
 *     schedule, the prompt file and the model;
 *   - the marker that makes a fire a `report` run (`derived`) is not part of the
 *     persisted trigger schema, so `sanitizeTriggers` strips it from anything
 *     read out of `project.yaml`: no hand-written trigger can pose as a derived
 *     one (which matters in M14, where the `consolidation` run kind unlocks
 *     `memory_op`).
 */
import { sanitizeTrigger, type PaddockTrigger } from "../trigger-config.js";
import {
  CONSOLIDATE_MEMORY_BEHAVIOUR,
  effectiveBehaviours,
  type BehaviourConfig,
} from "./behaviours.js";
import { consolidationBehaviour, consolidationSettings, type ConsolidationSettings } from "./consolidation.js";
import { CONSOLIDATE_TEMPLATE } from "./templates/consolidate.js";
import {
  effectiveReportTypes,
  reportTemplate,
  REPORT_TRIGGER_PREFIX,
  type EffectiveReportType,
  type ReportWorkspaceLike,
} from "./reports.js";

/** The M14 consolidation trigger's name (reserved from M10). */
export const CONSOLIDATE_TRIGGER_NAME = "consolidate";

/** Whether `name` is reserved for a derived trigger (`report-*`, `consolidate`). */
export function isReservedTriggerName(name: string): boolean {
  return name === CONSOLIDATE_TRIGGER_NAME || name.startsWith(REPORT_TRIGGER_PREFIX);
}

export const RESERVED_TRIGGER_MESSAGE =
  'names starting "report-" and the name "consolidate" are reserved for the triggers Managers derives ' +
  "(report schedules come from project.yaml `reports:`; consolidation from the consolidate-memory behaviour)";

/** What marks a derived trigger (never persisted). */
export type DerivedTriggerInfo =
  | {
      kind: "report";
      /** The report type. */
      report: string;
      /** The prompt to fall back on when the configured `promptFile` cannot be read. */
      template: string;
    }
  | {
      /** M14: the reflection run, the one run kind that unlocks `memory_op`. */
      kind: "consolidation";
      template: string;
    };

export type EffectiveTrigger = PaddockTrigger & { derived?: DerivedTriggerInfo };

/** The fixed capability of a report run. */
export const REPORT_TRIGGER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
export const REPORT_TRIGGER_MAX_TURNS = 20;

/** M14: the fixed capability of a consolidation run. */
export const CONSOLIDATE_TRIGGER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
export const CONSOLIDATE_TRIGGER_MAX_TURNS = 30;

type Workspace = ReportWorkspaceLike & {
  triggers?: Record<string, PaddockTrigger>;
  behaviours?: Record<string, BehaviourConfig>;
};

/** One report type's derived trigger, or null if it would not validate. */
export function reportTrigger(
  t: EffectiveReportType,
  collidingBehaviour?: string,
): EffectiveTrigger | null {
  const template = reportTemplate(t);
  const rec = sanitizeTrigger({
    trigger: { type: "schedule", ...t.schedule },
    run: {
      ...(t.promptFile ? { promptFile: t.promptFile } : { prompt: template }),
      session: "new",
      tools: [...REPORT_TRIGGER_TOOLS],
      maxTurns: REPORT_TRIGGER_MAX_TURNS,
      expect: { kind: "report", report: t.type },
      ...(t.model ? { model: t.model } : {}),
      ...(collidingBehaviour ? { behaviour: collidingBehaviour } : {}),
    },
    enabled: t.enabled,
  });
  return rec ? { ...rec, derived: { kind: "report", report: t.type, template } } : null;
}

/**
 * M14: the derived `consolidate` trigger. `enabled` (its schedule is armed) is
 * the workspace's OWN `consolidate-memory` flag; every fire is still gated by
 * the behaviour (built-in `triggers: [consolidate]`), which is where an
 * unreadable config here or at Home fails closed. The capability is fixed:
 * Read, Grep, Glob + the injected `managers` tools, `maxTurns` 30, no expectation.
 * The config picks only the schedule, the prompt file and the model.
 */
export function consolidateTrigger(
  settings: ConsolidationSettings,
  enabled: boolean,
  collidingBehaviour?: string,
): EffectiveTrigger | null {
  const rec = sanitizeTrigger({
    trigger: { type: "schedule", cron: settings.schedule },
    run: {
      ...(settings.promptFile ? { promptFile: settings.promptFile } : { prompt: CONSOLIDATE_TEMPLATE }),
      session: "new",
      tools: [...CONSOLIDATE_TRIGGER_TOOLS],
      maxTurns: CONSOLIDATE_TRIGGER_MAX_TURNS,
      expect: { kind: "none" },
      ...(settings.model ? { model: settings.model } : {}),
      ...(collidingBehaviour ? { behaviour: collidingBehaviour } : {}),
    },
    enabled,
  });
  return rec ? { ...rec, derived: { kind: "consolidation", template: CONSOLIDATE_TEMPLATE } } : null;
}

/**
 * `project.triggers` plus the derived triggers, keyed by name. A declared trigger
 * whose name a derived one takes is replaced (keeping its `run.behaviour`).
 */
export function effectiveTriggers(
  project: Workspace,
  root: (ReportWorkspaceLike & { behaviours?: Record<string, BehaviourConfig> }) | null,
): Record<string, EffectiveTrigger> {
  const out: Record<string, EffectiveTrigger> = { ...(project.triggers ?? {}) };
  for (const t of effectiveReportTypes(project, root)) {
    const colliding = project.triggers?.[t.trigger]?.run.behaviour;
    const rec = reportTrigger(t, colliding);
    if (rec) out[t.trigger] = rec;
  }
  // M14: `consolidate`, from the merged consolidate-memory definition. Armed only
  // on this workspace's own flag (never Home's for a project) and a readable file.
  const own = project.behaviours?.[CONSOLIDATE_MEMORY_BEHAVIOUR]?.enabled === true && !project.configError;
  const behaviour = consolidationBehaviour(
    effectiveBehaviours({ slug: project.slug, behaviours: project.behaviours }, root ? { slug: "", behaviours: root.behaviours } : null),
  );
  const consolidate = consolidateTrigger(
    consolidationSettings(behaviour),
    own,
    project.triggers?.[CONSOLIDATE_TRIGGER_NAME]?.run.behaviour,
  );
  if (consolidate) out[CONSOLIDATE_TRIGGER_NAME] = consolidate;
  return out;
}

/** Only the derived triggers. */
export function derivedTriggers(
  project: Workspace,
  root: ReportWorkspaceLike | null,
): Record<string, EffectiveTrigger> {
  const all = effectiveTriggers(project, root);
  return Object.fromEntries(Object.entries(all).filter(([, t]) => t.derived));
}

/** `project` with its trigger map replaced by the effective one (for the sync config builders). */
export function withEffectiveTriggers<P extends Workspace>(
  project: P,
  root: ReportWorkspaceLike | null,
): P & { triggers: Record<string, EffectiveTrigger> } {
  return { ...project, triggers: effectiveTriggers(project, root) };
}

/**
 * Read the root (Home's report definitions) and compute `project`'s effective
 * triggers. A root that cannot be read contributes no definitions (built-ins and
 * the project's own still apply); report definitions carry no autonomy, and the
 * behaviour gate fails closed on its own read.
 */
export async function effectiveTriggersFor(
  projects: { get(slug: string): Promise<ReportWorkspaceLike> },
  project: Workspace,
): Promise<Record<string, EffectiveTrigger>> {
  if (project.slug === "") return effectiveTriggers(project, null);
  const root = await projects.get("").catch(() => null);
  return effectiveTriggers(project, root && !root.configError ? root : null);
}

/** The effective report types of `project`, reading the root the same way. */
export async function reportTypesFor(
  projects: { get(slug: string): Promise<ReportWorkspaceLike> },
  project: ReportWorkspaceLike,
): Promise<EffectiveReportType[]> {
  if (project.slug === "") return effectiveReportTypes(project, null);
  const root = await projects.get("").catch(() => null);
  return effectiveReportTypes(project, root && !root.configError ? root : null);
}

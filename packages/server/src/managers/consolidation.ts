/**
 * consolidation — the reflection run (M14, plan §5 M14).
 *
 * The built-in `consolidate-memory` behaviour (behaviours.ts, OFF by default)
 * derives the `consolidate` trigger (effective-triggers.ts). A fire of it is a
 * `consolidation` run, and that run is the ONLY unattended writer of semantic
 * memory: `memory_op` is refused everywhere except
 *
 *   (a) a turn whose message Ed sent just now through the UI (`ws.ts` onChatSend;
 *       a live flag that is false again once that turn ends, so a later wake or
 *       background re-invocation of the same chat does not count), and
 *   (b) a consolidation run, recognised by the {@link ConsolidationTracker}: an
 *       IN-MEMORY set of run ids the one fire path registers when it fires the
 *       derived trigger. Nothing on disk can put a run in it — not a
 *       hand-written trigger in `project.yaml` (the `derived` marker is not in the
 *       trigger schema) and not an edited run record (the kind is never read
 *       back from the file).
 *
 * Agents cannot start it either: `run_trigger consolidate` is refused
 * (management-ops.ts). The schedule, the early fire below and Ed's "Run
 * consolidation now" are the only ways in.
 *
 * Early fire: after an agent records an episode in a workspace whose
 * consolidation is on, the importance summed since the last consolidation run
 * reaching `threshold`, with at least `minGapHours` since the last one started,
 * fires `consolidate` once (a per-workspace in-flight claim debounces it).
 *
 * At run end the server writes ONE `#reflection` episode to the project log
 * listing every op the run performed ({@link reflectionEpisodeText}): generated
 * from the ops, never by the model.
 */
import type { Episode } from "./episodes-store.js";
import type { RunSummary } from "./runs-store.js";
import type { ManagersState } from "./state.js";
import type { WorkspaceLayout } from "./layout.js";
import { BUILTIN_BEHAVIOURS, CONSOLIDATE_MEMORY_BEHAVIOUR, type EffectiveBehaviour } from "./behaviours.js";
import { CONSOLIDATE_TRIGGER_NAME } from "./effective-triggers.js";

export { CONSOLIDATE_TRIGGER_NAME };

/** The tag of the server-written episode that closes a consolidation run. */
export const REFLECTION_TAG = "reflection";
/** With no earlier consolidation, the run (and the threshold) looks back this far. */
export const CONSOLIDATION_FALLBACK_DAYS = 30;
/** How far back the runs list is read for the last consolidation. */
export const CONSOLIDATION_RUN_MONTHS = 12;

const BUILTIN = BUILTIN_BEHAVIOURS[CONSOLIDATE_MEMORY_BEHAVIOUR]!.config!;

/** The consolidation settings in force in one workspace (the merged `config:`). */
export interface ConsolidationSettings {
  schedule: string;
  threshold: number;
  minGapHours: number;
  model: string | null;
  promptFile: string | null;
}

export function consolidationSettings(b: Pick<EffectiveBehaviour, "config"> | undefined): ConsolidationSettings {
  const c = { ...BUILTIN, ...(b?.config ?? {}) };
  return {
    schedule: c.schedule ?? BUILTIN.schedule!,
    threshold: c.threshold ?? BUILTIN.threshold!,
    minGapHours: c.minGapHours ?? BUILTIN.minGapHours!,
    model: c.model ?? null,
    promptFile: c.promptFile ?? null,
  };
}

/** The consolidate-memory behaviour in a list (it is built in, so always present unless unreadable). */
export function consolidationBehaviour(list: EffectiveBehaviour[]): EffectiveBehaviour | undefined {
  return list.find((b) => b.name === CONSOLIDATE_MEMORY_BEHAVIOUR);
}

// --- the run marker -------------------------------------------------------------------

/** One memory op a consolidation run performed. */
export interface MemoryOpRecord {
  op: "add" | "update" | "supersede" | "noop";
  name: string;
  type?: string;
}

/**
 * The in-memory registry of consolidation runs in flight, and the per-workspace
 * early-fire claim. Process-local on purpose: a run id enters it only through the
 * fire path, so no file on disk can claim the consolidation kind.
 */
export class ConsolidationTracker {
  private readonly active = new Map<string, { slug: string; ops: MemoryOpRecord[] }>();
  private readonly claims = new Set<string>();

  /** A consolidation run has started (its run record exists). */
  begin(runId: string, slug: string): void {
    this.active.set(runId, { slug, ops: [] });
  }

  /** Whether `runId` is a live consolidation run OF `slug` (a run never unlocks another workspace). */
  isActive(runId: string | null | undefined, slug: string): boolean {
    if (!runId) return false;
    return this.active.get(runId)?.slug === slug;
  }

  /** Whether `runId` is a live consolidation run of any workspace. */
  isLive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Whether any consolidation run of `slug` is in flight. */
  hasActive(slug: string): boolean {
    for (const r of this.active.values()) if (r.slug === slug) return true;
    return false;
  }

  /** Note an op the run performed (ignored for a run that is not live). */
  note(runId: string | null | undefined, rec: MemoryOpRecord): void {
    if (!runId) return;
    this.active.get(runId)?.ops.push(rec);
  }

  /** The run ended: forget it and hand back the ops it performed. */
  end(runId: string): MemoryOpRecord[] {
    const r = this.active.get(runId);
    this.active.delete(runId);
    return r?.ops ?? [];
  }

  /** Claim the early fire for `slug`; false when one is already being decided or fired. */
  claim(slug: string): boolean {
    if (this.claims.has(slug)) return false;
    this.claims.add(slug);
    return true;
  }

  release(slug: string): void {
    this.claims.delete(slug);
  }
}

// --- the window ------------------------------------------------------------------------

export interface ConsolidationHistory {
  /** The newest consolidation run of any status (the gap is measured from it). */
  last: RunSummary | null;
  /** The newest SUCCEEDED one (the episode window starts at it). */
  lastSucceeded: RunSummary | null;
  /** A consolidation run still `running`, if any. */
  running: RunSummary | null;
}

/**
 * The workspace's consolidation runs, read from disk, with the IN-MEMORY
 * registry as the authority on what is running (M14.5, audit M9–M14 #6): a
 * record saying `running` whose id this process never started (a hand-edited or
 * agent-forged file, or one a crash left behind) is ignored entirely — it neither
 * blocks a real run nor moves the gap. So is a record claiming to have started in
 * the future (which would hold the gap shut forever).
 */
export async function consolidationHistory(
  state: ManagersState,
  layout: WorkspaceLayout,
  now: Date = new Date(),
): Promise<ConsolidationHistory> {
  const page = await state.runs
    .list(layout, { trigger: CONSOLIDATE_TRIGGER_NAME, months: CONSOLIDATION_RUN_MONTHS })
    .catch(() => null);
  const horizon = now.getTime() + 60_000;
  const runs = (page?.runs ?? []).filter((r) => {
    if (r.kind !== "consolidation") return false;
    if (r.status === "running" && !state.consolidations.isLive(r.id)) return false;
    const t = r.started ? Date.parse(r.started) : NaN;
    return !(Number.isFinite(t) && t > horizon);
  });
  return {
    last: runs[0] ?? null,
    lastSucceeded: runs.find((r) => r.status === "succeeded") ?? null,
    running: runs.find((r) => r.status === "running") ?? null,
  };
}

/** Where "since the last consolidation" starts: the last succeeded run's start, else N days back. */
export function consolidationWindow(
  history: Pick<ConsolidationHistory, "lastSucceeded">,
  now: Date,
): { sinceIso: string; label: string } {
  const started = history.lastSucceeded?.started;
  if (started && Number.isFinite(Date.parse(started))) {
    // Episodes carry minute precision (`HH:MMZ`), a run's start seconds: floor to
    // the minute so an episode written in the run's own first minute is not lost
    // (at worst one is seen twice, and the consolidator notes it as a noop).
    const minute = new Date(Math.floor(Date.parse(started) / 60_000) * 60_000).toISOString();
    return { sinceIso: minute, label: `the start of ${history.lastSucceeded!.id}, the last consolidation` };
  }
  return {
    sinceIso: new Date(now.getTime() - CONSOLIDATION_FALLBACK_DAYS * 86_400_000).toISOString(),
    label: `no earlier consolidation, so the last ${CONSOLIDATION_FALLBACK_DAYS} days`,
  };
}

/** Whether an episode is a consolidation's own record (never counted, never consolidated). */
export function isReflection(e: Pick<Episode, "tags">): boolean {
  return e.tags.includes(REFLECTION_TAG);
}

export function importanceSum(episodes: Pick<Episode, "importance" | "tags">[]): number {
  return episodes.filter((e) => !isReflection(e)).reduce((n, e) => n + e.importance, 0);
}

export interface EarlyFireInput {
  settings: Pick<ConsolidationSettings, "threshold" | "minGapHours">;
  /** Whether consolidation is on here (the behaviour gate). */
  enabled: boolean;
  /** Episodes since the window start. */
  episodes: Pick<Episode, "importance" | "tags">[];
  history: ConsolidationHistory;
  /** A consolidation run of this workspace is in flight in this process. */
  inFlight: boolean;
  now: Date;
}

export interface EarlyFireDecision {
  fire: boolean;
  sum: number;
  reason: string;
}

/** The early-fire rule, pure. */
export function earlyFireDecision(p: EarlyFireInput): EarlyFireDecision {
  const sum = importanceSum(p.episodes);
  if (!p.enabled) return { fire: false, sum, reason: "consolidation is off" };
  if (p.inFlight || p.history.running) return { fire: false, sum, reason: "a consolidation run is in flight" };
  if (sum < p.settings.threshold) {
    return { fire: false, sum, reason: `importance ${sum} is below the threshold ${p.settings.threshold}` };
  }
  const lastStart = p.history.last?.started ? Date.parse(p.history.last.started) : NaN;
  if (Number.isFinite(lastStart)) {
    const gapH = (p.now.getTime() - lastStart) / 3_600_000;
    if (gapH < p.settings.minGapHours) {
      return {
        fire: false,
        sum,
        reason: `the last consolidation started ${gapH.toFixed(1)}h ago (minimum gap ${p.settings.minGapHours}h)`,
      };
    }
  }
  return { fire: true, sum, reason: `importance ${sum} since the last consolidation reached the threshold ${p.settings.threshold}` };
}

// --- the reflection episode --------------------------------------------------------------

const REFLECTION_MAX = 1_100;

function opLine(r: MemoryOpRecord): string {
  return `${r.op} ${r.name}${r.type && r.op === "add" ? ` (${r.type})` : ""}`;
}

/** The run's `#reflection` episode text: every op it performed, in order. Deterministic. */
export function reflectionEpisodeText(
  runId: string,
  ops: MemoryOpRecord[],
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted",
): string {
  const ended =
    outcome === "succeeded"
      ? ""
      : outcome === "interrupted"
        ? " (the run was interrupted by a restart)"
        : ` (the run ${outcome})`;
  if (ops.length === 0) return `Consolidation run ${runId} performed no memory ops${ended}.`;
  const head = `Consolidation run ${runId} performed ${ops.length} memory op${ops.length === 1 ? "" : "s"}${ended}: `;
  const parts: string[] = [];
  let len = head.length;
  for (let i = 0; i < ops.length; i++) {
    const line = opLine(ops[i]!);
    const more = ops.length - i - 1;
    const tail = more > 0 ? `; +${more} more` : "";
    if (len + line.length + 2 + tail.length > REFLECTION_MAX) {
      parts.push(`+${ops.length - i} more`);
      break;
    }
    parts.push(line);
    len += line.length + 2;
  }
  return `${head}${parts.join("; ")}.`;
}

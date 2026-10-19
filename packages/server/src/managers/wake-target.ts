/**
 * wake-target — which trigger the answer form's "Answer & wake" fires.
 *
 * The trigger whose run ASKED (it set the task to awaiting-ed, recorded as the
 * task's `raisedBy`; older tasks only have the run id in their `## Log`), and
 * otherwise the workspace's `wake`. A candidate must be declared, enabled and
 * have every behaviour gating it on (M8) — an off behaviour is never woken, it
 * falls through to `wake`. Derived triggers (`report-*`, `consolidate`) are
 * never a target: they write a report or curate memory, not act on an answer.
 *
 * Pure: `GET …/managers/wake` and `POST …/tasks/:id/answer` both call
 * `resolveWakeTarget`, so the offered action and the fire always agree.
 */
import type { EffectiveBehaviour } from "./behaviours.js";
import { triggerGate } from "./behaviours.js";
import { DEFAULT_WAKE_TRIGGER_NAME } from "./templates/wake.js";
import type { PaddockTrigger } from "../trigger-config.js";

export interface WakeTarget {
  available: boolean;
  /** Why not, phrased for a tooltip; null when available. */
  reason: string | null;
  /** The trigger an answer would fire; null when none can. */
  trigger: string | null;
}

/** `report-<type>` and `consolidate` are derived and reserved (M10, M14). */
export function isDerivedTriggerName(name: string): boolean {
  return name.startsWith("report-") || name === "consolidate";
}

/**
 * The run that raised an awaiting-ed task, from its `## Log` (tasks written
 * before `raisedBy` existed): the newest line a run wrote that put the task into
 * awaiting-ed, e.g. `2026-10-01T09:00Z manager (run r-261001-0900-ab12): open → awaiting-ed`.
 * A later line that moved it to awaiting-ed WITHOUT a run (a chat, Ed) means no
 * run asked last, so null.
 */
export function raisedRunFromLog(log: string[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const line = log[i]!;
    if (!/(?:→ awaiting-ed|created, awaiting-ed)/.test(line)) continue;
    const m = /^\S+ [^:(]*\(run (r-[a-z0-9-]+)\):/.exec(line);
    return m ? m[1]! : null;
  }
  return null;
}

function blocker(
  name: string,
  triggers: Record<string, PaddockTrigger> | undefined,
  behaviours: EffectiveBehaviour[],
): string | null {
  if (isDerivedTriggerName(name)) return `the ${name} trigger is not one an answer can wake`;
  const rec = triggers?.[name];
  if (!rec) return `this project has no ${name} trigger`;
  if (rec.enabled !== true) return `the ${name} trigger is disabled`;
  const gate = triggerGate(name, rec, behaviours);
  if (!gate.open) return `the ${name} trigger's behaviour ${gate.off.map((n) => `"${n}"`).join(", ")} is off`;
  return null;
}

/**
 * The trigger an answer wakes: `asker` (the trigger whose run raised the task)
 * when it can fire, else `wake`, else none — with the reason(s) why not.
 */
export function resolveWakeTarget(
  triggers: Record<string, PaddockTrigger> | undefined,
  behaviours: EffectiveBehaviour[],
  asker: string | null = null,
): WakeTarget {
  const reasons: string[] = [];
  const candidates = asker && asker !== DEFAULT_WAKE_TRIGGER_NAME ? [asker, DEFAULT_WAKE_TRIGGER_NAME] : [DEFAULT_WAKE_TRIGGER_NAME];
  for (const name of candidates) {
    const why = blocker(name, triggers, behaviours);
    if (!why) return { available: true, reason: null, trigger: name };
    reasons.push(why);
  }
  return { available: false, reason: reasons.join(", and "), trigger: null };
}

/**
 * behaviour-state — noticing autonomy changes made outside the Behaviours route (M8).
 *
 * The Behaviours PATCH route is the one sanctioned way to switch a behaviour. It
 * records a fingerprint of the workspace's effective autonomy
 * ({@link behaviourFingerprint}) in `.managers/state/behaviours.json` (gitignored
 * by the data-repo skeleton). Whenever alerts are computed, the live fingerprint
 * is compared with it; a difference raises the info alert
 * `behaviours-changed-outside-ui` — a hand edit, a keeper's `sed`, a root
 * definition changed in git. Ed clears it by switching a behaviour in Settings or
 * with "Acknowledge" there (both re-record the fingerprint).
 *
 * The first observation of a workspace (no file yet: a new project, or an
 * existing data repo meeting M8) adopts the current state silently. Boot does
 * that for every workspace, so a change made while the server was down is
 * caught on the next read rather than adopted.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PaddockTrigger } from "../trigger-config.js";
import type { Alert } from "./alerts.js";
import { behaviourFingerprint, type EffectiveBehaviour } from "./behaviours.js";

export const BEHAVIOUR_STATE_FILE = path.join(".managers", "state", "behaviours.json");
export const BEHAVIOURS_CHANGED_ALERT_ID = "behaviours-changed-outside-ui";

export interface BehaviourBaseline {
  sha256: string;
  at: string;
  /** Who recorded it: `ed` (the route), `adopted` (first observation), `acknowledged`. */
  by: string;
}

type Triggers = Record<string, Pick<PaddockTrigger, "run">> | undefined;

export async function readBaseline(dir: string): Promise<BehaviourBaseline | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, BEHAVIOUR_STATE_FILE), "utf8")) as Partial<BehaviourBaseline>;
    return typeof raw.sha256 === "string" ? { sha256: raw.sha256, at: String(raw.at ?? ""), by: String(raw.by ?? "") } : null;
  } catch {
    return null;
  }
}

export async function writeBaseline(
  dir: string,
  behaviours: EffectiveBehaviour[],
  triggers: Triggers,
  by: string,
  now = new Date(),
): Promise<BehaviourBaseline> {
  const rec: BehaviourBaseline = { sha256: behaviourFingerprint(behaviours, triggers), at: now.toISOString(), by };
  const file = path.join(dir, BEHAVIOUR_STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return rec;
}

/** Record the current state only when nothing is recorded yet (boot, first read). */
export async function adoptBaselineIfAbsent(
  dir: string,
  behaviours: EffectiveBehaviour[],
  triggers: Triggers,
): Promise<void> {
  if (await readBaseline(dir)) return;
  await writeBaseline(dir, behaviours, triggers, "adopted");
}

/** Whether the live autonomy differs from the recorded one (false when nothing is recorded yet). */
export async function behavioursChangedOutsideUi(
  dir: string,
  behaviours: EffectiveBehaviour[],
  triggers: Triggers,
): Promise<{ changed: boolean; since: string | null }> {
  const base = await readBaseline(dir);
  if (!base) {
    await writeBaseline(dir, behaviours, triggers, "adopted").catch(() => undefined);
    return { changed: false, since: null };
  }
  return { changed: base.sha256 !== behaviourFingerprint(behaviours, triggers), since: base.at || null };
}

/** The alert, or null. */
export async function behaviourDriftAlert(
  dir: string,
  behaviours: EffectiveBehaviour[],
  triggers: Triggers,
): Promise<Alert | null> {
  const { changed, since } = await behavioursChangedOutsideUi(dir, behaviours, triggers);
  if (!changed) return null;
  return {
    id: BEHAVIOURS_CHANGED_ALERT_ID,
    kind: "behaviours-changed-outside-ui",
    trigger: "",
    severity: "info",
    message:
      "This workspace's behaviours (a flag, a definition or a trigger's binding) changed outside Settings → Behaviours" +
      (since ? ` since ${since}` : "") +
      ". Check project.yaml's history, then switch or acknowledge it in Settings.",
    runId: null,
    at: since,
  };
}

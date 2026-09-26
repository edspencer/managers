/**
 * behaviours — binary, opt-in autonomy (M8, plan §2.4).
 *
 * A BEHAVIOUR is a named thing a manager may do on its own: triage PRs, post a
 * comment, consolidate memory. It is declared in `project.yaml` `behaviours:` as
 *
 *   behaviours:
 *     triage-external-prs:
 *       enabled: false
 *       description: Triage PRs from outside contributors …
 *       triggers: [triage-prs]              # triggers it gates
 *       tools: [mcp__paddock__create_chat]  # tools it gates
 *       instructions: Name the PR by number only …
 *
 * The policy is Ed's and it is binary:
 *
 *   - OFF means the behaviour does not happen AT ALL — no proposals either. Its
 *     triggers are not armed, refuse to fire (cron, event and "Run now"), its tools
 *     are denied, and the briefing lists it as not permitted.
 *   - ON means it acts.
 *   - EVERYTHING DEFAULTS TO OFF. `enabled` counts only when it is literally `true`,
 *     and only at the level that owns it: a project's flag for a project, the
 *     root's flag for Home. The root supplies DEFINITIONS to every project, never
 *     a project's `enabled` (§2.2's cascade rule).
 *
 * Definitions merge field by field: built-in < root (Home) < project. So a project
 * can adjust an inherited definition (narrow its tools, add instructions) as well
 * as switch it on.
 *
 * This module is PURE: it reads records, never files. `behavioursFor` is the one
 * I/O helper, resolving the root through the caller's ProjectStore.
 */
import { createHash } from "node:crypto";
import type { PaddockTrigger } from "../trigger-config.js";
import { NAME_RE } from "./layout.js";

/** One `project.yaml` `behaviours:` entry, as stored. Every field is optional. */
export interface BehaviourConfig {
  enabled?: boolean;
  description?: string;
  triggers?: string[];
  tools?: string[];
  instructions?: string;
}

/** Where an effective behaviour's definition comes from. */
export type BehaviourOrigin = "builtin" | "home" | "project";

/** A behaviour as it applies to one workspace. */
export interface EffectiveBehaviour {
  name: string;
  /** Whether it may act, here. Only ever true when this workspace's own flag is `true`. */
  enabled: boolean;
  description: string;
  /** The triggers it gates (by name; they need not exist). */
  triggers: string[];
  /** The tools it gates (Claude Code tool names / permission patterns). */
  tools: string[];
  instructions: string;
  /** The lowest level that defines it: built-in, Home (the root), or this project. */
  origin: BehaviourOrigin;
  /** Defined above this workspace (built in, or by Home for a project). */
  inherited: boolean;
  /** An inherited definition this workspace changes more than `enabled` of. */
  overridden: boolean;
}

export const BEHAVIOUR_NAME_MAX = 64;

export function isBehaviourName(name: unknown): name is string {
  return typeof name === "string" && name.length <= BEHAVIOUR_NAME_MAX && NAME_RE.test(name);
}

/**
 * Built-in definitions, available in every workspace (off until enabled there).
 * `consolidate-memory` is only a definition until M14 wires its trigger.
 * Deliberately NO tools: `memory_op` is also Ed's in human turns, so denying it
 * whenever consolidation is off would take it from him too.
 */
export const BUILTIN_BEHAVIOURS: Readonly<Record<string, Readonly<BehaviourConfig>>> = {
  "consolidate-memory": {
    description:
      "Periodically consolidate recent episodes into semantic memory facts (the reflection run; lands in M14).",
    triggers: ["consolidate"],
    tools: [],
    instructions:
      "Only add, update or retire facts that recent episodes support; cite the episode ids as evidence.",
  },
};

/**
 * Tools every keeper and trigger is denied so it cannot flip its own autonomy
 * by editing config. Claude Code permission-rule syntax: a bare path is relative
 * to the agent's cwd, gitignore-style; the `**` forms also cover the root keeper,
 * whose cwd is the projects root, reaching into project subdirectories.
 *
 * Best effort: a keeper with Bash can still `sed` the file. The backstops are the
 * out-of-UI alert ({@link behaviourFingerprint}) and git history (plan §5 M8 risk).
 */
export const BEHAVIOUR_TAMPER_DENIED_TOOLS: readonly string[] = [
  "Edit(project.yaml)",
  "Write(project.yaml)",
  "Edit(**/project.yaml)",
  "Write(**/project.yaml)",
  "Edit(.managers/**)",
  "Write(.managers/**)",
  "Edit(**/.managers/**)",
  "Write(**/.managers/**)",
];

// --- sanitising ----------------------------------------------------------------

const strList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  return [...new Set(out)];
};
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/**
 * One entry, leniently: an unusable FIELD is dropped, never the whole entry.
 * That is the fail-closed direction — dropping an off behaviour with a typo in
 * one field would also drop its tool denials; dropping a non-boolean `enabled`
 * just leaves it off.
 */
export function sanitizeBehaviour(raw: unknown): BehaviourConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw === null ? {} : null;
  const r = raw as Record<string, unknown>;
  const out: BehaviourConfig = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  const description = str(r.description, 500);
  if (description !== undefined) out.description = description;
  const triggers = strList(r.triggers);
  if (triggers !== undefined) out.triggers = triggers;
  const tools = strList(r.tools);
  if (tools !== undefined) out.tools = tools;
  const instructions = str(r.instructions, 2_000);
  if (instructions !== undefined) out.instructions = instructions;
  return out;
}

/**
 * A whole `behaviours:` map. Entries with an invalid name are dropped (they could
 * never be addressed). `undefined` when nothing survives, so a behaviour-less
 * file stays byte-identical on the next write.
 */
export function sanitizeBehaviours(raw: unknown): Record<string, BehaviourConfig> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, BehaviourConfig> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBehaviourName(name)) continue;
    const b = sanitizeBehaviour(val);
    if (b) out[name] = b;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- the merge -------------------------------------------------------------------

interface WorkspaceLike {
  slug: string;
  behaviours?: Record<string, BehaviourConfig>;
}

const DEFINITION_KEYS = ["description", "triggers", "tools", "instructions"] as const;

/**
 * The behaviours that apply to `project`: built-ins, then Home's definitions,
 * then the project's own, merged field by field; `enabled` from the project's
 * own entry only (Home's own `enabled` applies to Home alone). Sorted by name.
 * `root` may be null (unreadable), which just means no Home definitions.
 */
export function effectiveBehaviours(project: WorkspaceLike, root: WorkspaceLike | null): EffectiveBehaviour[] {
  const isHome = project.slug === "";
  const own = project.behaviours ?? {};
  const home = isHome ? {} : (root?.behaviours ?? {});
  const names = [...new Set([...Object.keys(BUILTIN_BEHAVIOURS), ...Object.keys(home), ...Object.keys(own)])].sort();
  return names.map((name) => {
    const b = BUILTIN_BEHAVIOURS[name];
    const h = home[name];
    const o = own[name];
    // At Home, Home's own definitions are "home" and not inherited.
    const origin: BehaviourOrigin = b ? "builtin" : h || isHome ? "home" : "project";
    const pick = <K extends (typeof DEFINITION_KEYS)[number]>(k: K): BehaviourConfig[K] =>
      o?.[k] !== undefined ? o[k] : h?.[k] !== undefined ? h[k] : b?.[k];
    const inherited = origin === "builtin" || (origin === "home" && !isHome);
    const overridden = inherited && !!o && DEFINITION_KEYS.some((k) => o[k] !== undefined);
    return {
      name,
      enabled: o?.enabled === true,
      description: pick("description") ?? "",
      triggers: [...(pick("triggers") ?? [])],
      tools: [...(pick("tools") ?? [])],
      instructions: pick("instructions") ?? "",
      origin,
      inherited,
      overridden,
    };
  });
}

/** Load the root, then merge. The root read failing means "no Home definitions". */
export async function behavioursFor(
  projects: { get(slug: string): Promise<WorkspaceLike> },
  project: WorkspaceLike,
): Promise<EffectiveBehaviour[]> {
  const root = project.slug === "" ? project : await projects.get("").catch(() => null);
  return effectiveBehaviours(project, root);
}

// --- gates -------------------------------------------------------------------------

export interface TriggerGate {
  /** Whether the trigger may fire / be armed as far as behaviours go. */
  open: boolean;
  /** Every behaviour gating it (from the behaviour's `triggers:` or the trigger's `run.behaviour`). */
  behaviours: string[];
  /** The gating behaviours that are off. */
  off: string[];
  /** A `run.behaviour` naming no defined behaviour (it fails closed: off). */
  unknown: string[];
}

/**
 * Which behaviours gate `triggerName`, and whether all of them are on. A trigger
 * gated by nothing is open. A trigger gated by several needs every one on.
 */
export function triggerGate(
  triggerName: string,
  trigger: Pick<PaddockTrigger, "run"> | { run: { behaviour?: string } } | undefined,
  behaviours: EffectiveBehaviour[],
): TriggerGate {
  const byName = new Map(behaviours.map((b) => [b.name, b]));
  const names = new Set(behaviours.filter((b) => b.triggers.includes(triggerName)).map((b) => b.name));
  const declared = (trigger?.run as { behaviour?: string } | undefined)?.behaviour;
  if (typeof declared === "string" && declared) names.add(declared);
  const list = [...names].sort();
  const unknown = list.filter((n) => !byName.has(n));
  const off = list.filter((n) => byName.get(n)?.enabled !== true);
  return { open: off.length === 0, behaviours: list, off, unknown };
}

/** A predicate over a whole trigger map, for arming and alerts. */
export function triggerGatePredicate(
  behaviours: EffectiveBehaviour[],
): (name: string, trigger: Pick<PaddockTrigger, "run">) => boolean {
  return (name, trigger) => triggerGate(name, trigger, behaviours).open;
}

/** Tools of every OFF behaviour, de-duplicated and sorted. Deny wins over a shared tool. */
export function disabledBehaviourTools(behaviours: EffectiveBehaviour[]): string[] {
  return [...new Set(behaviours.filter((b) => !b.enabled).flatMap((b) => b.tools))].sort();
}

/** The fire path's refusal, surfaced as a 409 by Run-now and as a tool error by `run_trigger`. */
export class BehaviourOffError extends Error {
  readonly code = "behaviour_off";
  constructor(
    readonly trigger: string,
    readonly gate: TriggerGate,
    workspace: string,
  ) {
    const where = workspace === "" ? "Home" : workspace;
    const which = gate.off.map((n) => `"${n}"`).join(", ");
    const noun = gate.off.length === 1 ? "behaviour" : "behaviours";
    const unknownNote = gate.unknown.length
      ? ` (${gate.unknown.map((n) => `"${n}"`).join(", ")} ${gate.unknown.length === 1 ? "is" : "are"} not defined)`
      : "";
    super(
      `Trigger "${trigger}" is gated by the ${noun} ${which}, which ${gate.off.length === 1 ? "is" : "are"} off in ${where}${unknownNote}. ` +
        `Turn it on in Settings → Behaviours to run it.`,
    );
    this.name = "BehaviourOffError";
  }
}

// --- the out-of-UI fingerprint -------------------------------------------------------

/**
 * A stable hash of what governs autonomy in one workspace: every effective
 * behaviour's name, flag, triggers and tools, plus each trigger's `run.behaviour`
 * binding. The Behaviours PATCH route records it; any other change to it — a
 * hand edit, a `sed` from a keeper's Bash, a root definition edited in git —
 * raises the `behaviours-changed-outside-ui` alert.
 */
export function behaviourFingerprint(
  behaviours: EffectiveBehaviour[],
  triggers: Record<string, Pick<PaddockTrigger, "run">> | undefined,
): string {
  const canon = {
    behaviours: behaviours.map((b) => ({
      name: b.name,
      enabled: b.enabled,
      triggers: [...b.triggers].sort(),
      tools: [...b.tools].sort(),
    })),
    bindings: Object.entries(triggers ?? {})
      .map(([name, t]) => [name, (t.run as { behaviour?: string }).behaviour ?? null] as const)
      .filter(([, b]) => b !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

// --- the briefing section ----------------------------------------------------------

/** Section 3 of the briefing: ON behaviours with their instructions, then "Not permitted". */
export function behavioursBriefingBody(behaviours: EffectiveBehaviour[]): string {
  const on = behaviours.filter((b) => b.enabled);
  const off = behaviours.filter((b) => !b.enabled);
  const lines: string[] = [];
  if (on.length === 0) {
    lines.push("ON: none. No autonomous behaviour is permitted here.");
  } else {
    lines.push("ON (you may act on these without asking):");
    for (const b of on) {
      lines.push(`- **${b.name}**${b.description ? ` — ${oneLine(b.description)}` : ""}`);
      if (b.triggers.length) lines.push(`  - triggers: ${b.triggers.join(", ")}`);
      if (b.tools.length) lines.push(`  - tools: ${b.tools.join(", ")}`);
      if (b.instructions) lines.push(`  - instructions: ${oneLine(b.instructions)}`);
    }
  }
  lines.push("");
  if (off.length === 0) {
    lines.push("Not permitted: (none defined)");
  } else {
    lines.push(
      "Not permitted (OFF — do not do these, and do not propose them either; their tools are denied and their triggers do not run):",
    );
    for (const b of off) lines.push(`- ${b.name}${b.description ? ` — ${oneLine(b.description)}` : ""}`);
  }
  lines.push("");
  lines.push("Anything not listed as ON is forbidden. Only Ed switches behaviours, in Settings.");
  return lines.join("\n");
}

function oneLine(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

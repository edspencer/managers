/**
 * trigger-guard — agents cannot edit their way around a behaviour gate (M9.5, audit #3).
 *
 * The audit's bypass: a trigger gated by `run.behaviour: X` (X off) was removed
 * with `remove_trigger`, recreated under the same name without the binding with
 * `set_trigger`, and run with `run_trigger`. M8's guard only compared the binding
 * before and after an edit of an EXISTING record, so remove + recreate walked
 * past it.
 *
 * The invariant, enforced in the ops layer (`management-ops.ts`) for EVERY MCP
 * principal — the in-process keeper and trigger agents, any project, and external
 * `/mcp` clients alike:
 *
 *   An agent may not create, change or remove a trigger that is GATED — named in
 *   any effective behaviour's `triggers:`, or carrying `run.behaviour` — nor
 *   create, change or remove one whose name has EVER been seen gated in that
 *   workspace. Gated triggers are Ed's: the Triggers tab and the REST routes
 *   (human requests) are the only way to edit or delete them.
 *
 * "Ever seen gated" is a small tombstone list per workspace, in
 * `.managers/state/gated-triggers.json` (gitignored). Names are added whenever a
 * guard runs (agent or human write) and at boot; they are never removed by the
 * server. So a human deleting a gated trigger does not open its name to an agent
 * afterwards. While a `project.yaml` is unreadable and its bindings unknown,
 * every trigger is gated (the synthetic `config-unreadable` behaviour), so agents
 * cannot write any trigger there.
 *
 * Not covered, and documented: a keeper with Bash can still edit `project.yaml`
 * directly or call the unauthenticated REST API on a loopback server. Those are
 * the same hole M8 documents; the out-of-UI alert and git history are the
 * backstops.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PaddockTrigger } from "../trigger-config.js";
import { ALL_TRIGGERS, behavioursFor, triggerGate, type EffectiveBehaviour, type GateResolver, type WorkspaceLike } from "./behaviours.js";
import { writeFileAtomic } from "./write-queue.js";
import { isReservedTriggerName, RESERVED_TRIGGER_MESSAGE } from "./effective-triggers.js";

export const GATED_TRIGGERS_FILE = path.join(".managers", "state", "gated-triggers.json");

type Triggers = Record<string, Pick<PaddockTrigger, "run">> | undefined;

/** Every trigger name gated in a workspace right now (behaviour lists + bindings; never the wildcard). */
export function gatedTriggerNames(behaviours: EffectiveBehaviour[], triggers: Triggers): string[] {
  const out = new Set<string>();
  for (const b of behaviours) for (const t of b.triggers) if (t !== ALL_TRIGGERS) out.add(t);
  for (const [name, t] of Object.entries(triggers ?? {})) {
    if (typeof (t.run as { behaviour?: unknown }).behaviour === "string") out.add(name);
  }
  return [...out].sort();
}

/**
 * M14.5 (audit M9–M14 #14): the names this process has seen gated, per workspace
 * directory. The file is `.managers/state/`, which a keeper's Bash can write, so
 * the in-memory copy is united with it on every read: deleting or truncating the
 * file cannot reopen a name while the server is up.
 */
const seenGated = new Map<string, Set<string>>();

/** Thrown when the tombstone file exists but cannot be read as a list (fail closed). */
export class TombstonesUnreadableError extends Error {
  constructor(why: string) {
    super(`${GATED_TRIGGERS_FILE} cannot be read (${why})`);
    this.name = "TombstonesUnreadableError";
  }
}

/** The file's names; an absent file is an empty list, anything unreadable throws. */
async function readTombstoneFile(dir: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, GATED_TRIGGERS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new TombstonesUnreadableError((err as NodeJS.ErrnoException).code ?? "read error");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TombstonesUnreadableError("not valid JSON");
  }
  const names = (raw as { names?: unknown } | null)?.names;
  if (!raw || typeof raw !== "object" || !Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new TombstonesUnreadableError("not a { names: [...] } list");
  }
  return new Set(names as string[]);
}

/**
 * Every name ever seen gated in `dir`: the file united with this process's
 * memory. Throws {@link TombstonesUnreadableError} when the file exists but is
 * damaged (the agent guard then refuses every trigger write there).
 */
export async function readGatedTombstones(dir: string): Promise<Set<string>> {
  const key = path.resolve(dir);
  const out = await readTombstoneFile(dir);
  for (const n of seenGated.get(key) ?? []) out.add(n);
  return out;
}

/**
 * Add `names` to the workspace's tombstones (a write only when something is
 * new). A damaged file is never overwritten, since that would drop the names it
 * holds; the names are kept in memory and the error is rethrown.
 */
export async function recordGatedTombstones(dir: string, names: string[]): Promise<Set<string>> {
  const key = path.resolve(dir);
  const mem = seenGated.get(key) ?? new Set<string>();
  for (const n of names) mem.add(n);
  seenGated.set(key, mem);
  const onDisk = await readTombstoneFile(dir);
  const have = new Set([...onDisk, ...mem]);
  if (have.size === onDisk.size) return have;
  await writeFileAtomic(
    path.join(dir, GATED_TRIGGERS_FILE),
    `${JSON.stringify({ names: [...have].sort() }, null, 2)}\n`,
  );
  return have;
}

/** The ops layer's refusal (a tool error for the agent). */
export class GatedTriggerError extends Error {
  readonly code = "trigger_gated";
  constructor(op: "set_trigger" | "remove_trigger", name: string, why: string, tail?: string) {
    super(
      `${op} refused: trigger "${name}" ${why}. ` +
        (tail ??
          `Agents cannot create, change or remove a behaviour-gated trigger ` +
            `(or one that has been gated before); Ed edits it in the Triggers tab.`),
    );
    this.name = "GatedTriggerError";
  }
}

interface Store {
  get(slug: string): Promise<WorkspaceLike & { dir?: string }>;
  resolveForGate?: GateResolver;
}

type Workspace = WorkspaceLike & { dir: string; triggers?: Record<string, PaddockTrigger> };

/**
 * The guard an AGENT's trigger write runs under the `project.yaml` lock (passed to
 * `TriggerService.set/remove`). Throws {@link GatedTriggerError}.
 */
export function agentTriggerGuard(projects: Store, op: "set_trigger" | "remove_trigger", name: string) {
  return async (current: Workspace): Promise<void> => {
    // M10: derived trigger names (`report-*`, `consolidate`) are the server's; no
    // agent creates, changes or removes one (a human's set is refused by the store).
    if (isReservedTriggerName(name)) {
      throw new GatedTriggerError(op, name, "is reserved", `${RESERVED_TRIGGER_MESSAGE[0]!.toUpperCase()}${RESERVED_TRIGGER_MESSAGE.slice(1)}.`);
    }
    const list = await behavioursFor(projects, current);
    let tombs: Set<string>;
    try {
      tombs = await recordGatedTombstones(current.dir, gatedTriggerNames(list, current.triggers));
    } catch (err) {
      if (err instanceof TombstonesUnreadableError) {
        // M14.5: fail closed — which names were ever gated here is unknown.
        throw new GatedTriggerError(
          op,
          name,
          "cannot be checked",
          `${err.message}, so which triggers were ever behaviour-gated here is unknown and agents cannot write ` +
            "any trigger in this workspace until Ed fixes or deletes the file.",
        );
      }
      // A write failure (disk full, …): the memory still holds every name.
      tombs = await readGatedTombstones(current.dir).catch(() => new Set<string>(seenGated.get(path.resolve(current.dir)) ?? []));
    }
    const gate = triggerGate(name, current.triggers?.[name], list);
    if (gate.behaviours.length > 0) {
      const which = gate.behaviours.map((b) => `"${b}"`).join(", ");
      throw new GatedTriggerError(op, name, `is gated by ${which}`);
    }
    if (tombs.has(name)) throw new GatedTriggerError(op, name, "was gated by a behaviour before");
  };
}

/** The guard a HUMAN's trigger write runs: it only records tombstones, never refuses. */
export function humanTriggerGuard(projects: Store) {
  return async (current: Workspace): Promise<void> => {
    const list = await behavioursFor(projects, current).catch(() => null);
    if (list) await recordGatedTombstones(current.dir, gatedTriggerNames(list, current.triggers)).catch(() => undefined);
  };
}

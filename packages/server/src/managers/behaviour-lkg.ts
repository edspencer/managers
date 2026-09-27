/**
 * behaviour-lkg — the last-known-good behaviour DEFINITIONS per workspace (M9.5).
 *
 * The gate has to fail closed when a `project.yaml` cannot be read (audit #2):
 * every behaviour off, every bound trigger refused, every gated tool denied. But
 * "bound" and "gated" are facts IN the unreadable file. So every time a
 * workspace's file IS read cleanly its `behaviours:` block is remembered — in
 * memory, and in `.managers/state/behaviour-defs.json` (gitignored with the rest
 * of `.managers/state/`) so a file that broke while the server was down is
 * still covered at boot. When the file is unreadable, the remembered
 * definitions stand in, united with whatever the lenient reader still salvaged;
 * `effectiveBehaviours` then forces them all off.
 *
 * With nothing remembered at all the workspace is marked `behavioursUnknown`,
 * and the synthetic `config-unreadable` behaviour gates EVERY trigger.
 *
 * The memory is keyed by the workspace's resolved directory. Writes happen only
 * when the definitions change, never on a plain read of unchanged state.
 */
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sanitizeBehaviours, type BehaviourConfig, type WorkspaceLike } from "./behaviours.js";
import { writeFileAtomic } from "./write-queue.js";

export const BEHAVIOUR_LKG_FILE = path.join(".managers", "state", "behaviour-defs.json");

type Defs = Record<string, BehaviourConfig>;

interface Entry {
  sha: string;
  defs: Defs;
}

const hashOf = (defs: Defs): string => createHash("sha256").update(JSON.stringify(defs)).digest("hex");

/** Only the definition fields matter for the gate; `enabled` is dropped (it is forced off anyway). */
function definitionsOnly(behaviours: Defs | undefined): Defs {
  const out: Defs = {};
  for (const [name, b] of Object.entries(behaviours ?? {}).sort(([a], [z]) => a.localeCompare(z))) {
    const { enabled: _enabled, ...rest } = b;
    void _enabled;
    out[name] = rest;
  }
  return out;
}

/** Field-wise union: triggers and tools are united (more gating), other fields prefer `a`. */
function unite(a: Defs, b: Defs): Defs {
  const out: Defs = { ...b };
  for (const [name, x] of Object.entries(a)) {
    const y = b[name];
    if (!y) {
      out[name] = x;
      continue;
    }
    out[name] = {
      ...y,
      ...x,
      triggers: [...new Set([...(y.triggers ?? []), ...(x.triggers ?? [])])],
      tools: [...new Set([...(y.tools ?? []), ...(x.tools ?? [])])],
    };
  }
  return out;
}

export class BehaviourLkg {
  private readonly mem = new Map<string, Entry>();

  /**
   * The record the gate should use for `ws` (whose directory is `dir`). A clean
   * record is remembered (best-effort) and returned as-is; an unreadable one gets
   * the remembered definitions, or `behavioursUnknown` when there are none.
   */
  async resolve<T extends WorkspaceLike>(ws: T, dir: string): Promise<T> {
    const key = path.resolve(dir);
    if (!ws.configError) {
      await this.remember(key, ws.behaviours).catch(() => undefined);
      return ws;
    }
    const known = this.mem.get(key) ?? (await this.load(key));
    return this.substitute(ws, known);
  }

  /** The synchronous twin for the agent-config builders: memory, then the file. */
  resolveSync<T extends WorkspaceLike>(ws: T, dir: string): T {
    const key = path.resolve(dir);
    if (!ws.configError) {
      void this.remember(key, ws.behaviours).catch(() => undefined);
      return ws;
    }
    return this.substitute(ws, this.mem.get(key) ?? this.loadSync(key));
  }

  private substitute<T extends WorkspaceLike>(ws: T, known: Entry | null): T {
    const salvaged = definitionsOnly(ws.behaviours);
    if (!known) return { ...ws, behaviours: salvaged, behavioursUnknown: true };
    return { ...ws, behaviours: unite(salvaged, known.defs) };
  }

  private async remember(key: string, behaviours: Defs | undefined): Promise<void> {
    const defs = definitionsOnly(behaviours);
    const sha = hashOf(defs);
    const cur = this.mem.get(key);
    if (cur?.sha === sha) return;
    this.mem.set(key, { sha, defs });
    const file = path.join(key, BEHAVIOUR_LKG_FILE);
    // Skip the write when the file already says the same (first read after boot).
    const onDisk = await this.load(key, false);
    if (onDisk?.sha === sha) return;
    await writeFileAtomic(file, `${JSON.stringify({ sha256: sha, behaviours: defs }, null, 2)}\n`);
  }

  private parse(text: string): Entry | null {
    const raw = JSON.parse(text) as { behaviours?: unknown };
    const defs = definitionsOnly(sanitizeBehaviours(raw.behaviours));
    return { sha: hashOf(defs), defs };
  }

  private async load(key: string, cache = true): Promise<Entry | null> {
    try {
      const e = this.parse(await fs.readFile(path.join(key, BEHAVIOUR_LKG_FILE), "utf8"));
      if (e && cache && !this.mem.has(key)) this.mem.set(key, e);
      return e;
    } catch {
      return null;
    }
  }

  private loadSync(key: string): Entry | null {
    try {
      const e = this.parse(readFileSync(path.join(key, BEHAVIOUR_LKG_FILE), "utf8"));
      if (e && !this.mem.has(key)) this.mem.set(key, e);
      return e;
    } catch {
      return null;
    }
  }
}

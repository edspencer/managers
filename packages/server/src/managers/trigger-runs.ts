/**
 * trigger-runs — one Managers run record per trigger fire (M6).
 *
 * {@link beginTriggerRun} is called by the ONE trigger fire path
 * (`ws-triggers.ts` `fireTriggerForProject`) before the turn starts. It writes
 * the `status: running` record and hands back the run id (threaded into the
 * turn, where the state tools see it as `currentRunId`) and the turn's
 * `onComplete` hook, which finishes the record, evaluates `expect`, and commits
 * the workspace's state at once.
 *
 * Only trigger fires create runs (plan M6). A human chat's episodes carry
 * `chat: <sessionId>` instead.
 */
import type { TriggerDto } from "../trigger-config.js";
import type { TurnCompletion } from "../ws-context.js";
import type { GitAuthor } from "./autocommit.js";
import type { ManagersState } from "./state.js";
import type { WriteActor, WriteWorkspace } from "./state-writes.js";
import type { RunWrite } from "./schemas.js";

export interface TriggerRunHandle {
  runId: string;
  onComplete: (r: TurnCompletion) => Promise<void>;
}

export interface BeginTriggerRunParams {
  state: ManagersState;
  /** Workspace key (`""` is Home). */
  slug: string;
  dir: string;
  trigger: TriggerDto;
  author: GitAuthor;
  /** Commit the workspace's pending state now (autocommit flush). */
  flush?: (dir: string) => Promise<unknown>;
  /** Told when a run record could not be written; the fire goes ahead regardless. */
  onError?: (what: string, err: unknown) => void;
}

/** A schedule fire is a wake; an event (or webhook) fire is an event run. */
export function runKindOf(trigger: TriggerDto): RunWrite["kind"] {
  return trigger.trigger.type === "schedule" ? "wake" : "event";
}

/**
 * The objective a trigger is bound to: the first active objective (by id) whose
 * `triggers:` lists it. M7's `run.briefing.objective` will take precedence.
 */
async function boundObjective(p: BeginTriggerRunParams): Promise<string | null> {
  const { objectives } = await p.state.objectives.list(p.state.layout(p.dir)).catch(() => ({ objectives: [] }));
  const hit = objectives
    .filter((o) => o.status === "active" && (o.triggers ?? []).includes(p.trigger.name))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return hit?.id ?? null;
}

/**
 * Start the run record for one fire. Returns null (and reports through
 * `onError`) when the record can't be written: a broken run store must never
 * stop a trigger from firing.
 */
export async function beginTriggerRun(p: BeginTriggerRunParams): Promise<TriggerRunHandle | null> {
  const ws: WriteWorkspace = { key: p.slug, layout: p.state.layout(p.dir) };
  const actor = (runId: string | null): WriteActor => ({ kind: "agent", name: "manager", author: p.author, runId });
  let runId: string;
  try {
    const started = await p.state.writer.startRun(
      ws,
      {
        trigger: p.trigger.name,
        kind: runKindOf(p.trigger),
        objective: await boundObjective(p),
        model: p.trigger.run.model ?? null,
        expect: p.trigger.run.expect ?? null,
      },
      actor(null),
    );
    runId = started.id;
  } catch (err) {
    p.onError?.("starting the run record", err);
    return null;
  }

  return {
    runId,
    onComplete: async (r) => {
      try {
        await p.state.writer.finishRun(
          ws,
          runId,
          {
            status: r.success ? "succeeded" : "failed",
            sessionId: r.sessionId,
            model: r.model ?? null,
            usage: r.usage ?? null,
            mcpCalls: r.mcpCalls,
            error: r.success ? null : (r.error ?? "the turn did not succeed"),
          },
          actor(runId),
        );
      } catch (err) {
        p.onError?.("finishing the run record", err);
      }
      // Commit at run end (plan §2.6), rather than waiting out the debounce.
      await p.flush?.(p.dir).catch((err: unknown) => p.onError?.("committing the run", err));
    },
  };
}

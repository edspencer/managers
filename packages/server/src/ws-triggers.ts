/**
 * Trigger / schedule / event firing cluster, extracted from ws.ts (#403).
 *
 * `makeTriggerCluster(deps, startAgentTurn)` returns the shared firing surface and
 * wires the herdctl schedule handler + the onArchive / afterTurn event listeners.
 * Every trigger type funnels through ONE `startAgentTurn` call (the shared engine,
 * passed in) so a cron / event / manual "Run now" fire is indistinguishable.
 *
 * Also holds two helpers historically co-located with the firing code: the
 * post-turn `emitAfterTurn` curation signal (T5 sweeper) and `composePreloadedPrompt`
 * (the OVERVIEW+CHANGELOG new-chat preload, shared by the human path + self-MCP).
 */
import { promises as fs } from "node:fs";
import type { TriggerInfo } from "@herdctl/core";
import type { DriveMode } from "./models.js";
import { isKnownDriveMode } from "./models.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  triggerAgentName,
} from "./herdctl.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { wrapPreload, composePreloadContext } from "./preload.js";
import {
  triggerPromptFileAbsPath,
  triggerRunsOnOwnAgent,
  isCuratorTrigger,
  type TriggerDto,
  type TriggerEvent,
} from "./trigger-config.js";
import type { ChatHandlerDeps, StartAgentTurn } from "./ws-context.js";
import { beginTriggerRun, boundObjective } from "./managers/trigger-runs.js";
import { briefingForWorkspace, triggerWantsBriefing } from "./managers/briefing.js";
import { BehaviourOffError, behavioursFor, triggerGate } from "./managers/behaviours.js";
import { effectiveTriggersFor } from "./managers/effective-triggers.js";

/** How a fire came about, for the briefing's "why woken" line. */
export interface TriggerFireOpts {
  /** Replaces the derived reason (e.g. "Run now (manual)"). */
  why?: string;
  /** Told the Managers run id as soon as the run record exists (M10: the report Refresh route). */
  onRun?: (runId: string) => void;
}

/**
 * The context a fired lifecycle event carries into an EVENT trigger's prompt (Epic T /
 * T1). v1 (`onArchive`) supplies the archived chat's session id so the trigger knows
 * what to act on.
 */
export interface TriggerEventContext {
  /** The session id of the chat whose lifecycle event fired the trigger. */
  sessionId: string;
}

/** The shared trigger-firing surface `makeChatHandler` consumes + returns. */
export interface TriggerCluster {
  /** Post-turn curation signal (T5): emit `afterTurn` so the sweeper runs once. */
  emitAfterTurn(slug: string, sessionId: string | null): void;
  /** Prepend the OVERVIEW+CHANGELOG preload block for a new chat (issues #1/#188). */
  composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string>;
  /**
   * Fire a named trigger on demand (Run-now / run_trigger / report Refresh);
   * resolves its chat id or null. Resolves DERIVED triggers too (M10).
   */
  fireTrigger(slug: string, triggerName: string, opts?: TriggerFireOpts): Promise<string | null>;
  /** Run one fire of a resolved trigger record as a first-class chat on the hub. */
  fireTriggerForProject(
    project: Awaited<ReturnType<ChatHandlerDeps["projects"]["get"]>>,
    trigger: TriggerDto,
    ctx?: TriggerEventContext,
    opts?: TriggerFireOpts,
  ): Promise<string | null>;
  /** Fire every enabled EVENT trigger matching `event` for a project (after-commit). */
  dispatchEventTriggers(slug: string, event: TriggerEvent, ctx: TriggerEventContext): Promise<void>;
}

/**
 * Build the trigger-firing cluster bound to the handler's deps + the shared
 * `startAgentTurn` engine, and wire its schedule/event listeners.
 */
export function makeTriggerCluster(
  deps: ChatHandlerDeps,
  startAgentTurn: StartAgentTurn,
): TriggerCluster {
/** Resolve a project's effective keeper drive mode (override else instance default). */
function resolveDriveMode(project: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode {
  return project.driveMode && isKnownDriveMode(project.driveMode)
    ? project.driveMode
    : deps.cfg.driveMode;
}

// Drive scheduler-fired chats onto the hub (issue #265 / DD-1, DD-2). herdctl's
// cron engine fires a project keeper's declared schedule and routes it HERE
// (setScheduleTriggerHandler) instead of running it headless.
deps.herdctl.onScheduleTrigger(async (info: TriggerInfo) => {
  const slug = keeperSlugFromAgent(info.agent.name);
  // Only keeper agents carry Paddock schedules; a non-keeper trigger (there are
  // none today) has nowhere sensible to route, so ignore it rather than guess.
  // `null` means "not a keeper"; `""` is the ROOT workspace's own key, so this
  // must not be a falsy check.
  if (slug === null) return;
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return;
  // Every armed keeper schedule belongs to a SCHEDULE-type trigger (forwarded into
  // the keeper `schedules` block under its trigger name). Resolve + fire it via the
  // single trigger fire path.
  // Managers M10: a derived `report-<type>` schedule resolves here too.
  const effective = await effectiveTriggersFor(deps.projects, project).catch(() => project.triggers ?? {});
  const trig = effective[info.scheduleName];
  if (trig && trig.trigger.type === "schedule" && trig.enabled === true) {
    // Managers M8: a schedule whose behaviour is off is not armed, but a stale
    // arming (a root definition edited since registration) is refused here too.
    await fireTriggerForProject(project, {
      name: info.scheduleName,
      agentName: triggerAgentName(slug, info.scheduleName),
      ...trig,
    }).catch((err) => {
      if (!(err instanceof BehaviourOffError)) throw err;
    });
  }
  // A fired keeper schedule with no matching enabled SCHEDULE trigger is ignored:
  // triggers are the only thing forwarded into the keeper's `schedules` block.
});

// --- unified triggers (Epic T / T1) ------------------------------------

/**
 * Resolve the prompt a fired trigger should run. A trigger's `promptFile`
 * (Paddock-only, `.managers/triggers/*.md`, git-tracked + keeper-editable) is read
 * FRESH here at fire time — so an edit takes effect on the very next fire with no
 * agent re-register — and falls back to the inline `run.prompt` when there's no file
 * or it can't be read. For an EVENT trigger, a short machine preamble naming the
 * event + archived chat is prepended (so the trigger knows WHAT to act on); a
 * schedule trigger gets no preamble. Mirrors {@link resolveSchedulePrompt} /
 * {@link resolveHookPrompt}.
 */
async function resolveTriggerPrompt(
  project: Awaited<ReturnType<typeof deps.projects.get>>,
  trigger: TriggerDto,
  ctx?: TriggerEventContext,
): Promise<string> {
  let body = typeof trigger.run.prompt === "string" ? trigger.run.prompt : "";
  if (trigger.run.promptFile) {
    const abs = triggerPromptFileAbsPath(project.workingDir, trigger.run.promptFile);
    if (abs) {
      const content = await fs.readFile(abs, "utf8").catch(() => null);
      if (content !== null) body = content;
    }
  }
  // Managers M10: a derived report trigger whose promptFile cannot be read runs its template.
  if (!body.trim() && trigger.derived) body = trigger.derived.template;
  if (trigger.trigger.type === "event" && ctx) {
    const preamble =
      `A \`${trigger.trigger.on}\` event trigger fired for project \`${project.slug}\`: ` +
      `chat \`${ctx.sessionId}\` was just archived.\n\n`;
    return preamble + body;
  }
  return body;
}

/**
 * Run one fire of a trigger as a first-class chat on the hub — the ONE fire path for
 * every trigger type (Epic T), replacing the separate schedule + hook fire paths with
 * a single `startAgentTurn` call. Whether the fired turn runs on the trigger's OWN
 * scoped `trigger-<slug>-<name>` agent (tool config = `run.tools`) or on the keeper is
 * decided by {@link triggerRunsOnOwnAgent}: an EVENT trigger always runs scoped; a
 * SCHEDULE trigger runs scoped ONLY when it declares a non-empty `run.tools` allow-list
 * (T2 — #307), otherwise it runs as the keeper with the project-agent default toolset
 * (pre-T2 behaviour, unchanged). `run.maxSpawnDepth` gates this fire's self-MCP spawn
 * capability regardless of which agent runs it.
 *
 * `run.session` drives new-vs-accrete: `"new"` → a FRESH chat every fire
 * (`resume: null`); `"resume"` → resume the trigger's ONE owned session (recorded on
 * first fire in the {@link TriggerSessionStore}, rebound after a restart) so a
 * "manager" accretes a single transcript. A stale owned id (its transcript deleted)
 * is forgotten so the next fire re-creates one. FIRE-AND-FORGET: a rejection (the
 * turn never produced a session id — its own failure frame already emitted) is
 * swallowed so a transient failure never wedges the trigger. Resolves the
 * created/resumed session id, or `null`. The one exception (Managers M8): a trigger
 * gated by an OFF behaviour REJECTS with a {@link BehaviourOffError} before any run
 * record, briefing or turn exists.
 */
async function fireTriggerForProject(
  project: Awaited<ReturnType<typeof deps.projects.get>>,
  trigger: TriggerDto,
  ctx?: TriggerEventContext,
  opts: TriggerFireOpts = {},
): Promise<string | null> {
  const slug = project.slug;
  const isSchedule = trigger.trigger.type === "schedule";

  // Managers M8: an OFF behaviour means the trigger does not happen at all — no
  // run record, no briefing, no turn. Checked here, on the one fire path, so cron,
  // event and "Run now" fires all refuse the same way; the caller decides whether
  // that is an error (Run now, run_trigger) or silence (cron, events).
  const gate = triggerGate(trigger.name, trigger, await behavioursFor(deps.projects, project));
  if (!gate.open) throw new BehaviourOffError(trigger.name, gate, slug);
  // T2: a scoped trigger (every event; a schedule with a `run.tools` allow-list) runs
  // on its OWN `trigger-<slug>-<name>` agent so herdctl enforces its capability; an
  // unscoped schedule runs as the keeper (project-agent default toolset, unchanged).
  const onOwnAgent = triggerRunsOnOwnAgent(trigger);
  const agentName = onOwnAgent ? triggerAgentName(slug, trigger.name) : keeperAgentName(slug);
  const body = await resolveTriggerPrompt(project, trigger, ctx);

  // run.session: "resume" accretes into an owned session; "new" starts fresh.
  let resume: string | null = null;
  if (trigger.run.session === "resume" && deps.triggerSessions) {
    const owned = await deps.triggerSessions.get(slug, trigger.name).catch(() => undefined);
    if (owned && (await deps.herdctl.sessionExists(project, owned).catch(() => false))) {
      resume = owned;
    } else if (owned) {
      await deps.triggerSessions.clear(slug, trigger.name).catch(() => undefined);
    }
  }

  // Managers M6: every fire writes a run record (status running) first; the
  // turn's completion hook finishes it, evaluates `expect` and commits at once.
  const run = deps.managers
    ? await beginTriggerRun({
        state: deps.managers,
        slug,
        dir: project.dir,
        trigger,
        author: deps.cfg.botGitAuthor,
        flush: deps.flushManagersCommit,
      })
    : null;
  if (run && opts.onRun) {
    try {
      opts.onRun(run.runId);
    } catch {
      /* a listener never stops the fire */
    }
  }

  // Managers M7: brief the wake. The briefing rides in the SAME preload wrapper a
  // new chat uses, so the sidebar name stays the trigger body (stripPreloadWrapper),
  // and is kept on disk as "what the manager saw". A briefing that fails to build
  // never stops the fire: the trigger runs on its bare prompt.
  let prompt = body;
  if (deps.managers && triggerWantsBriefing(trigger)) {
    try {
      const briefing = await briefingForWorkspace(
        { state: deps.managers, projects: deps.projects, herdctl: deps.herdctl },
        slug,
        {
          // M10: a derived report trigger gets the report briefing.
          kind: trigger.derived?.kind === "report" ? "report" : "wake",
          report: trigger.derived?.kind === "report" ? trigger.derived.report : null,
          trigger: trigger.name,
          runId: run?.runId ?? null,
          objective: run ? run.objective : await boundObjective({ state: deps.managers, dir: project.dir, trigger }),
          why: opts.why ?? null,
          now: new Date(),
        },
        project,
      );
      prompt = wrapPreload(briefing.text, body);
      if (run) {
        await deps.managers.writer
          .recordBriefing(
            { key: slug, layout: deps.managers.layout(project.dir) },
            run.runId,
            briefing.text,
            { kind: "agent", name: "manager", author: deps.cfg.botGitAuthor, runId: run.runId },
          )
          .catch(() => undefined);
      }
    } catch {
      prompt = body;
    }
  }

  try {
    const sessionId = await startAgentTurn({
      ...(run ? { runId: run.runId, onComplete: run.onComplete } : {}),
      projectSlug: slug,
      agentName,
      workingDir: project.workingDir,
      resume,
      prompt,
      driveMode: resolveDriveMode(project),
      fallbackModel: trigger.run.model ?? project.model,
      // Provenance (A1/#261): a schedule fire is a root `scheduled` trigger; an event
      // trigger reuses the `hook` origin (its E1 badge surface) — both depth 0.
      origin: isSchedule ? "scheduled" : "hook",
      depth: 0,
      // A per-trigger `run.maxSpawnDepth` (design §2.3, T2) gates this fire's self-MCP
      // spawn capability; it wins over the project override, which wins over the
      // instance default (reuses B1's resolver).
      maxSpawnDepth: resolveMaxSpawnDepth(
        trigger.run.maxSpawnDepth ?? project.maxSpawnDepth,
        deps.cfg.maxSpawnDepth,
      ),
      // Attribute the injected kickoff turn to the trigger that fired it (#290).
      sender: {
        kind: isSchedule ? "schedule" : "hook",
        name: trigger.name,
        project: slug,
      },
    });
    // First fire of an accreting trigger: remember the chat it created so the next
    // fire resumes THIS transcript (a resume already had an id).
    if (trigger.run.session === "resume" && !resume && deps.triggerSessions) {
      await deps.triggerSessions.set(slug, trigger.name, sessionId).catch(() => undefined);
    }
    return sessionId;
  } catch {
    return null;
  }
}

/**
 * Resolve a project's ENABLED event triggers for `event` and fire each (after-commit,
 * non-blocking — after-commit, non-blocking). Concurrent +
 * independent; one trigger's failure never affects another. No-op when the trigger
 * system isn't wired ({@link makeChatHandler} dep `triggers` absent) or the project
 * has no matching enabled event trigger.
 */
async function dispatchEventTriggers(
  slug: string,
  event: TriggerEvent,
  ctx: TriggerEventContext,
): Promise<void> {
  if (!deps.triggers) return;
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return;
  const matching = await deps.triggers.enabledForEvent(slug, event).catch(() => []);
  await Promise.all(
    matching.map((trigger) =>
      // M8: an event trigger whose behaviour is off simply does not fire.
      fireTriggerForProject(project, trigger, ctx).catch((err) => {
        if (!(err instanceof BehaviourOffError)) throw err;
        return null;
      }),
    ),
  );
}

// Dispatch enabled EVENT triggers on the SAME lifecycle events hooks fire on — the
// event-bus supports multiple listeners, so this rides alongside the hook dispatcher
// (they read disjoint config blocks). onArchive is the wired event; afterTurn is
// reserved for the sweeper fold-in (T5) and not emitted yet.
deps.events?.on("onArchive", (payload) => {
  void dispatchEventTriggers(payload.slug, "onArchive", { sessionId: payload.sessionId });
});

/**
 * Signal a completed turn's post-turn CURATION (Epic T / T5) — the sweeper, folded in
 * as the default `curate-overview` (event/afterTurn) trigger. Emits the `afterTurn`
 * lifecycle event so the curator dispatches EXACTLY ONCE per turn (its enabled gate +
 * per-project prompt extension resolved inside SweepService). Fires for every
 * workspace, the root included.
 * Falls back to a direct `sweep.enqueue` when the event bus isn't wired (older
 * callers / tests), so behaviour is identical with or without the bus. Called from
 * every post-turn commit site (a human chat turn, a session-mode wake, and every
 * server-initiated `startAgentTurn`) — the ONE place the sweeper is now triggered.
 */
function emitAfterTurn(slug: string, sessionId: string | null): void {
  if (deps.events) deps.events.emit("afterTurn", { slug, sessionId });
  else deps.sweep?.enqueue(slug);
}

// The folded-in sweeper (T5): `afterTurn` drives the default post-turn curator. Unlike
// `onArchive`, afterTurn is NOT fanned out to generic `trigger-<slug>-<name>` agents —
// the curator is tool-less and executed by SweepService (returns marked text, Paddock
// writes OVERVIEW.md/CHANGELOG.md). So this is the SOLE afterTurn consumer, which is
// what guarantees the sweeper runs exactly once per turn (no double-curation).
deps.events?.on("afterTurn", (payload) => {
  deps.sweep?.enqueue(payload.slug);
});

/**
 * Fire a TRIGGER now (Epic T / T1), reused by the "Run now" REST route + `run_trigger`
 * self-MCP verb (#327) and shared with the cron path below. Resolves the live project +
 * its trigger record and fires via {@link fireTriggerForProject} — through the SAME hub
 * path a cron/event fire uses, so a manual run is indistinguishable from an automatic
 * one. Fires ANY trigger type on demand (a schedule, an event trigger, or a reserved
 * webhook trigger you want to smoke-test before its ingress lands) regardless of its
 * `enabled` flag — a manual run is a deliberate act (mirrors the schedule DD-1 rule).
 * Returns the started chat's session id, or `null` if the project/trigger is gone or
 * the turn never produced a session. Managers M8: REJECTS with a
 * {@link BehaviourOffError} when a behaviour gating the trigger is off — a manual
 * run is deliberate, but it does not override Ed's autonomy switch.
 */
async function fireTrigger(slug: string, triggerName: string, opts: TriggerFireOpts = {}): Promise<string | null> {
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return null;
  // Managers M10: the effective map, so a derived `report-<type>` fires here too.
  const effective = await effectiveTriggersFor(deps.projects, project).catch(() => project.triggers ?? {});
  const rec = effective[triggerName];
  if (!rec) return null;
  // The post-turn CURATOR (any `event`/`afterTurn` trigger — the folded-in sweeper, T5)
  // is NOT fireable on the generic path: it registers no scoped `trigger-<slug>-<name>`
  // agent and runs via SweepService on `afterTurn`. Refuse rather than firing a turn on
  // a non-existent agent (defence-in-depth — the REST route + run_trigger MCP reject it
  // up front with a clear message; this guards any other caller).
  if (isCuratorTrigger(rec)) return null;
  return fireTriggerForProject(
    project,
    { name: triggerName, agentName: triggerAgentName(slug, triggerName), ...rec },
    undefined,
    { why: opts.why ?? "Run now (a manual fire)", ...(opts.onRun ? { onRun: opts.onRun } : {}) },
  );
}

/**
 * Compose the preload block onto `baseMessage` for a NEW chat (issues #1/#188),
 * shared (C2 / #264) by the human New-Chat path and the self-MCP `create_chat`
 * spawn path so both inject the SAME context.
 *
 * Managers M7: the context is the deterministic CHAT briefing
 * (`managers/briefing.ts`, kind `chat`) — the same document a wake gets, with no
 * run or trigger — instead of OVERVIEW.md + CHANGELOG.md. It always has content,
 * so it always wraps. Without the Managers state bundle (a bare test harness) the
 * old OVERVIEW + CHANGELOG behaviour stands, including "no overview → unchanged".
 */
async function composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string> {
  if (deps.managers) {
    try {
      const briefing = await briefingForWorkspace(
        { state: deps.managers, projects: deps.projects, herdctl: deps.herdctl },
        projectSlug,
        { kind: "chat", now: new Date() },
      );
      return wrapPreload(briefing.text, baseMessage);
    } catch {
      // Fall through to the curated-docs preload rather than losing the context.
    }
  }
  const overview = await deps.projects.readOverview(projectSlug).catch(() => "");
  if (overview.trim().length === 0) return baseMessage;
  const changelog = await deps.projects.readChangelog(projectSlug).catch(() => "");
  // Single-sourced wrapper (see preload.ts) so the chat-list can strip it back
  // off for display (issue #62).
  return wrapPreload(composePreloadContext(overview, changelog), baseMessage);
}
  return {
    emitAfterTurn,
    composePreloadedPrompt,
    fireTrigger,
    fireTriggerForProject,
    dispatchEventTriggers,
  };
}

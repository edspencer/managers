/**
 * chat-delta — "Changed since your last turn" for a chat that is already open.
 *
 * The first turn of a chat is briefed (`briefing.ts`); later turns used to get
 * nothing, so a chat open across Ed answering a task on Home went on believing
 * the task was still waiting and wrote that into an objective. On each later
 * human turn `ws.ts` prepends this block, built from the store since the chat's
 * previous turn (`chat-turns.ts`):
 *
 * - answers Ed recorded since that turn STARTED (he may have answered while it ran);
 * - tasks and objectives whose `updated` moved since it ENDED (so the chat's own
 *   edits during that turn are not echoed back to it);
 * - episodes since it started, minus the ones this chat wrote itself.
 *
 * Each window opens at the boundary's second (episodes: minute), because that is
 * all the precision on disk, and what was already there at the boundary
 * (`ChatTurn.seen`) is left out so nothing is repeated.
 *
 * Bounded: {@link DELTA_SECTION_CAP} entries per section with a "+N more" line,
 * and {@link DELTA_BUDGET} characters overall. Records are named by id with
 * their status; free text is limited to Ed's own answer (clipped), never an
 * episode's body, which may quote an issue or a PR. Nothing changed → null, and
 * the message goes out unwrapped.
 */
import type { ManagersState } from "./state.js";
import type { TaskSummary } from "./tasks-store.js";
import type { ObjectiveSummary } from "./objectives-store.js";
import type { Episode } from "./episodes-store.js";
import type { ChatTurn } from "./chat-turns.js";
import { clip, escapePreloadTags, oneLine } from "./briefing.js";

export const DELTA_OPEN = "<managers-delta>";
export const DELTA_CLOSE = "</managers-delta>";
/** The literal boundary between the delta block and the user's message. */
export const DELTA_REQUEST_MARKER = `${DELTA_CLOSE}\n\n`;
export const DELTA_SECTION_CAP = 10;
export const DELTA_BUDGET = 4_000;

/** Prepend a delta block to a message. */
export function wrapDelta(delta: string, message: string): string {
  return `${DELTA_OPEN}\n${delta.trim()}\n${DELTA_REQUEST_MARKER}${message}`;
}

/** Recover the message from a (possibly) delta-wrapped one; anything else is returned unchanged. */
export function stripDeltaWrapper(text: string): string {
  if (!text.startsWith(DELTA_OPEN)) return text;
  const i = text.indexOf(DELTA_REQUEST_MARKER);
  return i === -1 ? text : text.slice(i + DELTA_REQUEST_MARKER.length);
}

/** Keep a value from closing either wrapper early. */
function escapeTags(text: string): string {
  return escapePreloadTags(text).replace(/<(\/?)managers-delta>/g, "&lt;$1managers-delta&gt;");
}

/** `2026-09-26T07:04:13Z` → `2026-09-26 07:04Z`. */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "?";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : iso;
}

function capped<T>(title: string, items: T[], line: (x: T) => string, more: string): string[] {
  if (items.length === 0) return [];
  const out = [`${title} (${items.length}):`, ...items.slice(0, DELTA_SECTION_CAP).map(line)];
  if (items.length > DELTA_SECTION_CAP) out.push(`- +${items.length - DELTA_SECTION_CAP} more (${more})`);
  return out;
}

function answerLine(t: TaskSummary): string {
  const a = t.answer!;
  const what = [
    a.choice ? `chose "${escapeTags(oneLine(a.choice, 80))}"` : "",
    a.text ? `said: ${escapeTags(oneLine(a.text, 200))}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `- ${t.id} · answered by ${a.by ?? "?"} at ${stamp(a.at)}${what ? ` · ${what}` : ""} · now ${t.status}`;
}

function taskLine(t: TaskSummary): string {
  return `- ${t.id} · now ${t.status}${t.objective ? ` · objective ${t.objective}` : ""} · updated ${stamp(t.updated)}`;
}

function objectiveLine(o: ObjectiveSummary): string {
  return `- ${o.id} · ${o.status} · updated ${stamp(o.updated)}`;
}

function episodeLine(e: Episode): string {
  const bits = [
    stamp(e.at),
    `imp ${e.importance}`,
    e.source,
    e.objective ? `objective ${e.objective}` : "project log",
    e.tags.length ? e.tags.map((t) => `#${t}`).join(" ") : null,
  ].filter(Boolean);
  return `- ${e.id} · ${bits.join(" · ")}`;
}

const SECOND = 1_000;
const MINUTE = 60_000;
const floorTo = (ms: number, unit: number) => Math.floor(ms / unit) * unit;

function atOrAfter(iso: string | null | undefined, ms: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= ms;
}

// Keys for ChatTurn.seen: a record as it stood at a turn boundary.
const episodeKey = (e: Episode) => `ep:${e.id}`;
const answerKey = (t: TaskSummary) => `answer:${t.id}@${t.answer?.at ?? ""}`;
const taskKey = (t: TaskSummary) => `task:${t.id}@${t.updated ?? ""}`;
const objectiveKey = (o: ObjectiveSummary) => `objective:${o.id}@${o.updated ?? ""}`;

/** The open tasks plus every done month from `fromMs`'s through `now`'s. */
async function readTasks(state: ManagersState, dir: string, fromMs: number, now: Date): Promise<TaskSummary[]> {
  const layout = state.layout(dir);
  const open = await state.tasks.list(layout);
  const tasks: TaskSummary[] = [...open.tasks];
  const fromMonth = new Date(fromMs).toISOString().slice(0, 7);
  const toMonth = now.toISOString().slice(0, 7);
  for (const m of open.doneMonths.filter((m) => m >= fromMonth && m <= toMonth).sort()) {
    tasks.push(...(await state.tasks.list(layout, { month: m })).tasks);
  }
  return tasks;
}

/*
 * Timestamps on disk are coarse: answers and `updated` to the second, episodes
 * to the minute. So a delta measures from the boundary's second (or minute) —
 * never missing a change made just after it — and leaves out what was already
 * there at that boundary, which the turn either saw or made itself.
 */

/** What is already in the store at a turn's START: episodes in its minute, answers in its second. */
export async function seenAtStart(state: ManagersState, dir: string, at: Date): Promise<string[]> {
  const ms = at.getTime();
  const episodes = await state.episodes.since(state.layout(dir), floorTo(ms, MINUTE));
  const tasks = await readTasks(state, dir, ms, at);
  return [
    ...episodes.map(episodeKey),
    ...tasks.filter((t) => atOrAfter(t.answer?.at, floorTo(ms, SECOND))).map(answerKey),
  ];
}

/** What is already in the store at a turn's END: task and objective updates in its second. */
export async function seenAtEnd(state: ManagersState, dir: string, at: Date): Promise<string[]> {
  const from = floorTo(at.getTime(), SECOND);
  const tasks = await readTasks(state, dir, from, at);
  const { objectives } = await state.objectives.list(state.layout(dir));
  return [
    ...tasks.filter((t) => atOrAfter(t.updated, from)).map(taskKey),
    ...objectives.filter((o) => atOrAfter(o.updated, from)).map(objectiveKey),
  ];
}

export interface ChatDeltaParams {
  /** The workspace's directory. */
  dir: string;
  /** This chat's session id (its own episodes are left out). */
  sessionId: string;
  /** The chat's previous turn. */
  previous: ChatTurn;
  now: Date;
}

/** The delta body, or null when nothing changed since the chat's previous turn. */
export async function buildChatDelta(state: ManagersState, p: ChatDeltaParams): Promise<string | null> {
  const layout = state.layout(p.dir);
  const startMs = Date.parse(p.previous.start);
  const endMs = Date.parse(p.previous.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const seen = new Set(p.previous.seen ?? []);

  const tasks = await readTasks(state, p.dir, startMs, p.now);
  const answered = tasks
    .filter((t) => atOrAfter(t.answer?.at, floorTo(startMs, SECOND)) && !seen.has(answerKey(t)))
    .sort((a, b) => b.answer!.at!.localeCompare(a.answer!.at!) || a.id.localeCompare(b.id));
  const answeredIds = new Set(answered.map((t) => t.id));
  const changed = tasks
    .filter((t) => !answeredIds.has(t.id) && atOrAfter(t.updated, floorTo(endMs, SECOND)) && !seen.has(taskKey(t)))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.id.localeCompare(b.id));

  const { objectives } = await state.objectives.list(layout);
  const objChanged = objectives
    .filter((o) => atOrAfter(o.updated, floorTo(endMs, SECOND)) && !seen.has(objectiveKey(o)))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.id.localeCompare(b.id));

  const episodes = (await state.episodes.since(layout, floorTo(startMs, MINUTE))).filter(
    (e) => e.chat !== p.sessionId && !seen.has(episodeKey(e)),
  );

  const lines = [
    ...capped("Answers from Ed", answered, answerLine, "list_tasks"),
    ...capped("Task changes", changed, taskLine, "list_tasks"),
    ...capped("Objectives updated", objChanged, objectiveLine, "list_objectives"),
    ...capped("New episodes (from Ed, runs and other chats)", episodes, episodeLine, "read_objective or the project log"),
  ];
  if (lines.length === 0) return null;

  const head =
    `## Changed since your last turn\n` +
    `Since ${stamp(p.previous.start)} (this chat's previous turn). Ids only: read a record before relying on it.\n\n`;
  return head + clip(lines.join("\n"), DELTA_BUDGET - head.length, "list_tasks / list_objectives for the rest");
}

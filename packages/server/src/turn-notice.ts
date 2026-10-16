/**
 * Turn-notice classification (issue #329)
 *
 * A keeper turn can end without producing a normal assistant reply, and today
 * those endings are INVISIBLE in the UI — the chat just looks dead. Two families:
 *
 *   1. A **synthetic** runtime message. The Claude Code CLI answers a turn it
 *      cannot really run with an assistant message tagged `model:"<synthetic>"`
 *      and `stop_reason:"stop_sequence"`. The most important one on this box is
 *      the shared Max-plan quota: `"You've hit your session limit · resets …"`.
 *      The interleaved `"No response requested."` placeholders are the runtime
 *      declining its own follow-up turns under the limit. `@herdctl/chat`'s
 *      translator DROPS every synthetic message (so no text ever streams), and
 *      `@herdctl/core`'s history parser drops them too — hence the silent stop.
 *
 *   2. A terminal **error result**. The Claude Agent SDK ends a turn with a
 *      `type:"result"` message whose `subtype`/`is_error` mark a failure:
 *      `error_max_turns` (the turn hit its max-turns cap and wrote NOTHING
 *      renderable to the transcript), `error_during_execution`, an API/overload
 *      error, etc.
 *
 * This module turns either signal into a small {@link TurnNotice} DTO that the
 * live path (`ws.ts` per-message inspection) and the history-hydration path
 * (`scanTranscriptNotice`) both surface to the client as a distinct notice turn.
 * Pure + unit-tested; no I/O except {@link scanTranscriptNotice}.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { encodedTranscriptDir } from "./transcripts.js";

/** Sentinel model the CLI stamps on its synthetic placeholder turns. Mirrors
 *  `@herdctl/chat`'s `SYNTHETIC_MODEL` (kept local to avoid a value import churn). */
export const SYNTHETIC_MODEL = "<synthetic>";

/** The three notice families a dead-ended turn resolves to. */
export type TurnNoticeKind = "usage_limit" | "error" | "max_turns";

/**
 * A surfaced turn-ending condition. `message` is the one-line human summary the
 * banner shows; `resetTime` (usage-limit only) is the parsed "resets …" clause;
 * `retryable` says whether offering a Continue/Retry affordance is safe (a usage
 * limit is NOT retryable — it only clears when the quota resets).
 */
export interface TurnNotice {
  kind: TurnNoticeKind;
  message: string;
  /** Usage-limit only: the reset clause, e.g. `"7:10pm (America/New_York)"`. */
  resetTime?: string;
  /** Optional secondary detail (e.g. the raw SDK error subtype / message). */
  detail?: string;
  /** Whether a Continue/Retry affordance is safe to offer for this notice. */
  retryable: boolean;
  /**
   * #11: set when the notice is the Claude RUNTIME's own error rather than the
   * agent's — a synthetic API-error message (expired login, bad key, billing,
   * overload). The SDK's error code (`authentication_failed`, …) or `"unknown"`.
   * The run record classes such a failure as `runtime`, which feeds Home's
   * instance-level `runtime-unavailable` alert.
   */
  apiError?: string;
}

/** Loosely-typed shape of the fields we read off an SDK message / JSONL entry. */
interface RawMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  success?: boolean;
  /** SDK stream: the API error behind a synthetic assistant message (`authentication_failed`, …). */
  error?: unknown;
  /** SDK stream: marks a synthetic assistant message that reports an API error. */
  is_api_error_message?: boolean;
  /** Transcript JSONL: the same two flags plus the HTTP status, camelCased. */
  isApiErrorMessage?: boolean;
  apiErrorStatus?: unknown;
  api_error_status?: unknown;
  message?: { role?: string; model?: string; content?: unknown; stop_reason?: string };
}

/** The longest runtime error text a notice, a run record or an alert carries. */
export const RUNTIME_ERROR_MAX = 300;

/**
 * A runtime error's text, made safe to store and show: one line, anything that
 * looks like a credential replaced by `[redacted]`, clipped to
 * {@link RUNTIME_ERROR_MAX}. The CLI's own messages ("Not logged in · Please run
 * /login") carry no secret, but an `API Error: 400 {…}` echoes a response body,
 * so this never trusts the text.
 */
export function sanitizeRuntimeText(text: string): string {
  const one = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(sk-ant-[a-z0-9]+-)[A-Za-z0-9_-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/\b(bearer)\s+[^\s"',}]{8,}/gi, "$1 [redacted]")
    .replace(/\b(token|api[-_ ]?key|x-api-key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[redacted]");
  return one.length > RUNTIME_ERROR_MAX ? `${one.slice(0, RUNTIME_ERROR_MAX - 1)}…` : one;
}

/**
 * Older CLIs (and odd paths) emit a synthetic API-error reply without the
 * `error` / `is_api_error_message` flags. Recognise the texts seen in the wild so
 * an expired login is never filed as a harmless placeholder again.
 */
const RUNTIME_ERROR_TEXT =
  /^API Error\b|Invalid API key|Please run \/login|Not logged in|OAuth token (has )?(expired|been revoked)|Credit balance is too low|authentication_error|\bunauthori[sz]ed\b/i;

/** SDK error codes that will fail every retry until a human fixes the login/billing. */
const NON_RETRYABLE_API_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

/**
 * The runtime-error notice for a synthetic assistant message, or null when the
 * message is not one (#11). Reads the SDK stream's `error` / `is_api_error_message`,
 * the transcript's `isApiErrorMessage` / `apiErrorStatus`, then the text.
 */
function syntheticApiError(m: RawMessage, text: string): TurnNotice | null {
  const code = typeof m.error === "string" && m.error ? m.error : null;
  const flagged = m.is_api_error_message === true || m.isApiErrorMessage === true;
  if (!code && !flagged && !RUNTIME_ERROR_TEXT.test(text)) return null;
  const statusRaw = m.api_error_status ?? m.apiErrorStatus;
  const status = typeof statusRaw === "number" ? statusRaw : null;
  const apiError = code ?? "unknown";
  const message = sanitizeRuntimeText(text) || "Claude's runtime returned an error before producing a reply.";
  return {
    kind: "error",
    message,
    detail: [apiError, status !== null ? `HTTP ${status}` : null].filter(Boolean).join(" · "),
    retryable: !NON_RETRYABLE_API_ERRORS.has(apiError),
    apiError,
  };
}

/**
 * Classify a whole synthetic (`model: "<synthetic>"`) assistant message: a usage
 * limit, a runtime API error (#11), a suppressed placeholder (`"declined"`), or
 * null for empty text. The ONE classifier both the live path and the history scan
 * use, so a reload never disagrees with what streamed.
 */
export function classifySyntheticMessage(m: RawMessage): TurnNotice | "declined" | null {
  const text = contentText(m.message?.content);
  const r = classifySyntheticText(text);
  if (r && r !== "declined") return r; // the usage limit wins (it carries a reset time)
  return syntheticApiError(m, text) ?? r;
}

/** Flatten an assistant `content` (string, or an array of text blocks) to text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

/**
 * Classify a synthetic assistant message's text.
 *
 * Returns a `usage_limit` {@link TurnNotice} for a "session/usage limit" message
 * (with the reset clause parsed out), the sentinel `"declined"` for the
 * runtime's own `"No response requested."` (and any other non-limit synthetic —
 * a placeholder the UI should simply suppress, never render), or `null` for
 * empty text.
 */
export function classifySyntheticText(text: string): TurnNotice | "declined" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // The shared Max-plan quota. Match on "session limit" / "usage limit" rather
  // than the exact string so a reworded CLI message still surfaces.
  if (/\b(session|usage) limit\b/i.test(trimmed) || /hit your .*limit/i.test(trimmed)) {
    const resetTime = /resets?\s+(.+?)\s*$/i.exec(trimmed)?.[1]?.trim() || undefined;
    return {
      kind: "usage_limit",
      message: trimmed,
      ...(resetTime ? { resetTime } : {}),
      retryable: false,
    };
  }
  // "No response requested." and any other synthetic placeholder: not a limit,
  // carries no real output — suppress it (never a chat bubble).
  return "declined";
}

/** Human-readable message for a terminal error `result`'s subtype. */
function errorMessageForSubtype(subtype: string | undefined): { kind: TurnNoticeKind; message: string } {
  if (subtype === "error_max_turns") {
    return {
      kind: "max_turns",
      message: "Claude reached its turn limit before finishing this turn.",
    };
  }
  return {
    kind: "error",
    message: "Claude's turn failed before producing a reply.",
  };
}

/**
 * Classify a terminal `type:"result"` SDK message. Returns an `error`/`max_turns`
 * {@link TurnNotice} when the result marks a genuine failure, else `null` for a
 * successful turn.
 *
 * The authoritative failure signal is the **subtype** — the SDK's error results
 * always carry an `error_*` subtype (`error_during_execution`, `error_max_turns`,
 * …) — or an explicit `success === false`. This mirrors `@herdctl/core`'s own
 * success computation (`chatSession`: `subtype.startsWith("error") || success ===
 * false`), so Paddock's banner never disagrees with herdctl about whether a turn
 * failed.
 *
 * We DELIBERATELY do NOT treat `is_error === true` as a failure on its own
 * (issue #329 regression): `SDKResultSuccess` is typed `is_error: boolean`, and
 * the runtime stamps `is_error:true` (with `api_error_status`) on a
 * `subtype:"success"` result when the turn RECOVERED from a transient mid-turn
 * API error (e.g. "Connection closed mid-response") and still produced a normal
 * reply. Reading that as a turn failure rendered a false "turn failed" banner
 * directly beneath a perfectly good reply on essentially every session-mode turn.
 * A genuine error always carries an `error_*` subtype, so nothing is lost.
 */
export function classifyResult(result: {
  subtype?: string;
  is_error?: boolean;
  success?: boolean;
}): TurnNotice | null {
  const subtype = typeof result.subtype === "string" ? result.subtype : undefined;
  // A `subtype:"success"` result is a completed turn, full stop. `is_error` only
  // counts as a failure when the runtime gave us NO subtype at all (defensive:
  // some other runtime shape that reports is_error without one).
  const failed =
    (subtype !== undefined && subtype.startsWith("error")) ||
    result.success === false ||
    (subtype === undefined && result.is_error === true);
  if (!failed) return null;
  const { kind, message } = errorMessageForSubtype(subtype);
  return {
    kind,
    message,
    ...(subtype ? { detail: subtype } : {}),
    retryable: true,
  };
}

/** Build a plain `error` notice from a free-text turn-failure message (a thrown
 *  error / a failed `chat:complete` that never reached a `result`). */
export function errorNotice(message: string | undefined): TurnNotice {
  const detail = message?.trim();
  return {
    kind: "error",
    message: "Claude's turn failed before producing a reply.",
    ...(detail ? { detail } : {}),
    retryable: true,
  };
}

/**
 * Classify one raw SDK/JSONL message. Surfaces a {@link TurnNotice} for a
 * synthetic usage-limit assistant message or a terminal error result; returns
 * `null` for everything else — ordinary output, a successful result, and every
 * suppressed synthetic placeholder (`"No response requested."`).
 */
export function noticeFromMessage(m: RawMessage): TurnNotice | null {
  if (m.type === "assistant" && m.message?.model === SYNTHETIC_MODEL) {
    const r = classifySyntheticMessage(m);
    return r && r !== "declined" ? r : null;
  }
  if (m.type === "result") {
    return classifyResult(m);
  }
  return null;
}

/**
 * Did this streamed message emit REAL assistant prose — a non-synthetic assistant
 * message carrying non-empty **text** content, regardless of `stop_reason`?
 *
 * The live paths (`ws.ts`) OR-accumulate this across every message of a turn (a
 * per-turn `producedReply` flag) so a terminal error/`max_turns` result that
 * arrives AFTER the turn already showed the user real prose does not paint a false
 * "turn failed" banner beneath the answer (issues #380, #394). In session mode the
 * SDK's terminal `result` frame — streamed live but never persisted — can carry an
 * `error_*` subtype / `success:false` even though the turn produced a perfectly
 * good reply; on reload the history path ({@link scanTranscriptNotice}) suppresses
 * the dead-end via its "any real assistant text supersedes the notice" rule, and
 * this predicate lets the live path apply the SAME rule.
 *
 * #394 — why this is TEXT-ANY-STOP_REASON, not text+`end_turn`. The original #380
 * predicate required a SINGLE message with non-empty text AND `stop_reason:
 * "end_turn"`. Long tool-driven turns break both halves: (a) the visible prose
 * usually rides on a message that ALSO makes a tool call → `stop_reason:"tool_use"`
 * (excluded by the old gate), and (b) the terminal `end_turn` message is frequently
 * **thinking-only** (zero text). So `producedReply` never flipped true and the
 * benign terminal error result was surfaced. Keying off ANY non-synthetic assistant
 * text (across all of the turn's messages, no `stop_reason` gate) makes a
 * text+`tool_use` message count and exactly matches `scanTranscriptNotice`, killing
 * the live/history asymmetry.
 *
 * DELIBERATELY text-only (a bare `thinking` block does NOT count): this mirrors the
 * history path — which clears only on real text — so a genuinely empty turn (no
 * assistant text ANYWHERE, e.g. an `error_max_turns` that wrote nothing renderable)
 * still surfaces its error notice.
 */
export function messageProducedReply(m: RawMessage): boolean {
  if (m.type !== "assistant") return false;
  if (m.message?.model === SYNTHETIC_MODEL) return false;
  return contentText(m.message?.content).trim().length > 0;
}

/**
 * Should an already-classified {@link TurnNotice} be dropped because a complete
 * reply already streamed this turn (issue #380)? An `error` / `max_turns`
 * dead-end beneath a good answer is a false alarm — suppress it. A `usage_limit`
 * is NOT suppressed: a session-limit stop is a real dead-end still worth showing
 * even alongside text.
 */
export function suppressNoticeAfterReply(notice: TurnNotice, producedReply: boolean): boolean {
  return producedReply && (notice.kind === "error" || notice.kind === "max_turns");
}

/**
 * Did this turn effectively succeed for the purposes of its post-turn side
 * effects — the queue drain, the after-turn curation sweep, and the recovery
 * watch (issue #404)?
 *
 * The raw `result.success` handed back by the drive is computed purely from the
 * terminal `result` frame (`!error_* subtype && !success:false`). In session
 * mode that frame routinely carries an `error_*` subtype / `success:false` even
 * when a complete reply already streamed — the very asymmetry the #380/#394
 * banner fix exists for. Gating side effects on the raw signal silently strands
 * a queued follow-up (the flush that {@link drainQueue} owns never runs), skips
 * the sweep, and drops the recovery arm.
 *
 * This is the side-effect twin of {@link suppressNoticeAfterReply}: both trust
 * the same `producedReply` signal (a real assistant reply streamed this turn) to
 * override a benign trailing failure. A turn is effectively successful when the
 * raw signal says so OR a real reply was produced. A genuinely dead turn (no
 * reply — a Stop, an up-front API error) keeps `false`, so its queue is held.
 */
export function turnEffectivelySucceeded(rawSuccess: boolean, producedReply: boolean): boolean {
  return rawSuccess || producedReply;
}

/**
 * Scan a transcript JSONL file for a TRAILING dead-end notice to surface on
 * reload (the history-hydration path). Only the synthetic cases (a usage limit,
 * and since #11 a runtime API error such as an expired login, which the CLI
 * persists with `isApiErrorMessage`) are recoverable from history: `@herdctl/core` drops synthetic messages when it
 * parses the transcript, and an `error_max_turns` turn writes NOTHING at all —
 * so those are live-only.
 *
 * A usage-limit notice is surfaced only when it is the LAST thing that happened
 * on the transcript: a later real assistant reply (a non-synthetic assistant
 * message with text) means the chat recovered, so any earlier limit is cleared.
 * Returns the trailing notice, or `null`. Never throws (a missing/unreadable
 * file → `null`).
 */
export async function scanTranscriptNotice(filePath: string): Promise<TurnNotice | null> {
  let pending: TurnNotice | null = null;
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: RawMessage;
      try {
        entry = JSON.parse(trimmed) as RawMessage;
      } catch {
        continue;
      }
      if (entry.type !== "assistant") continue;
      const model = entry.message?.model;
      if (model === SYNTHETIC_MODEL) {
        const r = classifySyntheticMessage(entry);
        if (r && r !== "declined") pending = r; // a usage-limit or runtime-error dead-end
        // a "declined" placeholder neither sets nor clears the pending notice
      } else if (contentText(entry.message?.content).trim().length > 0) {
        // A real assistant reply: the turn was actually answered → clear.
        pending = null;
      }
    }
  } catch {
    return null;
  }
  return pending;
}

/** #11: the run error for a turn that ended with nothing at all. */
export const NO_OUTPUT_ERROR =
  "The agent produced no output: the turn ended with no assistant message and zero output tokens.";

/** The notice a live viewer sees for a {@link NO_OUTPUT_ERROR} turn. */
export function noOutputNotice(): TurnNotice {
  return {
    kind: "error",
    message: "Claude ended the turn without producing any output.",
    detail: "no assistant message · 0 output tokens",
    retryable: true,
  };
}

/** Is this notice the Claude runtime's own refusal (an API error or a usage limit), not the agent's? */
export function isRuntimeNotice(n: TurnNotice | null | undefined): boolean {
  return !!n && (n.apiError !== undefined || n.kind === "usage_limit");
}

/** A runtime notice as one stored error line: its message plus the detail (`authentication_failed · HTTP 401`). */
export function runtimeErrorText(n: TurnNotice): string {
  return sanitizeRuntimeText(n.detail && n.apiError !== undefined ? `${n.message} (${n.detail})` : n.message);
}

/** What a finished turn looked like, for {@link judgeTurn}. */
export interface TurnFacts {
  /** The drive's own verdict (`result.success`): reply-unaware, and blind to a synthetic API error. */
  rawSuccess: boolean;
  rawError?: string;
  /** Real (non-synthetic) assistant prose streamed this turn. */
  producedReply: boolean;
  /** Any non-synthetic assistant content at all (text, a tool call, thinking). */
  sawAssistantContent: boolean;
  /** The turn's output tokens; undefined when no usage was observed (counts as zero). */
  outputTokens: number | undefined;
  /** The dead-end notice the turn surfaced, if any. */
  deadEnd: TurnNotice | null;
}

export interface TurnVerdict {
  /** Did the turn do its job? The run record's `succeeded`/`failed`. */
  success: boolean;
  error?: string;
  errorKind?: "runtime" | "no-output";
  /** Gate for the post-turn side effects (sweep, recovery arm), see {@link turnEffectivelySucceeded}. */
  sideEffects: boolean;
  /** A notice to surface because nothing else explained the failure (the empty turn). */
  notice: TurnNotice | null;
}

/**
 * The ONE judgement of whether a finished turn succeeded (#11), shared by the
 * trigger/spawn engine (`ws-turn.ts`) and the human `chat:send` path (`ws.ts`).
 *
 * The drive's `success` cannot be trusted alone. When the Claude login has expired
 * the SDK answers with a synthetic `model: "<synthetic>"` assistant message
 * ("Not logged in · Please run /login", `error: "authentication_failed"`) and a
 * `subtype: "success"` result with `is_error: true`. herdctl reads the subtype and
 * reports success, and `classifyResult` deliberately ignores `is_error` (the #329
 * regression). So:
 *
 *   - a runtime notice (synthetic API error or usage limit) fails the turn, with
 *     the runtime's own text as the error (`errorKind: runtime`);
 *   - a turn with no assistant content and zero output tokens fails
 *     (`errorKind: no-output`), even when the drive said ok, and even when the
 *     drive said why (`rawError` is kept as the error then);
 *   - otherwise the M6 rule: success needs the drive's (reply-aware) success and
 *     no surfaced dead-end.
 */
export function judgeTurn(f: TurnFacts): TurnVerdict {
  const effective = turnEffectivelySucceeded(f.rawSuccess, f.producedReply);
  if (f.deadEnd && isRuntimeNotice(f.deadEnd)) {
    return {
      success: false,
      error: runtimeErrorText(f.deadEnd),
      errorKind: "runtime",
      sideEffects: effective && f.producedReply,
      notice: null,
    };
  }
  const empty = !f.producedReply && !f.sawAssistantContent && (f.outputTokens ?? 0) === 0;
  if (empty && f.deadEnd === null) {
    return {
      success: false,
      error: f.rawSuccess ? NO_OUTPUT_ERROR : (f.rawError ?? NO_OUTPUT_ERROR),
      errorKind: "no-output",
      sideEffects: false,
      notice: f.rawSuccess ? noOutputNotice() : null,
    };
  }
  const success = effective && f.deadEnd === null;
  return {
    success,
    ...(success ? {} : { error: f.rawError ?? f.deadEnd?.message ?? "the turn did not succeed" }),
    sideEffects: effective,
    notice: null,
  };
}

/**
 * Did this streamed message carry any non-synthetic assistant content (text,
 * tool_use, thinking)? The other half of {@link judgeTurn}'s empty-turn test:
 * a tool-only turn produced no prose but did work.
 */
export function messageHasAssistantContent(m: RawMessage): boolean {
  if (m.type !== "assistant" || m.message?.model === SYNTHETIC_MODEL) return false;
  const c = m.message?.content;
  return typeof c === "string" ? c.trim().length > 0 : Array.isArray(c) && c.length > 0;
}

/** Session ids are uuids; anything else never becomes a path. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #11, the batch shape: the CLI writes its synthetic API-error reply and exits 1
 * at once, and herdctl's transcript watcher can lose that race, so the drive
 * fails with a generic "exit code 1" and the message never streams. Read it from
 * the transcript instead. Returns the trailing RUNTIME notice (an API error or a
 * usage limit), else null. Never throws.
 */
export async function runtimeNoticeFromTranscript(
  claudeHome: string | undefined,
  workingDir: string | undefined,
  sessionId: string | null | undefined,
): Promise<TurnNotice | null> {
  if (!claudeHome || !workingDir || !sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const n = await scanTranscriptNotice(path.join(encodedTranscriptDir(claudeHome, workingDir), `${sessionId}.jsonl`));
  return n && isRuntimeNotice(n) ? n : null;
}

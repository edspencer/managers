/**
 * #11: a turn the Claude RUNTIME refused is a failure, not a quiet success.
 *
 * From 2026-10-04 to 2026-10-16 every turn on the production instance died on an
 * expired login, and every run was recorded `succeeded`. The SDK answers such a
 * turn with ONE synthetic assistant message ("Not logged in · Please run /login",
 * `model: "<synthetic>"`, `error: "authentication_failed"`) and a result whose
 * subtype is `success` (with `is_error: true`). herdctl reads the subtype, and
 * `classifySyntheticText` filed the text as a harmless "declined" placeholder, so
 * nothing anywhere said "failed".
 *
 * The fixtures below are the EXACT shapes Claude Code 2.1.283 emitted against a
 * stub API answering 401 (`CLAUDE_CODE_MAX_RETRIES=0`), stream and transcript.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SDKMessage } from "@herdctl/core";
import {
  classifySyntheticMessage,
  noticeFromMessage,
  scanTranscriptNotice,
  sanitizeRuntimeText,
  judgeTurn,
  messageHasAssistantContent,
  NO_OUTPUT_ERROR,
  type TurnNotice,
} from "../../src/turn-notice.js";
import { makeTurnEngine } from "../../src/ws-turn.js";
import { BackgroundRegistry } from "../../src/background-live.js";
import { SessionHub } from "../../src/session-hub.js";
import type { ChatHandlerDeps, TurnCompletion } from "../../src/ws-context.js";

const SID = "72e416d2-0252-4c7e-b403-1d1ec8fec885";
const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** The SDK stream's synthetic assistant message, as captured. */
const streamSynthetic = (text = "Not logged in · Please run /login") => ({
  type: "assistant",
  message: {
    id: "4807932f-fb72-4d01-8634-ec94857341c8",
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    stop_sequence: "",
    type: "message",
    usage: zeroUsage,
    content: [{ type: "text", text }],
  },
  parent_tool_use_id: null,
  session_id: SID,
  uuid: "d3b41acc-7ebb-45af-aafa-2d46b06574d8",
  error: "authentication_failed",
  request_id: "req_stub",
  is_api_error_message: true,
});

/** The terminal result that followed it, as captured. */
const streamResult = (text = "Not logged in · Please run /login") => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 401,
  terminal_reason: "api_error",
  stop_reason: "stop_sequence",
  duration_ms: 92,
  duration_api_ms: 0,
  num_turns: 1,
  result: text,
  session_id: SID,
  total_cost_usd: 0,
  usage: zeroUsage,
  modelUsage: {},
  permission_denials: [],
});

/** The same message as the CLI persisted it in the transcript JSONL. */
const transcriptSynthetic = (text = "Invalid API key · Fix external API key") => ({
  parentUuid: "ec8ad1e1-23c2-4ea2-9820-2ef031ebbebe",
  isSidechain: false,
  type: "assistant",
  uuid: "7c303434-4cb2-4b4c-96dd-0b81d08b2c52",
  timestamp: "2026-10-16T14:57:43.869Z",
  message: {
    id: "2f95aec7-cb2e-433c-9a56-d6328c37c84c",
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    type: "message",
    usage: zeroUsage,
    content: [{ type: "text", text }],
  },
  requestId: "req_stub",
  error: "authentication_failed",
  isApiErrorMessage: true,
  apiErrorStatus: 401,
  sessionId: SID,
});

describe("classifying a synthetic API-error message (#11)", () => {
  it("the SDK stream's auth failure is an error notice carrying the runtime's own text", () => {
    expect(noticeFromMessage(streamSynthetic())).toEqual({
      kind: "error",
      message: "Not logged in · Please run /login",
      detail: "authentication_failed",
      retryable: false,
      apiError: "authentication_failed",
    });
  });

  it("the transcript's camelCase shape classifies the same, with the HTTP status", () => {
    expect(classifySyntheticMessage(transcriptSynthetic())).toEqual({
      kind: "error",
      message: "Invalid API key · Fix external API key",
      detail: "authentication_failed · HTTP 401",
      retryable: false,
      apiError: "authentication_failed",
    });
  });

  it("an unflagged older-CLI message is recognised by its text", () => {
    const old = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "OAuth token has expired. Please obtain a new token or refresh your existing token." }] } };
    const n = noticeFromMessage(old)!;
    expect(n).toMatchObject({ kind: "error", apiError: "unknown", retryable: true });
    expect(n.message).toBe("OAuth token has expired. Please obtain a new token or refresh your existing token.");
  });

  it("a transient server error stays retryable", () => {
    const m = { ...streamSynthetic("API Error: 529 Overloaded"), error: "overloaded" };
    expect(noticeFromMessage(m)).toMatchObject({ kind: "error", apiError: "overloaded", retryable: true });
  });

  it("CONTROL: the 'No response requested.' placeholder is still suppressed", () => {
    const m = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } };
    expect(noticeFromMessage(m)).toBeNull();
  });

  it("CONTROL: a session limit is still a usage_limit (its reset time wins over the error flag)", () => {
    const m = { ...streamSynthetic("You've hit your session limit · resets 7:10pm (America/New_York)"), error: "rate_limit" };
    expect(noticeFromMessage(m)).toMatchObject({ kind: "usage_limit", resetTime: "7:10pm (America/New_York)" });
  });

  it("CONTROL: the captured result (subtype success, is_error true) is not itself a dead-end (#329 rule kept)", () => {
    expect(noticeFromMessage(streamResult())).toBeNull();
  });

  it("the synthetic message is not assistant content; a real tool-only message is", () => {
    expect(messageHasAssistantContent(streamSynthetic())).toBe(false);
    expect(
      messageHasAssistantContent({ type: "assistant", message: { model: "claude-opus-5", content: [{ type: "tool_use" }] } }),
    ).toBe(true);
  });
});

describe("sanitizeRuntimeText (#11)", () => {
  it("redacts anything credential-shaped, flattens and clips", () => {
    const out = sanitizeRuntimeText(
      `API Error: 401 {"error":"bad token: sk-ant-oat01-AAAAbbbbCCCCddddEEEE"}\n  Authorization: Bearer abcdefghijklmnop ${"more words ".repeat(60)}`,
    );
    expect(out).not.toContain("AAAAbbbb");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves the CLI's own messages untouched", () => {
    for (const t of [
      "Not logged in · Please run /login",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
      "Invalid API key · Fix external API key",
    ]) {
      expect(sanitizeRuntimeText(t)).toBe(t);
    }
  });
});

describe("judgeTurn (#11)", () => {
  const authNotice = noticeFromMessage(streamSynthetic()) as TurnNotice;
  const base = { rawSuccess: true, producedReply: false, sawAssistantContent: false, outputTokens: 0, deadEnd: null };

  it("a runtime refusal fails the run with its text, even though the drive said ok", () => {
    expect(judgeTurn({ ...base, deadEnd: authNotice })).toEqual({
      success: false,
      error: "Not logged in · Please run /login (authentication_failed)",
      errorKind: "runtime",
      sideEffects: false,
      notice: null,
    });
  });

  it("the batch shape (drive failed with a generic exit) still records the runtime's text", () => {
    const v = judgeTurn({ ...base, rawSuccess: false, rawError: "Claude CLI exited with code 1", deadEnd: authNotice });
    expect(v).toMatchObject({ success: false, errorKind: "runtime" });
    expect(v.error).toContain("Not logged in");
  });

  it("an empty turn the drive called a success fails as no-output, with a notice", () => {
    const v = judgeTurn({ ...base });
    expect(v).toMatchObject({ success: false, error: NO_OUTPUT_ERROR, errorKind: "no-output", sideEffects: false });
    expect(v.notice).toMatchObject({ kind: "error" });
  });

  it("missing usage counts as zero output", () => {
    expect(judgeTurn({ ...base, outputTokens: undefined }).errorKind).toBe("no-output");
  });

  it("CONTROL: a normal reply succeeds", () => {
    expect(judgeTurn({ ...base, producedReply: true, sawAssistantContent: true, outputTokens: 64 })).toEqual({
      success: true,
      sideEffects: true,
      notice: null,
    });
  });

  it("CONTROL: a tool-only turn with output succeeds", () => {
    expect(judgeTurn({ ...base, sawAssistantContent: true, outputTokens: 12 }).success).toBe(true);
  });

  it("CONTROL: a reply followed by a benign error result still succeeds (#380)", () => {
    const err: TurnNotice = { kind: "error", message: "x", retryable: true };
    // emitNotice suppresses that notice after a reply, so deadEnd stays null.
    expect(judgeTurn({ ...base, rawSuccess: false, producedReply: true, sawAssistantContent: true, outputTokens: 5 }).success).toBe(true);
    expect(judgeTurn({ ...base, deadEnd: err, outputTokens: 5 }).errorKind).toBeUndefined();
  });
});

describe("scanTranscriptNotice: a refused turn survives a reload (#11)", () => {
  it("surfaces the persisted auth failure as the trailing notice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rt-refusal-"));
    try {
      const file = path.join(dir, `${SID}.jsonl`);
      const user = { type: "user", message: { role: "user", content: "hello" }, sessionId: SID };
      await writeFile(file, [user, transcriptSynthetic()].map((l) => JSON.stringify(l)).join("\n") + "\n");
      expect(await scanTranscriptNotice(file)).toMatchObject({
        kind: "error",
        message: "Invalid API key · Fix external API key",
        apiError: "authentication_failed",
      });
      // A later real reply clears it.
      const reply = { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "hi" }] } };
      await writeFile(file, [user, transcriptSynthetic(), reply].map((l) => JSON.stringify(l)).join("\n") + "\n");
      expect(await scanTranscriptNotice(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The SESSION drive path (the production default) cannot be reached by the fake
 * `claude` (it runs the SDK), so drive `startAgentTurn` with a stubbed
 * `chatSession` that streams the captured SDK messages and reports what herdctl
 * reports for them: success.
 */
describe("startAgentTurn on the session path (#11)", () => {
  function harness(messages: unknown[]) {
    const notices: TurnNotice[] = [];
    const herdctl = new Proxy(
      {
        chatSession: vi.fn(async (_agent: string, opts: { onMessage: (m: SDKMessage) => Promise<void> }) => {
          for (const m of messages) await opts.onMessage(m as SDKMessage);
          return { jobId: "turn-1", agentName: "keeper-acme", scheduleName: null, startedAt: "", prompt: "", success: true, sessionId: SID };
        }),
      } as Record<string, unknown>,
      { get: (t, p: string) => (t[p] ??= vi.fn(async () => undefined)) },
    );
    const hub = new SessionHub();
    const origStart = hub.startTurn.bind(hub);
    hub.startTurn = ((...args: Parameters<SessionHub["startTurn"]>) => {
      const turn = origStart(...args);
      const emit = turn.emit.bind(turn);
      turn.emit = (frame: { type: string; payload: { notice?: TurnNotice } }) => {
        if (frame.type === "chat:notice" && frame.payload.notice) notices.push(frame.payload.notice);
        return emit(frame as never);
      };
      return turn;
    }) as SessionHub["startTurn"];
    const deps = {
      herdctl,
      cfg: { recovery: {}, maxSpawnDepth: 0 },
      projects: { get: vi.fn(async () => ({ slug: "acme", workingDir: "/nonexistent" })) },
      attachments: { save: vi.fn(async () => "") },
    } as unknown as ChatHandlerDeps;
    const engine = makeTurnEngine({ deps, hub, background: new BackgroundRegistry() });
    return { engine, notices };
  }

  async function run(messages: unknown[]) {
    const h = harness(messages);
    const done = new Promise<TurnCompletion>((resolve) => {
      void h.engine.startAgentTurn({
        projectSlug: "acme",
        agentName: "keeper-acme",
        workingDir: "/nonexistent",
        resume: null,
        prompt: "wake",
        driveMode: "session",
        origin: "scheduled",
        depth: 0,
        maxSpawnDepth: 0,
        runId: "r-261016-1500-ab",
        onComplete: resolve,
      });
    });
    return { completion: await done, notices: h.notices };
  }

  it("an expired login: the run fails with the runtime's message, and the chat shows it", async () => {
    const { completion, notices } = await run([streamSynthetic(), streamResult()]);
    expect(completion).toMatchObject({
      success: false,
      errorKind: "runtime",
      error: "Not logged in · Please run /login (authentication_failed)",
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "error", message: "Not logged in · Please run /login" });
  });

  it("a turn with no output at all fails as no-output", async () => {
    const empty = { type: "result", subtype: "success", is_error: false, session_id: SID, usage: zeroUsage };
    const { completion, notices } = await run([empty]);
    expect(completion).toMatchObject({ success: false, errorKind: "no-output", error: NO_OUTPUT_ERROR });
    expect(notices).toHaveLength(1);
  });

  it("CONTROL: a normal reply still succeeds, with no notice", async () => {
    const reply = {
      type: "assistant",
      session_id: SID,
      message: { model: "claude-opus-5", content: [{ type: "text", text: "Done." }], usage: { ...zeroUsage, output_tokens: 7 } },
    };
    const ok = { type: "result", subtype: "success", is_error: false, session_id: SID, usage: { ...zeroUsage, output_tokens: 7 } };
    const { completion, notices } = await run([reply, ok]);
    expect(completion).toMatchObject({ success: true });
    expect(completion.errorKind).toBeUndefined();
    expect(notices).toEqual([]);
  });
});

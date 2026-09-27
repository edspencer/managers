/**
 * mcp-probe — "Test connection" for a project MCP connection (Managers M9).
 *
 * Connects with the MCP SDK `Client` exactly as an agent's runtime would
 * (streamable HTTP, or SSE for `type: sse`, with the resolved headers), runs
 * `initialize` then `tools/list`, and closes. Bounded by a timeout (10 s).
 *
 * The result carries tool NAMES and a SANITISED error only: the raw transport
 * error can echo a url, a header or a response body, so it is reduced to a short
 * category ("401 Unauthorized", "ECONNREFUSED", "timed out after 10s") and never
 * includes a stack. A stdio connection is not probed: that would start a process
 * from a request handler.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerDef } from "../claude-mcp.js";

export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeResult {
  ok: boolean;
  tools: string[];
  error: string | null;
  /** Milliseconds from start to answer (or failure). */
  ms: number;
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const NET_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

/** Every `code` on an error and its `cause` chain. */
function codesOf(err: unknown): string[] {
  const out: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const rec = e as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof rec.code === "string") out.push(rec.code);
    if (typeof rec.code === "number") out.push(String(rec.code));
    if (Array.isArray(rec.errors)) for (const sub of rec.errors) out.push(...codesOf(sub));
    e = rec.cause;
  }
  return out;
}

/**
 * Reduce a transport/protocol error to a short, secret-free category. Never
 * returns the raw message: it can carry a url, a header, or a response body.
 */
export function sanitizeProbeError(err: unknown): string {
  const codes = codesOf(err);
  const net = NET_CODES.find((c) => codes.includes(c));
  if (net) return net;
  const msg = err instanceof Error ? err.message : String(err);
  // The SDK's StreamableHTTPError / SseError carry the HTTP status as `code`
  // and say "HTTP <n>" / "Non-200 status code (<n>)" in the message.
  const status =
    codes.map(Number).find((n) => n >= 400 && n < 600) ??
    Number(/\bHTTP (\d{3})\b/.exec(msg)?.[1] ?? /status code \((\d{3})\)/i.exec(msg)?.[1] ?? NaN);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    return `${status} ${HTTP_STATUS_TEXT[status] ?? "error"}`.trim();
  }
  if (/fetch failed/i.test(msg)) return "connection failed";
  if (/invalid url/i.test(msg)) return "invalid url";
  if (/timed out/i.test(msg)) return msg.replace(/[^\w .]/g, "").slice(0, 60);
  // An MCP protocol error ("MCP error -32601: …"): keep the code only.
  const mcp = /MCP error (-?\d+)/.exec(msg);
  if (mcp) return `MCP error ${mcp[1]}`;
  return "connection failed";
}

/** Probe one resolved server: `initialize`, then `tools/list`. Never throws. */
export async function probeConnection(
  def: McpServerDef,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const done = (r: Omit<ProbeResult, "ms">): ProbeResult => ({ ...r, ms: Date.now() - started });
  const type = def.type ?? (def.url ? "http" : "stdio");
  if (type === "stdio" || !def.url) {
    return done({ ok: false, tools: [], error: "stdio connections are not probed (it would start a process)" });
  }
  let url: URL;
  try {
    url = new URL(def.url);
  } catch {
    return done({ ok: false, tools: [], error: "invalid url" });
  }
  const requestInit: RequestInit = { headers: { ...(def.headers ?? {}) } };
  const transport =
    type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client({ name: "managers-probe", version: "0.1.0" });
  client.onerror = () => {
    /* transport noise (an optional SSE GET a server 405s) is not a probe failure */
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`)), timeoutMs);
  });
  const work = (async () => {
    await client.connect(transport);
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name);
  })();
  work.catch(() => undefined);
  try {
    const tools = await Promise.race([work, timeout]);
    return done({ ok: true, tools, error: null });
  } catch (err) {
    return done({ ok: false, tools: [], error: sanitizeProbeError(err) });
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

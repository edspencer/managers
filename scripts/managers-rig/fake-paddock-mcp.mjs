/**
 * fake-paddock-mcp.mjs — a stand-in for a project's Paddock `/mcp` (Managers M9).
 *
 *   node scripts/managers-rig/fake-paddock-mcp.mjs --port <N> [--token <bearer>]
 *   import { startFakePaddockMcp } from "./fake-paddock-mcp.mjs"
 *
 * A streamable-HTTP MCP server (stateless: a fresh server per request) that
 * accepts a request only with `Authorization: Bearer <token>` (default
 * `rig-token`) and answers 401 otherwise. It offers the four tools a manager's
 * Paddock connection uses day one — `list_projects`, `list_chats`, `create_chat`,
 * `read_chat` — returning CANNED, SYNTHETIC data. Nothing is created anywhere.
 *
 * `serve.mjs` spawns it on PORT+1 (or a free port when that is taken) and points
 * the rig's connections at it through `MANAGERS_RIG_PADDOCK_URL`. Tests import
 * `startFakePaddockMcp` directly and read `calls` to see what arrived (tool,
 * arguments and whether the bearer matched — never the header's value).
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const RIG_TOKEN = "rig-token";

const PROJECTS = [
  { slug: "demo", name: "Demo", status: "active" },
  { slug: "widget-lib", name: "Widget Lib (upstream)", status: "active" },
];

const CHATS = [
  { project: "demo", sessionId: "fake-chat-0001", name: "Triage #9", lastActivity: "2026-01-01T09:00:00Z" },
  { project: "demo", sessionId: "fake-chat-0002", name: "Release checklist", lastActivity: "2026-01-02T10:00:00Z" },
];

const TOOLS = [
  {
    name: "list_projects",
    description: "List the projects on this (fake) Paddock.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_chats",
    description: "List chats, optionally in one project.",
    inputSchema: { type: "object", properties: { project: { type: "string" } } },
  },
  {
    name: "create_chat",
    description: "Start a chat in a project with a prompt. Returns the new chat's id (canned).",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, prompt: { type: "string" } },
      required: ["project", "prompt"],
    },
  },
  {
    name: "read_chat",
    description: "Read a chat's messages.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, sessionId: { type: "string" } },
      required: ["project", "sessionId"],
    },
  },
];

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

function callTool(name, args, state) {
  switch (name) {
    case "list_projects":
      return text({ projects: PROJECTS });
    case "list_chats": {
      const chats = args.project ? CHATS.filter((c) => c.project === args.project) : CHATS;
      return text({ chats });
    }
    case "create_chat": {
      if (typeof args.project !== "string" || typeof args.prompt !== "string") {
        return fail("create_chat needs { project, prompt }");
      }
      if (!PROJECTS.some((p) => p.slug === args.project)) return fail(`No such project: ${args.project}`);
      state.created += 1;
      const sessionId = `fake-chat-new-${String(state.created).padStart(4, "0")}`;
      return text({ project: args.project, sessionId, started: true });
    }
    case "read_chat": {
      const chat = CHATS.find((c) => c.project === args.project && c.sessionId === args.sessionId);
      if (!chat && !/^fake-chat-new-/.test(String(args.sessionId))) return fail(`No such chat: ${args.sessionId}`);
      return text({
        sessionId: args.sessionId,
        messages: [
          { role: "user", text: "Triage the issue." },
          { role: "assistant", text: "Triaged: needs a repro. Labelled needs-info." },
        ],
      });
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Start the fake. `port: 0` picks a free port. Resolves `{ port, url, calls,
 * close }`; `calls` records `{ tool, args, authorized }` per tools/call (and
 * `{ rejected: true }` for a 401), never a header value.
 */
export async function startFakePaddockMcp({ port = 0, host = "127.0.0.1", token = RIG_TOKEN } = {}) {
  const calls = [];
  const state = { created: 0 };
  const expected = `Bearer ${token}`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.headers.authorization !== expected) {
      calls.push({ rejected: true, method: req.method });
      res
        .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
        .end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no standalone SSE stream, no sessions to delete.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const mcp = new Server({ name: "fake-paddock", version: "0.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      const args = r.params.arguments ?? {};
      calls.push({ tool: r.params.name, args, authorized: true });
      return callTool(r.params.name, args, state);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://${host}:${actual}/mcp`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Standalone (serve.mjs spawns it this way).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? dflt : process.argv[i + 1];
  };
  const port = Number(arg("port", "0"));
  const fake = await startFakePaddockMcp({ port, token: arg("token", RIG_TOKEN) });
  // The one line serve.mjs waits for. Never print the token.
  console.log(`FAKE_PADDOCK_MCP_URL=${fake.url}`);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => fake.close().then(() => process.exit(0)));
}

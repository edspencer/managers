/**
 * project-mcp — per-project MCP connections (Managers M9).
 *
 * A project declares the outside systems its manager may talk to in
 * `project.yaml`:
 *
 *   mcp:
 *     paddock:
 *       url: https://paddock.example.invalid/mcp
 *       headers: { Authorization: env:MANAGERS_MCP_PADDOCK_WIDGET_LIB }   # "Bearer pdk_…"
 *       tools: [list_projects, list_chats, read_chat, create_chat, send_message]
 *       description: This project's Paddock deployment
 *
 * The declaration shape is the instance `mcpServers:` block's (`mcp-servers.ts`),
 * and so is the resolution — `resolveDeclaredMcpServers` does the parsing, the
 * `env:VAR` indirection and the never-print rule. What is different here:
 *
 *  - **An inline secret-ish value is a HARD ERROR** (the connection is dropped),
 *    not the instance block's warning. `project.yaml` is committed to the data
 *    repo on every UI save and is edited by hand; a credential typed into it is a
 *    mistake to refuse, not to advise about. "Secret-ish" is the same KEY name
 *    heuristic (`SECRET_ISH_KEY_RE`) for `headers`/`env`, plus a `url` carrying a
 *    query string or userinfo.
 *  - **Reserved names**: `managers`, `managers_files` (the injected servers) and
 *    `playwright` (the browser server, which would win silently).
 *  - **`tools:`** narrows the allowlist to exact `mcp__<name>__<tool>` patterns.
 *    Absent means `mcp__<name>__*`. `[]` is refused: it would attach a server
 *    whose every call is denied.
 *  - **Not cascaded.** A connection is a credential: the root's `mcp:` is Home's
 *    own and never reaches a project (plan §2.2).
 *
 * Every diagnostic names keys, variable names and server names only; a server is
 * rendered by `describeServer`, a url by `redactUrl`. Nothing here returns or
 * logs a resolved value except inside {@link ProjectMcpResolution.servers}, which
 * only the agent-config builders and the probe consume.
 *
 * PURE: it reads the record and the env it is given, never files.
 */
import {
  ENV_REF_PREFIX,
  SECRET_ISH_KEY_RE,
  describeServer,
  redactUrl,
  resolveDeclaredMcpServers,
} from "../mcp-servers.js";
import { mcpToolPattern, type McpServerDef, type McpServerDefs } from "../claude-mcp.js";

/** One `project.yaml` `mcp:` entry, as stored. */
export interface ProjectMcpConfig {
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tool names (not patterns) the manager may call. Absent ⇒ every tool. */
  tools?: string[];
  /** For the briefing and the Settings card. */
  description?: string;
}

/** Names a project connection may not take. */
export const PROJECT_MCP_RESERVED_NAMES: readonly string[] = ["managers", "managers_files", "playwright"];

/** A tool name as Claude Code namespaces it (`mcp__<server>__<tool>`). */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Keys this module owns on top of the declaration shape. */
const MANAGERS_KEYS = new Set(["tools", "description"]);

/** One `env:VAR` reference in a declaration, and whether the variable is set. */
export interface ConnectionEnvRef {
  /** The variable name (never its value). */
  name: string;
  /** Where it is referenced, e.g. `url`, `headers.Authorization`. */
  where: string;
  set: boolean;
}

/** One connection, resolved: what the agent gets, and a secret-free view for humans. */
export interface ProjectConnection {
  name: string;
  description: string | null;
  /** `http` | `sse` | `stdio`, when the declaration says enough to tell. */
  transport: "http" | "sse" | "stdio" | null;
  /**
   * The endpoint with query/userinfo stripped (`redactUrl`). For an `env:` url it
   * is the RESOLVED url, redacted, when the variable is set — else `env:VAR`.
   */
  url: string | null;
  /** A stdio server's executable basename. */
  command: string | null;
  /** Header NAMES only. */
  headerKeys: string[];
  envRefs: ConnectionEnvRef[];
  /** The `tools:` narrowing, or null for "every tool". */
  tools: string[] | null;
  /** The exact allowlist patterns the keeper gets (empty when not attached). */
  allow: string[];
  /** Whether the server is attached to the project's agents. */
  attached: boolean;
  /** Why it is not attached (any error drops it). */
  errors: string[];
  warnings: string[];
  /** The resolved server, for the agent config and the probe. NEVER serialise it. */
  server?: McpServerDef;
}

export interface ProjectMcpResolution {
  /** The attached servers, by name (resolved values — for herdctl only). */
  servers: McpServerDefs;
  /** Every attached connection's allowlist patterns. */
  toolPatterns: string[];
  connections: ProjectConnection[];
  /** Every connection's errors and warnings, prefixed, for the registration log. */
  errors: string[];
  warnings: string[];
}

export const EMPTY_PROJECT_MCP: ProjectMcpResolution = Object.freeze({
  servers: {},
  toolPatterns: [],
  connections: [],
  errors: [],
  warnings: [],
}) as ProjectMcpResolution;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The block as it round-trips through `project.yaml` (ProjectStore.normalize).
 *
 * Deliberately NOT validated here: an invalid entry must survive a UI save so its
 * error can be shown (validation is {@link resolveProjectMcp}'s job, at every
 * registration). Only a non-mapping block is dropped; entries are carried as the
 * plain data YAML produced.
 */
export function sanitizeProjectMcp(raw: unknown): Record<string, ProjectMcpConfig> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, ProjectMcpConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    out[name] = (isRecord(entry) ? structuredClone(entry) : entry) as ProjectMcpConfig;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every `env:VAR` string leaf of a declaration, with where it sits. */
function envRefsOf(raw: Record<string, unknown>, env: Record<string, string | undefined>): ConnectionEnvRef[] {
  const refs: ConnectionEnvRef[] = [];
  const visit = (value: unknown, where: string) => {
    if (typeof value !== "string" || !value.startsWith(ENV_REF_PREFIX)) return;
    const name = value.slice(ENV_REF_PREFIX.length).trim();
    if (!name) return;
    const v = env[name];
    refs.push({ name, where, set: v !== undefined && v.trim().length > 0 });
  };
  visit(raw.url, "url");
  visit(raw.command, "command");
  if (Array.isArray(raw.args)) raw.args.forEach((a, i) => visit(a, `args[${i}]`));
  for (const block of ["headers", "env"] as const) {
    const m = raw[block];
    if (isRecord(m)) for (const [k, v] of Object.entries(m)) visit(v, `${block}.${k}`);
  }
  return refs;
}

/** Inline credential-looking values: a hard error for a project connection. */
function inlineSecretErrors(where: string, raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const block of ["headers", "env"] as const) {
    const m = raw[block];
    if (!isRecord(m)) continue;
    for (const [key, value] of Object.entries(m)) {
      if (typeof value === "string" && !value.startsWith(ENV_REF_PREFIX) && SECRET_ISH_KEY_RE.test(key)) {
        errors.push(
          `${where}.${block}.${key}: looks like a credential written into project.yaml itself, which is committed ` +
            `to the data repo — write \`${key}: ${ENV_REF_PREFIX}MANAGERS_MCP_<CONN>_<PROJECT>\` and set the value ` +
            `in the server's environment. Not attached`,
        );
      }
    }
  }
  if (typeof raw.url === "string" && !raw.url.startsWith(ENV_REF_PREFIX)) {
    try {
      const u = new URL(raw.url.trim());
      if (u.search || u.username || u.password) {
        errors.push(
          `${where}.url: carries a query string or userinfo (where an API key usually rides) in project.yaml ` +
            `itself — use \`url: ${ENV_REF_PREFIX}VAR_NAME\`. Not attached`,
        );
      }
    } catch {
      /* unparseable: the transport will say so */
    }
  }
  return errors;
}

/** Resolve one connection. */
function resolveOne(name: string, raw: unknown, env: Record<string, string | undefined>): ProjectConnection {
  const where = `mcp.${name}`;
  const conn: ProjectConnection = {
    name,
    description: null,
    transport: null,
    url: null,
    command: null,
    headerKeys: [],
    envRefs: [],
    tools: null,
    allow: [],
    attached: false,
    errors: [],
    warnings: [],
  };
  if (PROJECT_MCP_RESERVED_NAMES.includes(name)) {
    conn.errors.push(
      `${where}: "${name}" is reserved for a server Managers attaches itself, and two servers cannot share the ` +
        `mcp__${name}__* namespace. Not attached`,
    );
    return conn;
  }
  if (!isRecord(raw)) {
    conn.errors.push(`${where}: is not a mapping. Not attached`);
    return conn;
  }

  // The secret-free view is filled in whatever happens next, so a dropped
  // connection still shows what it was meant to be.
  if (typeof raw.description === "string" && raw.description.trim()) conn.description = raw.description.trim();
  else if (raw.description !== undefined) conn.warnings.push(`${where}.description: must be a string (ignored)`);
  conn.envRefs = envRefsOf(raw, env);
  if (isRecord(raw.headers)) conn.headerKeys = Object.keys(raw.headers);
  if (typeof raw.command === "string" && raw.command.trim()) {
    conn.command = raw.command.startsWith(ENV_REF_PREFIX) ? raw.command.trim() : raw.command.trim().split(/[\\/]/).pop()!;
  }
  if (typeof raw.url === "string" && raw.url.trim()) {
    const u = raw.url.trim();
    if (u.startsWith(ENV_REF_PREFIX)) {
      const v = env[u.slice(ENV_REF_PREFIX.length).trim()];
      conn.url = v && v.trim() ? redactUrl(v.trim()) : u;
    } else conn.url = redactUrl(u);
  }
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
  conn.transport =
    type === "http" || type === "sse" || type === "stdio" ? type : conn.url ? "http" : conn.command ? "stdio" : null;

  // tools: narrowing.
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || !raw.tools.every((t) => typeof t === "string")) {
      conn.errors.push(`${where}.tools: must be a list of tool names. Not attached`);
    } else {
      const tools = [...new Set((raw.tools as string[]).map((t) => t.trim()).filter(Boolean))];
      const bad = tools.filter((t) => !TOOL_NAME_RE.test(t) || t.startsWith("mcp__"));
      if (bad.length > 0) {
        conn.errors.push(
          `${where}.tools: ${bad.join(", ")} ${bad.length === 1 ? "is not a tool name" : "are not tool names"} ` +
            `(write the bare name, e.g. list_chats — omit \`tools\` to allow every tool). Not attached`,
        );
      } else if (tools.length === 0) {
        conn.errors.push(`${where}.tools: is empty, which would allow nothing — omit it to allow every tool. Not attached`);
      } else conn.tools = tools;
    }
  }

  conn.errors.push(...inlineSecretErrors(where, raw));

  const decl: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!MANAGERS_KEYS.has(k)) decl[k] = v;
  const res = resolveDeclaredMcpServers({ [name]: decl }, env);
  const rename = (m: string) => m.replaceAll(`mcpServers.${name}`, where).replace(/ — (server )?not attached$/, ". Not attached");
  const server = res.servers[name];
  conn.errors.push(...res.errors.map(rename));
  // The instance block's "inline credential" advice is superseded by the hard
  // errors above; everything else it says is kept.
  const advisory = /looks like a credential|carries a query string or userinfo/;
  for (const w of res.warnings.map(rename).filter((m) => !advisory.test(m))) {
    // A dropped server (e.g. an unset env var) is an error for a connection.
    if (!server || /Not attached$/.test(w)) conn.errors.push(w);
    else conn.warnings.push(w);
  }
  if (!server || conn.errors.length > 0) return conn;

  conn.server = server;
  conn.attached = true;
  conn.allow = conn.tools ? conn.tools.map((t) => `mcp__${name}__${t}`) : [mcpToolPattern(name)];
  return conn;
}

/**
 * Resolve a workspace's `mcp:` block against `env` (the server's own
 * environment, normally `process.env`). Never throws; an unusable connection is
 * reported and dropped, the rest attach.
 */
export function resolveProjectMcp(
  project: { mcp?: Record<string, ProjectMcpConfig> | unknown },
  env: Record<string, string | undefined>,
): ProjectMcpResolution {
  const raw = project.mcp;
  if (raw === undefined || raw === null) return { ...EMPTY_PROJECT_MCP, connections: [] };
  if (!isRecord(raw)) {
    return { ...EMPTY_PROJECT_MCP, connections: [], errors: ["mcp: must be a mapping of connection name to declaration — ignored"] };
  }
  const out: ProjectMcpResolution = { servers: {}, toolPatterns: [], connections: [], errors: [], warnings: [] };
  for (const [rawName, decl] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    const name = rawName.trim();
    const conn = resolveOne(name, decl, env);
    out.connections.push(conn);
    out.errors.push(...conn.errors);
    out.warnings.push(...conn.warnings);
    if (conn.attached && conn.server) {
      out.servers[name] = conn.server;
      out.toolPatterns.push(...conn.allow);
    }
  }
  return out;
}

/** The connection a tool pattern / name refers to, if it is `mcp__<name>…`. */
function connectionOf(entry: string, names: string[]): { name: string; tool: string | null } | null {
  for (const name of names) {
    const base = `mcp__${name}`;
    if (entry === base || entry === `${base}__*`) return { name, tool: null };
    if (entry.startsWith(`${base}__`)) return { name, tool: entry.slice(base.length + 2) };
  }
  return null;
}

/**
 * A SCOPED trigger's view of the project's connections (its `run.tools` is its
 * whole capability, #647 aside). A connection is attached only when `run.tools`
 * names it — `mcp__<name>__*` / `mcp__<name>` (every tool the CONNECTION allows)
 * or `mcp__<name>__<tool>` (that tool, if the connection allows it). The
 * returned `allowedTools` is `run.tools` with those entries replaced by exactly
 * what the connection permits, so a trigger can never widen a connection's own
 * `tools:` narrowing. An empty `run.tools` (the unenforced "no tools" case)
 * attaches nothing.
 */
export function triggerConnections(
  runTools: readonly string[],
  mcp: ProjectMcpResolution,
): { servers: McpServerDefs; allowedTools: string[] } {
  const attached = mcp.connections.filter((c) => c.attached && c.server);
  const names = attached.map((c) => c.name).sort((a, b) => b.length - a.length);
  const servers: McpServerDefs = {};
  const allowed: string[] = [];
  for (const entry of runTools) {
    const ref = connectionOf(entry, names);
    if (!ref) {
      allowed.push(entry);
      continue;
    }
    const conn = attached.find((c) => c.name === ref.name)!;
    const grant =
      ref.tool === null || ref.tool === "*"
        ? conn.allow
        : conn.allow.includes(mcpToolPattern(conn.name)) || conn.allow.includes(`mcp__${conn.name}__${ref.tool}`)
          ? [`mcp__${conn.name}__${ref.tool}`]
          : [];
    if (grant.length === 0) continue;
    servers[conn.name] = conn.server!;
    allowed.push(...grant);
  }
  return { servers, allowedTools: [...new Set(allowed)] };
}

/** Log lines for a workspace's connections (registration log). Secret-free by construction. */
export function projectMcpNotices(slug: string, mcp: ProjectMcpResolution): { level: "info" | "warn" | "error"; message: string }[] {
  const label = slug === "" ? "Home" : slug;
  const out: { level: "info" | "warn" | "error"; message: string }[] = [];
  const attached = mcp.connections.filter((c) => c.attached && c.server);
  if (attached.length > 0) {
    out.push({
      level: "info",
      message: `${label}: MCP connections attached: ${attached.map((c) => describeServer(c.name, c.server!)).join("; ")}`,
    });
  }
  for (const e of mcp.errors) out.push({ level: "error", message: `${label}: ${e}` });
  for (const w of mcp.warnings) out.push({ level: "warn", message: `${label}: ${w}` });
  return out;
}

/** The briefing's Connections section body: names, descriptions and what may be called. */
export function connectionsBriefingBody(mcp: ProjectMcpResolution): string {
  if (mcp.connections.length === 0) return "(none configured)";
  const lines: string[] = [];
  for (const c of mcp.connections) {
    if (c.attached) {
      const tools = c.tools ? c.tools.map((t) => `mcp__${c.name}__${t}`).join(", ") : `mcp__${c.name}__* (every tool)`;
      lines.push(`- **${c.name}**${c.description ? ` — ${c.description}` : ""}. Tools: ${tools}.`);
    } else {
      lines.push(`- ${c.name}: NOT AVAILABLE this run (misconfigured — Ed can see why in Settings → Connections). Do not try to call it.`);
    }
  }
  lines.push("", "A tool of a behaviour that is OFF is denied even when its connection is listed here.");
  return lines.join("\n");
}

/**
 * A `mcp:` block made safe for an API response (the project DTO). `env:VAR`
 * references pass through (they are names, not values); any inline value under
 * `headers`/`env`/`args` becomes `<redacted>` and an inline url loses its query
 * and userinfo. `project.yaml` should never hold an inline secret — the resolver
 * refuses one — but the DTO must not echo it if it does.
 */
export function redactProjectMcp(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const keep = (v: unknown) => (typeof v === "string" && v.startsWith(ENV_REF_PREFIX) ? v : "<redacted>");
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      out[name] = "<redacted>";
      continue;
    }
    const e: Record<string, unknown> = { ...entry };
    for (const block of ["headers", "env"] as const) {
      if (isRecord(e[block])) e[block] = Object.fromEntries(Object.entries(e[block] as object).map(([k, v]) => [k, keep(v)]));
      else if (e[block] !== undefined) e[block] = "<redacted>";
    }
    if (Array.isArray(e.args)) e.args = e.args.map(keep);
    else if (e.args !== undefined) e.args = "<redacted>";
    if (typeof e.url === "string" && !e.url.startsWith(ENV_REF_PREFIX)) e.url = redactUrl(e.url);
    out[name] = e;
  }
  return out;
}

/** Redact `mcp` on every project-shaped object in a response payload (`project`, `projects[]`, `root`). */
export function redactMcpInPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const fix = (p: unknown) => (isRecord(p) && "mcp" in p ? { ...p, mcp: redactProjectMcp(p.mcp) } : p);
  let changed = false;
  const out: Record<string, unknown> = { ...payload };
  for (const key of ["project", "root"]) {
    if (isRecord(out[key]) && "mcp" in (out[key] as object)) {
      out[key] = fix(out[key]);
      changed = true;
    }
  }
  if (Array.isArray(out.projects) && out.projects.some((p) => isRecord(p) && "mcp" in p)) {
    out.projects = out.projects.map(fix);
    changed = true;
  }
  return changed ? out : payload;
}

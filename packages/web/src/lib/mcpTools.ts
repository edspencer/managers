// Prettify + parse Paddock's own injected MCP tools so they render as first-class
// UI instead of a raw `mcp__managers__create_chat` name over a JSON blob
// (issue #253). Pure/parse helpers live here (unit-testable); the React bodies
// live in components/PaddockManageBlock.tsx.
//
// Two levers, both derivable from data the web already has:
//   1. The tool NAME (`mcp__<server>__<tool>`) → a humanized label + provenance.
//   2. The tool OUTPUT (a JSON string the tool returns) → structured content,
//      parsed client-side exactly like send_file's `sentFileFromToolCall`.

/** Result of splitting an `mcp__<server>__<tool>` name into readable parts. */
export interface McpToolInfo {
  /** True when the name is an MCP tool (`mcp__…`). */
  isMcp: boolean;
  /** The MCP server segment, e.g. `managers` (empty for a non-mcp name). */
  server: string;
  /** True for one of this app's own servers (`managers` / `managers_files`). */
  isPaddock: boolean;
  /** Humanized tool label, e.g. `create_chat` → "Create chat". */
  display: string;
  /** The bare tool segment, e.g. `create_chat` (for keyed dispatch). */
  tool: string;
}

/** This app's own injected MCP servers. */
const MANAGERS_SERVERS = new Set(["managers", "managers_files"]);

/** `create_chat` → "Create chat"; leaves an already-spaced label alone. */
function humanize(segment: string): string {
  const spaced = segment.replace(/_/g, " ").trim();
  if (!spaced) return segment;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Split `mcp__<server>__<tool>` into a humanized label + provenance. Non-mcp
 * names pass through unchanged (`isMcp:false`, `display` = the raw name).
 */
export function mcpToolInfo(toolName: string): McpToolInfo {
  if (!toolName.startsWith("mcp__")) {
    return { isMcp: false, server: "", isPaddock: false, display: toolName, tool: toolName };
  }
  // The server segment is everything up to the next `__`; the tool is the rest
  // (a tool segment may itself contain single underscores, e.g. `create_chat`).
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const server = sep === -1 ? rest : rest.slice(0, sep);
  const tool = sep === -1 ? "" : rest.slice(sep + 2);
  return {
    isMcp: true,
    server,
    isPaddock: MANAGERS_SERVERS.has(server),
    display: humanize(tool || server),
    tool,
  };
}

// ── managers result shapes (mirror the server `ok(...)` payloads) ────────

export interface PmProject {
  slug: string;
  name: string;
  area?: string;
  status?: string;
}
export interface PmChat {
  project: string;
  sessionId: string;
  name: string;
  updatedAt?: string;
  running?: boolean;
}
export interface PmMessage {
  role: string;
  text: string;
  timestamp?: string;
}
export interface PmFork {
  sessionId: string;
  prompt: string;
}

/** Parsed, discriminated `managers` result (from the tool's JSON output). */
export type PaddockManage =
  | { tool: "list_projects"; count: number; projects: PmProject[] }
  | { tool: "list_chats"; count: number; project: string | null; chats: PmChat[] }
  | {
      tool: "read_chat";
      project: string;
      sessionId: string;
      total: number;
      returned: number;
      messages: PmMessage[];
    }
  | { tool: "create_chat"; project: string; sessionId: string; name?: string; prompt?: string }
  | {
      tool: "fork_chat";
      project: string;
      sessionId: string;
      from?: string;
      name?: string;
      prompt?: string;
    }
  | { tool: "send_message"; project: string; sessionId: string; prompt?: string }
  | { tool: "fork_chat_batch"; count: number; source: string; forks: PmFork[] }
  // ── Managers state tools (M5) ──
  | { tool: "record_episode"; project: string; id: string; file: string; importance: number; objective: string | null }
  | {
      tool: "upsert_task";
      project: string;
      id: string;
      file: string;
      status: string;
      created: boolean;
      movedFrom?: string;
    }
  | { tool: "update_objective"; project: string; id: string; file: string; status: string; created: boolean }
  | { tool: "write_report"; project: string; type: string; date: string; file: string; currentFile: string }
  | { tool: "record_artifact"; project: string; run: string; file: string; artifacts: number }
  | { tool: "list_tasks"; project: string; count: number; tasks: PmTask[] }
  | { tool: "list_objectives"; project: string; count: number; objectives: PmObjective[] }
  | { tool: "read_task"; project: string; task: PmTask }
  | { tool: "read_objective"; project: string; objective: PmObjective }
  | { tool: "list_memory"; project: string; facts: number; playbooks: number }
  | { tool: "list_alerts"; project: string; count: number; alerts: PmAlert[] }
  | { tool: "get_briefing"; project: string; objective: string | null; sections: PmBriefingSection[]; chars: number };

export interface PmBriefingSection {
  name: string;
  chars: number;
}

export interface PmAlert {
  id: string;
  kind: string;
  trigger: string;
  severity: string;
  message: string;
}

export interface PmTask {
  id: string;
  title: string;
  status: string;
  objective?: string | null;
  ask?: string | null;
  file?: string;
}
export interface PmObjective {
  id: string;
  title: string;
  status: string;
  file?: string;
}

const PM_PREFIX = "mcp__managers__";

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A non-empty trimmed string, or undefined (drops empty/missing fields). */
const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/** First non-blank line of a prompt, truncated — used for compact titles. */
export function firstLine(s: string, max = 80): string {
  const line = s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? s.trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/**
 * The human-readable chat title: the explicit `name` if given, else derived from
 * the kickoff `prompt` (matching Paddock's own sidebar auto-naming), else a
 * generic fallback.
 */
export function chatTitle(name?: string, prompt?: string): string {
  if (name) return name;
  if (prompt) return firstLine(prompt);
  return "untitled chat";
}

/**
 * Parse a `mcp__managers__*` tool call's JSON `output` into a typed shape,
 * or null when the name isn't ours / the output isn't a valid payload (caller
 * falls back to the generic tool body). Mirrors `sentFileFromToolCall`.
 */
export function parsePaddockManage(
  toolName: string,
  output: string | undefined,
): PaddockManage | null {
  if (!toolName.startsWith(PM_PREFIX) || !output) return null;
  const tool = toolName.slice(PM_PREFIX.length);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  switch (tool) {
    case "list_projects": {
      if (!Array.isArray(data.projects)) return null;
      const projects = data.projects as PmProject[];
      return { tool, count: num(data.count, projects.length), projects };
    }
    case "list_chats": {
      if (!Array.isArray(data.chats)) return null;
      const chats = data.chats as PmChat[];
      return {
        tool,
        count: num(data.count, chats.length),
        project: (data.project as string) ?? null,
        chats,
      };
    }
    case "read_chat": {
      if (!Array.isArray(data.messages)) return null;
      const messages = data.messages as PmMessage[];
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId ?? ""),
        total: num(data.total, messages.length),
        returned: num(data.returned, messages.length),
        messages,
      };
    }
    case "create_chat": {
      if (!data.sessionId) return null;
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId),
        name: str(data.name),
        prompt: str(data.prompt),
      };
    }
    case "send_message": {
      if (!data.sessionId) return null;
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId),
        prompt: str(data.prompt),
      };
    }
    case "fork_chat": {
      if (!data.sessionId) return null;
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId),
        from: str(data.from),
        name: str(data.name),
        prompt: str(data.prompt),
      };
    }
    case "fork_chat_batch": {
      if (!Array.isArray(data.forks)) return null;
      const forks = data.forks as PmFork[];
      return { tool, count: num(data.count, forks.length), source: String(data.source ?? ""), forks };
    }
    // ── Managers state tools (M5) ──
    case "record_episode": {
      if (typeof data.id !== "string") return null;
      return {
        tool,
        project: String(data.project ?? ""),
        id: data.id,
        file: String(data.file ?? ""),
        importance: num(data.importance, 0),
        objective: str(data.objective) ?? null,
      };
    }
    case "upsert_task": {
      if (typeof data.id !== "string" || typeof data.status !== "string") return null;
      return {
        tool,
        project: String(data.project ?? ""),
        id: data.id,
        file: String(data.file ?? ""),
        status: data.status,
        created: data.created === true,
        movedFrom: str(data.movedFrom),
      };
    }
    case "update_objective": {
      if (typeof data.id !== "string") return null;
      return {
        tool,
        project: String(data.project ?? ""),
        id: data.id,
        file: String(data.file ?? ""),
        status: String(data.status ?? ""),
        created: data.created === true,
      };
    }
    case "write_report": {
      if (typeof data.type !== "string") return null;
      return {
        tool,
        project: String(data.project ?? ""),
        type: data.type,
        date: String(data.date ?? ""),
        file: String(data.file ?? ""),
        currentFile: String(data.currentFile ?? ""),
      };
    }
    case "record_artifact": {
      if (typeof data.run !== "string") return null;
      return {
        tool,
        project: String(data.project ?? ""),
        run: data.run,
        file: String(data.file ?? ""),
        artifacts: num(data.artifacts, 0),
      };
    }
    case "list_tasks": {
      if (!Array.isArray(data.tasks)) return null;
      const tasks = data.tasks as PmTask[];
      return { tool, project: String(data.project ?? ""), count: num(data.count, tasks.length), tasks };
    }
    case "list_objectives": {
      if (!Array.isArray(data.objectives)) return null;
      const objectives = data.objectives as PmObjective[];
      return {
        tool,
        project: String(data.project ?? ""),
        count: num(data.count, objectives.length),
        objectives,
      };
    }
    case "read_task": {
      const t = data.task as PmTask | undefined;
      if (!t || typeof t.id !== "string") return null;
      return { tool, project: String(data.project ?? ""), task: t };
    }
    case "read_objective": {
      const o = data.objective as PmObjective | undefined;
      if (!o || typeof o.id !== "string") return null;
      return { tool, project: String(data.project ?? ""), objective: o };
    }
    case "list_memory": {
      if (!Array.isArray(data.facts)) return null;
      return {
        tool,
        project: String(data.project ?? ""),
        facts: data.facts.length,
        playbooks: Array.isArray(data.playbooks) ? data.playbooks.length : 0,
      };
    }
    case "list_alerts": {
      if (!Array.isArray(data.alerts)) return null;
      const alerts = data.alerts as PmAlert[];
      return { tool, project: String(data.project ?? ""), count: num(data.count, alerts.length), alerts };
    }
    case "get_briefing": {
      if (!Array.isArray(data.sections)) return null;
      const sections = (data.sections as PmBriefingSection[]).map((s) => ({ name: String(s.name), chars: num(s.chars, 0) }));
      return {
        tool,
        project: String(data.project ?? ""),
        objective: str(data.objective) ?? null,
        sections,
        chars: typeof data.text === "string" ? data.text.length : sections.reduce((n, s) => n + s.chars, 0),
      };
    }
    default:
      return null;
  }
}

/** A one-line header subtitle for a parsed managers result. */
export function paddockManageSummary(pm: PaddockManage): string {
  switch (pm.tool) {
    case "list_projects":
      return `${pm.count} ${pm.count === 1 ? "project" : "projects"}`;
    case "list_chats":
      return (
        `${pm.count} ${pm.count === 1 ? "chat" : "chats"}` +
        (pm.project ? ` in ${pm.project}` : " across all projects")
      );
    case "read_chat":
      return `${pm.project} · ${pm.returned}/${pm.total} messages`;
    case "create_chat":
    case "fork_chat":
      // The chat's real name (or a title derived from its kickoff prompt).
      return chatTitle(pm.name, pm.prompt);
    case "send_message":
      // A preview of the actual message that was sent.
      return pm.prompt ? firstLine(pm.prompt) : `message to ${pm.project}`;
    case "fork_chat_batch":
      return `fanned out ${pm.count} ${pm.count === 1 ? "chat" : "chats"}`;
    case "record_episode":
      return `Recorded episode ${pm.id} (imp ${pm.importance})`;
    case "upsert_task":
      return pm.created ? `Task ${pm.id} created → ${pm.status}` : `Task ${pm.id} → ${pm.status}`;
    case "update_objective":
      return pm.created ? `Objective ${pm.id} created` : `Objective ${pm.id} updated`;
    case "write_report":
      return `${pm.type} report for ${pm.date}`;
    case "record_artifact":
      return `Artifact recorded on ${pm.run}`;
    case "list_tasks":
      return `${pm.count} ${pm.count === 1 ? "task" : "tasks"}`;
    case "list_objectives":
      return `${pm.count} ${pm.count === 1 ? "objective" : "objectives"}`;
    case "read_task":
      return `${pm.task.id} · ${pm.task.status}`;
    case "read_objective":
      return `${pm.objective.id} · ${pm.objective.status}`;
    case "list_memory":
      return `${pm.facts} ${pm.facts === 1 ? "fact" : "facts"}, ${pm.playbooks} ${pm.playbooks === 1 ? "playbook" : "playbooks"}`;
    case "list_alerts":
      return pm.count === 0 ? "No alerts" : `${pm.count} ${pm.count === 1 ? "alert" : "alerts"}`;
    case "get_briefing":
      return `${pm.sections.length} sections · ${pm.chars.toLocaleString("en-US")} chars${pm.objective ? ` · ${pm.objective}` : ""}`;
  }
}

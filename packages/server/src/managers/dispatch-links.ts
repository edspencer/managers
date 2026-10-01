/**
 * dispatch-links — the web link for a task's `dispatched` entry.
 *
 * An entry says the task's work went through MCP connection `connection` to chat
 * `chat` in that system's project `project`. Managers dispatches to Paddock, whose
 * MCP endpoint is `<base>/mcp` and whose chat page is
 * `<base>/projects/<project>/chat/<chat>`; so the link is derived from the
 * connection's (redacted) url. No link when the connection is unknown, has no
 * http(s) url, or its url was redacted (a credential in the path or query) —
 * the UI then shows the entry as plain text.
 */
import type { ProjectConnection } from "./project-mcp.js";

/** The Paddock chat URL for one dispatch, or `null` when none can be derived. */
export function dispatchChatHref(
  connectionUrl: string | null | undefined,
  project: string | null | undefined,
  chat: string | null | undefined,
): string | null {
  if (!connectionUrl || !project || !chat) return null;
  if (connectionUrl.includes("<redacted>")) return null;
  let u: URL;
  try {
    u = new URL(connectionUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search) return null;
  const base = u.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${u.origin}${base}/projects/${encodeURIComponent(project)}/chat/${encodeURIComponent(chat)}`;
}

/** A task's `dispatched` list with each entry's `href` (see `dispatchChatHref`). */
export function withDispatchLinks<T extends { connection?: string | null; project?: string | null; chat?: string | null }>(
  entries: readonly T[],
  connections: readonly Pick<ProjectConnection, "name" | "url">[],
): (T & { href: string | null })[] {
  const urlOf = new Map(connections.map((c) => [c.name, c.url]));
  return entries.map((d) => ({
    ...d,
    href: d.connection ? dispatchChatHref(urlOf.get(d.connection), d.project, d.chat) : null,
  }));
}

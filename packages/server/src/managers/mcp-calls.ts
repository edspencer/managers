/**
 * mcp-calls — the run record's `mcpCalls` tally (M6).
 */

/**
 * Count one tool call against its MCP server (Managers M6 `mcpCalls`). Only
 * `mcp__<server>__<tool>` names count, and Managers' own injected servers
 * (`managers`, `managers_files`) are excluded: the run record is about the
 * outside systems a manager touched.
 */
export function countMcpCall(into: Record<string, Record<string, number>>, toolName: string): void {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return;
  const [, server, tool] = m as unknown as [string, string, string];
  if (server === "managers" || server.startsWith("managers_")) return;
  const per = (into[server] ??= {});
  per[tool] = (per[tool] ?? 0) + 1;
}

/**
 * mcp-secret-env — keep MCP credentials out of every child's environment (M9.5).
 *
 * M9 left a gap: a project connection's token lives in the server's environment
 * (`MANAGERS_MCP_<CONN>_<PROJECT>`, referenced as `env:VAR` from `project.yaml`),
 * and herdctl hands that environment to EVERY `claude` child. The CLI runtime
 * spawns with execa's default `extendEnv: true`; the SDK runtime passes
 * `sdkOptions.env ?? process.env`; neither takes a per-agent environment
 * (herdctl 5.33's agent schema has `env` only under `docker:`). So project A's
 * Bash could `env | grep MANAGERS_MCP_` and read project B's token.
 *
 * herdctl cannot filter it per agent, so Managers removes it at the source: at
 * boot, right after the `PADDOCK_*` scrub, every `MANAGERS_MCP_*` variable is
 * MOVED out of `process.env` into this module's private map. Every resolver that
 * needs one — project connections, the instance `mcpServers:` block, the
 * external `/mcp` client tokens (`MANAGERS_MCP_TOKEN_*`) — reads
 * {@link mcpResolveEnv}, the merged view. A token therefore reaches a child only
 * inside the MCP config Managers builds for that child's own project (the
 * `--mcp-config` / SDK `mcpServers` headers), never through its environment.
 *
 * Limits, stated in the M9.5 report: an `env:` reference to a variable OUTSIDE
 * this prefix is not moved (it may be something else's, e.g. `GITHUB_TOKEN`) and
 * stays visible to every child — `projectMcpNotices` warns about it. Under
 * `driveMode: batch` the resolved header still rides in the child's argv (the
 * known `argvExposure` issue), readable by the same user from `/proc`.
 */

/** Variables with this prefix are credentials for MCP and are never inherited by a child. */
export const MCP_SECRET_ENV_PREFIX = "MANAGERS_MCP_";

const vault = new Map<string, string>();

/**
 * Move every `MANAGERS_MCP_*` variable from `env` (default `process.env`) into
 * the private map. Returns how many were moved. Idempotent; a later value for
 * the same name (a test re-setting it) replaces the stored one.
 */
export function sequesterMcpSecrets(env: NodeJS.ProcessEnv = process.env): number {
  let moved = 0;
  for (const key of Object.keys(env)) {
    if (!key.startsWith(MCP_SECRET_ENV_PREFIX)) continue;
    const v = env[key];
    if (typeof v === "string") vault.set(key, v);
    delete env[key];
    moved++;
  }
  return moved;
}

/** The environment MCP resolvers read: `process.env` plus the sequestered secrets. */
export function mcpResolveEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of vault) if (out[k] === undefined) out[k] = v;
  return out;
}

/** Whether `name` is a sequestered-prefix variable (for notices). */
export function isSequesteredName(name: string): boolean {
  return name.startsWith(MCP_SECRET_ENV_PREFIX);
}

/** Forget every sequestered value (tests). */
export function resetSequesteredMcpSecrets(): void {
  vault.clear();
}

/** The one log line. A count only, never a name or value. */
export function describeSequester(count: number): string {
  return `mcp-secrets: moved ${count} ${MCP_SECRET_ENV_PREFIX}* variable${count === 1 ? "" : "s"} out of the environment children inherit`;
}

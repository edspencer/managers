/**
 * Process lifecycle for a Managers server: bind the port and wire signal-driven
 * shutdown. Split out of `index.ts` so the `managers` CLI (src/cli/managers.ts)
 * and the plain `node dist/index.js` entrypoint share one implementation.
 *
 * Config is resolved INSIDE `buildApp()`, not at module load, so a caller may
 * still mutate `process.env` right up until this function is invoked. The CLI
 * depends on that to apply its own defaults (e.g. a data dir under $HOME).
 */
import { buildApp } from "./app.js";
import { describeScrub, scrubInheritedEnv } from "./env-scrub.js";
import { applyRuntimeEnv } from "./managers/claude-overlay.js";
import { describeSequester, sequesterMcpSecrets } from "./managers/mcp-secret-env.js";

export interface StartOptions {
  /**
   * Allow `MANAGERS_AUTH_MODE=none` without `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH`
   * when, and only when, the resolved bind host is loopback. Set by the
   * `managers` CLI (laptop first run); see boot-posture.ts. Never an env var, so
   * no child process can inherit it.
   */
  loopbackNoAuth?: boolean;
}

export async function start(opts: StartOptions = {}): Promise<void> {
  // FIRST, before any config is resolved or any child can be spawned: drop every
  // inherited `PADDOCK_*` variable so none of them reaches a keeper, sweeper or
  // trigger subprocess (see env-scrub.ts). Only the count is logged.
  const scrubbed = scrubInheritedEnv();
  // Managers M9.5: MCP credentials (`MANAGERS_MCP_*`) leave process.env too, so
  // no keeper/trigger/sweeper child inherits another project's token; the MCP
  // resolvers read them from the private map (managers/mcp-secret-env.ts).
  const sequestered = sequesterMcpSecrets();
  // Managers M3: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, process-wide, so every
  // keeper/trigger/sweeper child inherits it (belt-and-braces with the
  // `autoMemoryEnabled: false` in the generated settings.json).
  applyRuntimeEnv();
  const { app, cfg, close } = await buildApp({ loopbackNoAuth: opts.loopbackNoAuth === true });
  // warn, not info, when anything was removed: it means this process was started
  // from a shell configured for Paddock, which is worth seeing even at LOG_LEVEL=warn.
  if (scrubbed > 0) app.log.warn({ scrubbedEnvVars: scrubbed }, describeScrub(scrubbed));
  else app.log.info({ scrubbedEnvVars: 0 }, describeScrub(0));
  app.log.info({ sequesteredMcpVars: sequestered }, describeSequester(sequestered));

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`managers-server listening on http://${cfg.host}:${cfg.port}`);
}

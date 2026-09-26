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

export async function start(): Promise<void> {
  // FIRST, before any config is resolved or any child can be spawned: drop every
  // inherited `PADDOCK_*` variable so none of them reaches a keeper, sweeper or
  // trigger subprocess (see env-scrub.ts). Only the count is logged.
  const scrubbed = scrubInheritedEnv();
  const { app, cfg, close } = await buildApp();
  // warn, not info, when anything was removed: it means this process was started
  // from a shell configured for Paddock, which is worth seeing even at LOG_LEVEL=warn.
  if (scrubbed > 0) app.log.warn({ scrubbedEnvVars: scrubbed }, describeScrub(scrubbed));
  else app.log.info({ scrubbedEnvVars: 0 }, describeScrub(0));

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`managers-server listening on http://${cfg.host}:${cfg.port}`);
}

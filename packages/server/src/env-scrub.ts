/**
 * Boot-time scrub of inherited Paddock configuration (Managers M1).
 *
 * Managers is a fork of Paddock and is expected to run on machines that ALSO
 * run Paddock, whose shells export dozens of `PADDOCK_*` variables. Managers
 * reads none of them (every variable was renamed to `MANAGERS_*`), but a
 * variable that is merely present still leaks into every child process — the
 * keeper's Bash, the sweeper's `claude -p`, a trigger turn — and a Paddock
 * build running inside one of those children WOULD read it:
 * `PADDOCK_DATA_DIR` names Paddock's production data, `PADDOCK_AUTH_MODE=jwt`
 * 401s every request, `PADDOCK_MCP_TOKEN_*` is a live bearer token.
 *
 * So the server deletes every `PADDOCK_*` key from `process.env` before
 * anything else runs, and children inherit a clean environment. Only the COUNT
 * is ever reported: the names alone can identify a deployment, and a value may
 * be a secret.
 *
 * This file is the one place in `packages/*\/src` allowed to spell the old
 * prefix (enforced by `test/unit/no-paddock-env.test.ts`).
 */

/** The inherited prefix this scrub removes. */
export const INHERITED_ENV_PREFIX = "PADDOCK_";

/**
 * Delete every `PADDOCK_*` key from `env` (default `process.env`), in place.
 * Returns how many were removed. Idempotent.
 */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv = process.env): number {
  let removed = 0;
  for (const key of Object.keys(env)) {
    if (key.startsWith(INHERITED_ENV_PREFIX)) {
      delete env[key];
      removed++;
    }
  }
  return removed;
}

/** The one log line the scrub produces. Carries the count only, never a name. */
export function describeScrub(count: number): string {
  return `env-scrub: removed ${count} inherited ${INHERITED_ENV_PREFIX}* variable${count === 1 ? "" : "s"} from the environment`;
}

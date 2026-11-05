/**
 * Managers' bindings for the generic updater (`cli/update/`): the package name,
 * the service hooks, the busy guard and the health probe
 * (CLI contract SPEC §1, §5, §6).
 *
 * Kept separate from `cli/update/*` for the same reason `busy-command.ts` is
 * kept separate from `cli/busy.ts`: those files are the ones wave C4 lifts into
 * `reference/`, and everything Managers-specific lives on this side of the seam.
 * Three things are genuinely Managers' own, and they are the hooks:
 *
 * - **the package name and layout.** `@edspencer/managers` is SYNTHESIZED from
 *   two private workspaces (`scripts/make-npm-package.mjs`), so the published
 *   tarball's root manifest carries that name and the CLI sits at
 *   `packages/server/dist/cli/managers.js` under it. In the repo, nothing is
 *   called `@edspencer/managers` at all — which is exactly why §6's walk-up
 *   reports a checkout there, correctly.
 * - **the busy check**, including the keeper-chat trap: a Managers chat that
 *   runs `managers update` is itself one of the turns the answer counts.
 * - **the service**, through `cli/service/index.ts`, so the unit is read by the
 *   code that writes it.
 */
import path from "node:path";
import { createOutput } from "./output.js";
import { EXIT } from "./exit-codes.js";
import { UPDATE_SYNOPSIS, type CliOptions } from "./args.js";
import { guardBusy } from "./busy.js";
import { MANAGERS_NOUNS, managersBusyHint } from "./busy-command.js";
import { MANAGERS_NAME, MANAGERS_VERSION } from "../version.js";
import { updateServiceHooks, type ServiceContext } from "./service/index.js";
import { runUpdate, type UpdateProduct } from "./update/update.js";

/** The published package. Used for the registry, the install detection and the install command. */
export const MANAGERS_PACKAGE = "@edspencer/managers";

/** Where the CLI sits inside that package. See the layout note in make-npm-package.mjs. */
export const MANAGERS_BIN_SUBPATH = path.join("packages", "server", "dist", "cli", "managers.js");

/** The image an `update` inside a container tells you to pull (SPEC §6, §9). */
export const MANAGERS_IMAGE = "ghcr.io/edspencer/managers";

/** Release notes for a version — the `Changes:` line of SPEC §3's notice. */
export function managersChangelogUrl(version: string): string {
  return `https://github.com/edspencer/managers/releases/tag/v${version}`;
}

/**
 * `managers update [--check] [--to <version|tag>] [--yes] [--force] [--json]`
 * (SPEC §1, §5). `upgrade` reaches the same place.
 *
 * `ctx` is the same {@link ServiceContext} `managers service` is handed, so the
 * two agree about which Node, which script and which unit — an `update` that
 * refreshed a different unit from the one `status` reports would be the worst
 * possible kind of nearly-working.
 */
export async function runUpdateCommand(opts: CliOptions, ctx: ServiceContext): Promise<number> {
  const out = createOutput({ tool: "managers", json: opts.json === true });

  // The service layer decides the home, because the home has to be the one
  // `service status` reads the update cache from: the UNIT's data dir when
  // there is a unit, and this invocation's otherwise (#824's rule).
  let service: ReturnType<typeof updateServiceHooks>;
  try {
    service = updateServiceHooks(ctx);
  } catch (err) {
    // An unsupported platform — `backendFor` throws for anything but darwin and
    // linux. `update` still has work it could do there in principle, but it
    // cannot refresh a unit, and pretending otherwise is how a Windows user
    // gets a half-finished update. Report it as the failure it is.
    return out.error(err instanceof Error ? err.message : String(err));
  }

  const product: UpdateProduct = {
    name: MANAGERS_NAME,
    tool: "managers",
    packageName: MANAGERS_PACKAGE,
    envPrefix: "MANAGERS",
    home: service.home,
    currentVersion: MANAGERS_VERSION,
    // NOT realpath'd: `findCli` re-resolves this symlink after the install,
    // which is how it finds the new CLI under a package manager that puts the
    // version in the package's real path. SPEC §6's walk-up realpaths it
    // itself.
    entry: process.argv[1] ?? ctx.scriptPath,
    binSubpath: MANAGERS_BIN_SUBPATH,
    image: MANAGERS_IMAGE,
    usage: UPDATE_SYNOPSIS,
    changelogUrl: managersChangelogUrl,
    guardBusy: async ({ force, home }) => {
      const refusal = await guardBusy({
        home,
        out,
        name: MANAGERS_NAME,
        nouns: MANAGERS_NOUNS,
        hint: managersBusyHint,
        ...(force ? { force: true } : {}),
      });
      if (refusal === null) return null;
      // The way past it, spelled out — the same shape `service stop` prints.
      out.warn("\n    managers update --force      update it anyway\n");
      return EXIT.BUSY;
    },
    service: service.hooks,
    // No `waitForVersion`: the reference's own (update/health.ts) polls `/api/health` for the target version.
  };

  // `CliOptions` spells `--check` as `checkOnly`, because `check` reads as a
  // verb in a bag of flags that also carries `write` and `follow`. Mapped here
  // rather than renamed in the generic module, which is the one the other five
  // tools copy.
  return runUpdate(
    product,
    {
      ...(opts.checkOnly === true ? { check: true } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.yes === true ? { yes: true } : {}),
      ...(opts.force === true ? { force: true } : {}),
      ...(opts.json === true ? { json: true } : {}),
    },
    { out },
  );
}

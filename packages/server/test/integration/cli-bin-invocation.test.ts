/**
 * Regression test: the `managers` bin must run when invoked through a SYMLINK.
 *
 * npm installs a `bin` as a symlink at `node_modules/.bin/<name>`. A previous
 * version guarded `main()` with
 * `pathToFileURL(process.argv[1]).href === import.meta.url`, which is false
 * through a symlink because argv[1] is the link path and `import.meta.url` is
 * the realpath. The published CLI printed nothing and exited 0 in 0.57.0,
 * 0.58.0 and 0.59.0.
 *
 * Every manual check at the time used `node <file>` directly — the one
 * invocation where that guard holds — so nothing caught it. This test spawns
 * the entrypoint through a symlink specifically, which is the shape that broke.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../../src/cli/managers.ts");
// npm hoists tsx to the workspace root or keeps it under packages/server,
// depending on the rest of the tree, so take whichever exists.
const tsx = ["../../node_modules/.bin/tsx", "../../../../node_modules/.bin/tsx"]
  .map((p) => path.resolve(here, p))
  .find((p) => existsSync(p)) as string;

let tmp: string;
let link: string;

beforeAll(async () => {
  tmp = await makeTmpDir();
  link = path.join(tmp, "paddock-link.ts");
  await fs.symlink(entry, link);
});
afterAll(async () => {
  await rmTmpDir(tmp);
});

describe("managers bin invocation (#638 regression)", () => {
  it("prints its version when run through a symlink", async () => {
    const { stdout } = await run(tsx, [link, "--version"], { timeout: 60_000 });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 70_000);

  it("prints usage when run through a symlink", async () => {
    const { stdout } = await run(tsx, [link, "--help"], { timeout: 60_000 });
    expect(stdout).toContain("managers — run a Managers instance locally");
    expect(stdout).toContain("--data-dir");
    // #798: the usage text must not advertise a flag `parseArgs` now rejects.
    expect(stdout).not.toContain("--here");
  }, 70_000);

  /**
   * Exit 2, not 1 (cli-contract SPEC §2) — and asserted on the REAL process.
   *
   * `UsageError.exitCode` is unit-tested, but the thing that can silently
   * regress is the wiring: `main` returning a code, `process.exitCode` being
   * assigned rather than `process.exit()` called, and nothing between the two
   * overwriting it. Only spawning the entrypoint can see that.
   */
  it("exits 2 on a bad flag, and prints the usage after the message", async () => {
    await expect(
      run(tsx, [link, "--definitely-not-a-flag"], { timeout: 60_000 }),
    ).rejects.toMatchObject({ code: 2 });

    const err = await run(tsx, [link, "--definitely-not-a-flag"], { timeout: 60_000 }).catch(
      (e: { stdout: string; stderr: string }) => e,
    );
    expect(err.stderr).toContain("managers: unknown option: --definitely-not-a-flag");
    expect(err.stderr).toContain("Usage");
    // Errors on stderr, so stdout stays available for a --json document.
    expect(err.stdout).toBe("");
  }, 140_000);

  it("exits 2 on an unknown service action and on a bad value", async () => {
    for (const argv of [
      ["service", "instal"],
      ["service"],
      ["--port", "nonsense"],
      ["service", "logs", "-n", "0"],
    ]) {
      await expect(run(tsx, [link, ...argv], { timeout: 60_000 })).rejects.toMatchObject({
        code: 2,
      });
    }
  }, 300_000);

  /**
   * Exit 4 from the four commands that need a unit, against a throwaway HOME.
   *
   * `XDG_CONFIG_HOME` is pointed at a temp directory as well as `HOME`: the
   * systemd backend honours it when no home is injected, and without it this
   * test would look at the box's real `~/.config/systemd/user` — which on a
   * machine that runs Managers as a service would make the assertion pass or
   * fail depending on whose machine it is. These commands only READ, but the
   * answer has to be about the temp directory.
   */
  it("exits 4 when no service is installed", async () => {
    const empty = path.join(tmp, "empty-home");
    await fs.mkdir(empty, { recursive: true });
    const env = {
      ...process.env,
      HOME: empty,
      XDG_CONFIG_HOME: path.join(empty, ".config"),
      MANAGERS_DATA_DIR: path.join(empty, ".managers"),
    };
    for (const action of ["status", "logs", "start", "stop"]) {
      await expect(
        run(tsx, [link, "service", action], { timeout: 60_000, env }),
      ).rejects.toMatchObject({ code: 4 });
    }
    // …and `status --json` still answers, because a script needs the document
    // whatever the code (SPEC §1).
    const json = await run(tsx, [link, "service", "status", "--json"], {
      timeout: 60_000,
      env,
    }).catch((e: { stdout: string }) => e);
    expect(JSON.parse(json.stdout)).toMatchObject({ installed: false });
  }, 300_000);
});

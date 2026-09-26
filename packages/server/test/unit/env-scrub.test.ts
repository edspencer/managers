/**
 * Managers M1: the boot scrub removes every inherited `PADDOCK_*` variable, and
 * an inherited `PADDOCK_DATA_DIR` (or `PADDOCK_AUTH_MODE`) has no effect on the
 * resolved config either way — before the scrub because nothing reads the old
 * prefix, after it because the variable is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { loadPaddockConfig } from "../../src/config.js";
import { describeScrub, scrubInheritedEnv } from "../../src/env-scrub.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const TOUCHED = ["MANAGERS_DATA_DIR", "PADDOCK_DATA_DIR", "PADDOCK_AUTH_MODE", "PADDOCK_MCP_TOKEN_X"];

describe("env-scrub", () => {
  let dataDir: string;
  let decoy: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("managers-scrub-");
    decoy = await makeTmpDir("managers-scrub-decoy-");
    saved = {};
    for (const k of TOUCHED) saved[k] = process.env[k];
  });
  afterEach(async () => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
    await rmTmpDir(decoy);
  });

  it("removes every PADDOCK_* key and nothing else, returning the count", () => {
    const env: NodeJS.ProcessEnv = {
      PADDOCK_DATA_DIR: "/somewhere",
      PADDOCK_AUTH_MODE: "jwt",
      PADDOCK_MCP_TOKEN_LAPTOP: "secret",
      MANAGERS_DATA_DIR: "/mine",
      HOME: "/home/x",
      NOT_PADDOCK_X: "kept",
    };
    expect(scrubInheritedEnv(env)).toBe(3);
    expect(Object.keys(env).sort()).toEqual(["HOME", "MANAGERS_DATA_DIR", "NOT_PADDOCK_X"]);
    expect(scrubInheritedEnv(env)).toBe(0);
  });

  it("logs the count only, never a name or value", () => {
    const line = describeScrub(3);
    expect(line).toContain("3");
    expect(line).not.toMatch(/DATA_DIR|AUTH_MODE|secret/);
    expect(describeScrub(1)).toMatch(/1 inherited PADDOCK_\* variable from/);
  });

  it("an inherited PADDOCK_DATA_DIR does not affect loadPaddockConfig()", () => {
    process.env.MANAGERS_DATA_DIR = dataDir;
    process.env.PADDOCK_DATA_DIR = decoy;
    process.env.PADDOCK_AUTH_MODE = "jwt";
    const before = loadPaddockConfig();
    expect(before.dataDir).not.toBe(path.resolve(decoy));
    expect(before.projectsRoot.startsWith(before.dataDir)).toBe(true);
    expect(before.auth.mode).toBe("none");

    scrubInheritedEnv();
    expect(process.env.PADDOCK_DATA_DIR).toBeUndefined();
    const after = loadPaddockConfig();
    expect(after.dataDir).toBe(before.dataDir);
    expect(after.auth.mode).toBe("none");
  });

  it("the scrub reaches process.env, so spawned children inherit none of it", () => {
    process.env.PADDOCK_MCP_TOKEN_X = "Bearer pdk_x";
    scrubInheritedEnv();
    expect(Object.keys(process.env).filter((k) => k.startsWith("PADDOCK_"))).toEqual([]);
  });
});

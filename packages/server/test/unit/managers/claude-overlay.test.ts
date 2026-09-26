/**
 * Managers M3: the retention / auto-memory overlay and the generated
 * `settings.json` it lands in. See `src/managers/claude-overlay.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MANAGERS_SETTINGS_OVERLAY,
  MANAGERS_CLEANUP_PERIOD_DAYS,
  DISABLE_AUTO_MEMORY_VAR,
  applyRuntimeEnv,
  planManagedSettings,
  overlayViolations,
  findRetentionOverrides,
  describeRetentionOverrides,
} from "../../../src/managers/claude-overlay.js";
import { ensureClaudeHome } from "../../../src/claude-home.js";
import { SETTINGS_ENTRY } from "../../../src/claude-settings.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

const OVERLAY = { cleanupPeriodDays: 36500, autoMemoryEnabled: false, autoDreamEnabled: false };

describe("MANAGERS_SETTINGS_OVERLAY", () => {
  it("is ~100 years, never 0 (0 is a Claude Code validation error), and switches memory off", () => {
    expect(MANAGERS_SETTINGS_OVERLAY).toEqual(OVERLAY);
    expect(MANAGERS_CLEANUP_PERIOD_DAYS).toBeGreaterThanOrEqual(36500);
    expect(Object.isFrozen(MANAGERS_SETTINGS_OVERLAY)).toBe(true);
  });
});

describe("planManagedSettings", () => {
  it("no host file → the overlay alone", () => {
    const plan = planManagedSettings("own", null);
    expect(JSON.parse(plan.content)).toEqual(OVERLAY);
    expect(plan.dropped).toEqual([]);
    expect(plan.hostUnusable).toBeUndefined();
  });

  it("filtered host (hooks: own) → host keys minus hooks, plus the overlay", () => {
    const raw = JSON.stringify({ model: "opus", hooks: { PreToolUse: [] }, permissions: { allow: ["Read"] } });
    const plan = planManagedSettings("own", raw);
    expect(JSON.parse(plan.content)).toEqual({
      model: "opus",
      permissions: { allow: ["Read"] },
      ...OVERLAY,
    });
    expect(plan.dropped).toEqual(["hooks"]);
  });

  it("hooks: host keeps the hooks, and still adds the overlay", () => {
    const raw = JSON.stringify({ hooks: { Stop: [] } });
    const parsed = JSON.parse(planManagedSettings("host", raw).content);
    expect(parsed.hooks).toEqual({ Stop: [] });
    expect(parsed.cleanupPeriodDays).toBe(36500);
  });

  it("a host with nothing to filter is still COPIED with the overlay (never 'link')", () => {
    const plan = planManagedSettings("own", JSON.stringify({ model: "haiku" }));
    expect(JSON.parse(plan.content)).toEqual({ model: "haiku", ...OVERLAY });
  });

  it("the overlay WINS over a host value, and says which keys it overrode", () => {
    const raw = JSON.stringify({ cleanupPeriodDays: 7, autoMemoryEnabled: true, autoDreamEnabled: false });
    const plan = planManagedSettings("own", raw);
    expect(JSON.parse(plan.content)).toEqual(OVERLAY);
    expect(plan.overridden.sort()).toEqual(["autoMemoryEnabled", "cleanupPeriodDays"]);
  });

  it("an unparseable host file → the overlay alone, with the reason (fail closed on hooks)", () => {
    const plan = planManagedSettings("host", "{ nope");
    expect(JSON.parse(plan.content)).toEqual(OVERLAY);
    expect(plan.hostUnusable).toMatch(/not valid JSON/);
    expect(planManagedSettings("own", "[1,2]").hostUnusable).toMatch(/not a JSON object/);
  });
});

describe("overlayViolations", () => {
  it("names a missing or small cleanupPeriodDays and an unset autoMemoryEnabled", () => {
    expect(overlayViolations("{}")).toEqual([
      "cleanupPeriodDays is unset (Claude Code's default is 30)",
      "autoMemoryEnabled is not false",
    ]);
    expect(overlayViolations(JSON.stringify({ cleanupPeriodDays: 30, autoMemoryEnabled: false }))).toEqual([
      "cleanupPeriodDays is 30",
    ]);
    expect(overlayViolations(JSON.stringify(OVERLAY))).toEqual([]);
    expect(overlayViolations("nope")).toEqual(["the file is not valid JSON"]);
  });
});

describe("applyRuntimeEnv", () => {
  it("sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 on the env it is given", () => {
    const env: NodeJS.ProcessEnv = {};
    applyRuntimeEnv(env);
    expect(env[DISABLE_AUTO_MEMORY_VAR]).toBe("1");
    expect(DISABLE_AUTO_MEMORY_VAR).toBe("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  });

  it("start.ts applies it before building the app", async () => {
    const src = await fs.readFile(new URL("../../../src/start.ts", import.meta.url), "utf8");
    const apply = src.indexOf("applyRuntimeEnv()");
    const build = src.indexOf("await buildApp()");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(build);
  });
});

describe("ensureClaudeHome writes the overlay (both the no-host and filtered-host cases)", () => {
  let root: string;
  let ownHome: string;
  let legacyHome: string;
  const cfg = (hooks: "own" | "host" = "own") => ({
    claudeHome: ownHome,
    legacyClaudeHome: legacyHome,
    claude: {
      transcripts: "own" as const,
      credentials: "host" as const,
      instructions: "own" as const,
      hooks,
      mcpServers: "own" as const,
    },
  });
  const own = async () => JSON.parse(await fs.readFile(path.join(ownHome, SETTINGS_ENTRY), "utf8"));

  beforeEach(async () => {
    root = await makeTmpDir("managers-overlay-");
    ownHome = path.join(root, "data", "claude-home");
    legacyHome = path.join(root, "home", ".claude");
    await fs.mkdir(legacyHome, { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("no host settings.json (the container case) → the overlay alone", async () => {
    const report = await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    expect(report.generated).toContain(SETTINGS_ENTRY);
    expect(await own()).toEqual(OVERLAY);
    expect((await fs.lstat(path.join(ownHome, SETTINGS_ENTRY))).isSymbolicLink()).toBe(false);
  });

  it("a filtered host settings.json → its other keys plus the overlay", async () => {
    await fs.writeFile(
      path.join(legacyHome, SETTINGS_ENTRY),
      JSON.stringify({ model: "opus", hooks: { Stop: [] }, cleanupPeriodDays: 14 }),
    );
    await ensureClaudeHome(cfg("own"), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    expect(await own()).toEqual({ model: "opus", ...OVERLAY });
    // …and the user's own file is untouched.
    expect(JSON.parse(await fs.readFile(path.join(legacyHome, SETTINGS_ENTRY), "utf8")).cleanupPeriodDays).toBe(14);
  });

  it("is idempotent: a second boot rewrites nothing", async () => {
    await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    const second = await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    expect(second.generated).toEqual([]);
    expect(await own()).toEqual(OVERLAY);
  });

  it("regenerates over its OWN earlier output when the host file appears later", async () => {
    await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    await fs.writeFile(path.join(legacyHome, SETTINGS_ENTRY), JSON.stringify({ model: "haiku" }));
    await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "x" });
    expect(await own()).toEqual({ model: "haiku", ...OVERLAY });
  });
});

describe("findRetentionOverrides (the boot notice)", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpDir("managers-retention-");
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  const write = async (dir: string, body: string, name = "settings.json") => {
    await fs.mkdir(path.join(root, dir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(root, dir, ".claude", name), body);
    return path.join(root, dir);
  };

  it("flags a project .claude/settings.json below the overlay value, and only that", async () => {
    const low = await write("low", JSON.stringify({ cleanupPeriodDays: 7 }));
    const high = await write("high", JSON.stringify({ cleanupPeriodDays: 99999 }));
    const none = await write("none", JSON.stringify({ model: "opus" }));
    const broken = await write("broken", "{ nope");
    const local = await write("local", JSON.stringify({ cleanupPeriodDays: 1 }), "settings.local.json");
    const missing = path.join(root, "missing");
    const hits = await findRetentionOverrides([low, high, none, broken, local, missing, low]);
    expect(hits).toEqual([{ file: path.join(low, ".claude", "settings.json"), days: 7 }]);
  });

  it("finds nothing on an empty list or a clean tree (the fresh-install case)", async () => {
    expect(await findRetentionOverrides([])).toEqual([]);
    expect(await findRetentionOverrides([root])).toEqual([]);
  });

  it("the notice names every file and the value, and says it governs every project", () => {
    const msg = describeRetentionOverrides([{ file: "/x/.claude/settings.json", days: 7 }]);
    expect(msg).toContain("/x/.claude/settings.json: cleanupPeriodDays 7");
    expect(msg).toContain("EVERY project");
    expect(msg).toContain("36500");
  });
});

/**
 * Managers M3: every agent builder declares `setting_sources: ["user","project"]`
 * so the retention/auto-memory overlay in `<claudeHome>/settings.json` is loaded
 * on both runtimes, and herdctl's own adapter turns it into the SDK option.
 */
import { describe, it, expect } from "vitest";
import { toSDKOptions, AgentConfigSchema } from "@herdctl/core";
import {
  buildAgentConfig,
  buildSweeperConfig,
  buildTriggerConfig,
} from "../../../src/herdctl-agent-config.js";
import type { PaddockConfig } from "../../../src/config.js";
import type { Project } from "../../../src/projects.js";
import type { PaddockTrigger } from "../../../src/trigger-config.js";

const cfg = { dataDir: "/tmp/data", nativeSystemPrompt: true, browserMcp: false } as unknown as PaddockConfig;
const project = {
  slug: "demo",
  name: "Demo",
  dir: "/tmp/data/projects/demo",
  workingDir: "/tmp/data/projects/demo",
  triggers: [],
} as unknown as Project;
const trigger = {
  trigger: { type: "schedule", cron: "0 9 * * *" },
  run: { prompt: "wake" },
  enabled: true,
} as unknown as PaddockTrigger;

const builders = {
  keeper: () => buildAgentConfig(cfg, project),
  sweeper: () => buildSweeperConfig(cfg, project),
  trigger: () => buildTriggerConfig(cfg, project, "wake", trigger),
};

describe("agent setting_sources (Managers M3)", () => {
  for (const [name, build] of Object.entries(builders)) {
    it(`${name}: declares ["user","project"]`, () => {
      expect(build().setting_sources).toEqual(["user", "project"]);
    });

    it(`${name}: survives herdctl's AgentConfigSchema and reaches the SDK options`, () => {
      // addAgent validates through this schema; an unknown key would be stripped.
      const parsed = AgentConfigSchema.parse(build());
      expect(parsed.setting_sources).toEqual(["user", "project"]);
      // The same adapter the SDK runtime uses for batch AND openChatSession.
      const sdk = toSDKOptions({ ...parsed, qualifiedName: build().name } as never);
      expect(sdk.settingSources).toEqual(["user", "project"]);
    });
  }

  it("returns a fresh array each time (no shared mutable constant leaks into configs)", () => {
    const a = builders.keeper().setting_sources as string[];
    const b = builders.keeper().setting_sources as string[];
    expect(a).not.toBe(b);
  });

  it("the keeper comment no longer claims the 30-day default is adequate", async () => {
    const { promises: fs } = await import("node:fs");
    const src = await fs.readFile(
      new URL("../../../src/herdctl-agent-config.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/adequate for realistic wake horizons/);
  });
});

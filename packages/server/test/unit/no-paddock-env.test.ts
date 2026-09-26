/**
 * Managers M1 regression guard: no source file may read (or even spell) a
 * `PADDOCK_*` variable. The rename to `MANAGERS_*` is what isolates Managers
 * from a co-located Paddock's environment; one stray `process.env.PADDOCK_X`
 * would quietly re-couple them. `env-scrub.ts` is the only allowed spelling —
 * it has to name the prefix to delete it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, "../../..");
const ALLOWED = new Set([path.join(packagesDir, "server", "src", "env-scrub.ts")]);
const PATTERN = /PADDOCK_[A-Z]/;

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|css|html)$/.test(e.name)) out.push(p);
  }
}

describe("no PADDOCK_* in packages/*/src", () => {
  it("only env-scrub.ts spells the inherited prefix", () => {
    const files: string[] = [];
    for (const pkg of fs.readdirSync(packagesDir)) {
      const src = path.join(packagesDir, pkg, "src");
      if (fs.existsSync(src)) walk(src, files);
    }
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => PATTERN.test(line))
          .map(({ n }) => `${path.relative(packagesDir, f)}:${n}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the guard pattern would catch a regression (control)", () => {
    expect(PATTERN.test("process.env." + "PADDOCK_" + "DATA_DIR")).toBe(true);
    expect(PATTERN.test("process.env.MANAGERS_DATA_DIR")).toBe(false);
  });
});

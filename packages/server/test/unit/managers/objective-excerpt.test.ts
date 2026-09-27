/** Managers M11: the objective card's plain-text excerpt of "Where we are". */
import { describe, it, expect } from "vitest";
import { excerptOf } from "../../../src/routes/managers.js";

describe("excerptOf (M11)", () => {
  it("strips inline Markdown, bullets, fact links and code fences, and collapses whitespace", () => {
    expect(excerptOf("- **Seven** of eight weeks met.\n- See [[reviews-stall-drafts]] and [the post](https://x.invalid).\n\n```\ncode\n```\n`done`"))
      .toBe("Seven of eight weeks met. See reviews-stall-drafts and the post. done");
  });

  it("returns short text as is and an empty section as empty", () => {
    expect(excerptOf("Early days.")).toBe("Early days.");
    expect(excerptOf("  \n ")).toBe("");
  });

  it("cuts long text at a word boundary with an ellipsis, within the limit", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const out = excerptOf(long, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });
});

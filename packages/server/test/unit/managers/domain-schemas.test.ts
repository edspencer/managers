/**
 * Managers M4: frontmatter, ids, the domain schemas (write → stringify → parse →
 * read round-trips) and the episode header grammar. See `src/managers/`.
 */
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { parseFrontmatter, stringifyFrontmatter, FrontmatterError } from "../../../src/managers/frontmatter.js";
import { newTaskId, newEpisodeId, newRunId, mintUnique } from "../../../src/managers/ids.js";
import {
  objectiveReadSchema,
  objectiveWriteSchema,
  taskReadSchema,
  taskWriteSchema,
  factReadSchema,
  factWriteSchema,
  runReadSchema,
  runWriteSchema,
  episodeWriteSchema,
} from "../../../src/managers/schemas.js";
import {
  EPISODE_HEADER_RE,
  parseEpisodeFile,
  parseEpisodeHeader,
  formatEpisode,
  pickMonths,
} from "../../../src/managers/episodes-store.js";
import {
  isTaskId,
  isEpisodeId,
  isRunId,
  monthOfId,
  isReservedSlug,
  workspaceLayout,
} from "../../../src/managers/layout.js";

/** Write a record through its strict schema, serialise it, then read it back leniently. */
function roundTrip<W extends Record<string, unknown>>(
  write: { parse(x: unknown): W },
  read: { parse(x: unknown): unknown },
  record: W,
  body = "Body.\n",
): unknown {
  const text = stringifyFrontmatter(write.parse(record), body);
  const doc = parseFrontmatter(text);
  expect(doc.body).toBe(body);
  return read.parse(doc.data);
}

describe("frontmatter", () => {
  it("parses and stringifies, tolerating CRLF and a BOM", () => {
    const doc = parseFrontmatter("﻿---\r\ntitle: A\r\nn: 2\r\n---\r\nhello\r\n");
    expect(doc).toEqual({ data: { title: "A", n: 2 }, body: "hello\n", hasFrontmatter: true });
    expect(stringifyFrontmatter({ title: "A", n: 2, skip: undefined }, "hello")).toBe("---\ntitle: A\nn: 2\n---\nhello\n");
  });

  it("treats a document without frontmatter as all body", () => {
    expect(parseFrontmatter("# Just text\n")).toEqual({ data: {}, body: "# Just text\n", hasFrontmatter: false });
  });

  it("keeps timestamps as strings (core schema)", () => {
    expect(parseFrontmatter("---\ncreated: 2026-09-26T07:05:00Z\nsince: 2026-09-19\n---\n").data).toEqual({
      created: "2026-09-26T07:05:00Z",
      since: "2026-09-19",
    });
  });

  it("throws FrontmatterError for unclosed, non-mapping or invalid YAML", () => {
    expect(() => parseFrontmatter("---\ntitle: A\n")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("---\n- a\n- b\n---\n")).toThrow(/mapping/);
    expect(() => parseFrontmatter("---\ntitle: [unclosed\n---\n")).toThrow(/YAML/);
  });
});

describe("ids", () => {
  const at = new Date("2026-09-26T07:04:59Z");
  it("mints the §2.7 shapes, in UTC, with a base32 suffix", () => {
    expect(newTaskId(at)).toMatch(/^t-260926-[a-z2-7]{4}$/);
    expect(newEpisodeId(at)).toMatch(/^ep-260926-0704-[a-z2-7]{2}$/);
    expect(newRunId(at)).toMatch(/^r-260926-0704-[a-z2-7]{2}$/);
    expect(isTaskId(newTaskId(at)) && isEpisodeId(newEpisodeId(at)) && isRunId(newRunId(at))).toBe(true);
    expect(monthOfId("t-260926-7k3f")).toBe("2026-09");
    expect(monthOfId("r-261103-0700-k3")).toBe("2026-11");
  });

  it("mintUnique regenerates on collision and gives up eventually", async () => {
    const seq = ["a", "a", "b"];
    const taken = new Set(["a"]);
    expect(await mintUnique(() => seq.shift()!, (id) => taken.has(id))).toBe("b");
    await expect(mintUnique(() => "a", () => true, 3)).rejects.toThrow(/unique/);
  });
});

describe("layout", () => {
  it("reserves the root state dirs as slugs", () => {
    for (const s of ["objectives", "tasks", "log", "runs", "reports", "memory", "archive"]) {
      expect(isReservedSlug(s)).toBe(true);
    }
    expect(isReservedSlug("acme-site")).toBe(false);
  });

  it("refuses to build a path from a malformed segment", () => {
    const l = workspaceLayout("/x");
    expect(l.objectiveFile("grow-awareness")).toBe("/x/objectives/grow-awareness/objective.md");
    expect(() => l.objectiveFile("../etc")).toThrow(/invalid/);
    expect(() => l.logFile("2026-13")).toThrow(/invalid/);
    expect(() => l.runFile("2026-09", "../../x")).toThrow(/invalid/);
    expect(l.rel("/x/tasks/open/t-1.md")).toBe("tasks/open/t-1.md");
  });
});

describe("schemas round-trip (strict write → file → lenient read)", () => {
  it("objective", () => {
    const rec = {
      title: "Grow awareness of Widget",
      status: "active" as const,
      success: "Widget is known to ≥3 relevant communities",
      triggers: ["wake"],
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-26T07:05:00Z",
    };
    expect(roundTrip(objectiveWriteSchema, objectiveReadSchema, rec)).toEqual(rec);
    expect(() => objectiveWriteSchema.parse({ ...rec, status: "someday" })).toThrow();
    expect(() => objectiveWriteSchema.parse({ ...rec, typo: 1 })).toThrow();
  });

  it("objective read is lenient: defaults, unknown keys kept", () => {
    expect(objectiveReadSchema.parse({ title: "T", extra: 1 })).toEqual({
      title: "T",
      status: "active",
      success: null,
      triggers: [],
      created: null,
      updated: null,
      extra: 1,
    });
  });

  it("task (the §4 sample)", () => {
    const rec = {
      id: "t-260926-7k3f",
      title: "Decide whether to merge renovate bump #88",
      status: "awaiting-ed" as const,
      objective: "burn-down-issues",
      source: "manager" as const,
      ask: "Renovate #88 bumps a major version; merge?",
      options: ["merge", "skip"],
      answer: null,
      github: ["widget-lib#88"],
      dispatched: [],
      shovel_ready: false,
      due: null,
      created: "2026-09-26T07:05:00Z",
      updated: "2026-09-26T07:05:00Z",
    };
    expect(roundTrip(taskWriteSchema, taskReadSchema, rec)).toEqual(rec);
    const answered = {
      ...rec,
      status: "open" as const,
      answer: { by: "ed", at: "2026-09-26T09:00:00Z", choice: "merge" },
      dispatched: [{ connection: "paddock", project: "widget-lib", chat: "abc-123", at: "2026-09-26T09:05:00Z" }],
    };
    expect(roundTrip(taskWriteSchema, taskReadSchema, answered)).toEqual({
      ...answered,
      answer: { ...answered.answer, text: null },
    });
  });

  it("task write enforces awaiting-ed ⇒ ask, and the github ref format", () => {
    const base = {
      id: "t-260926-7k3f",
      title: "x",
      status: "awaiting-ed" as const,
      objective: null,
      source: "manager" as const,
      ask: null,
      options: [],
      answer: null,
      github: [],
      dispatched: [],
      shovel_ready: false,
      due: null,
      created: "2026-09-26T07:05:00Z",
      updated: "2026-09-26T07:05:00Z",
    };
    expect(taskWriteSchema.safeParse(base).error?.issues[0]?.message).toMatch(/requires an ask/);
    expect(taskWriteSchema.safeParse({ ...base, ask: "?", github: ["not a ref"] }).success).toBe(false);
    expect(taskWriteSchema.safeParse({ ...base, ask: "?", github: ["acme/widget-lib#9"] }).success).toBe(true);
  });

  it("task read rejects an unknown status (the store turns this into a parseError)", () => {
    expect(taskReadSchema.safeParse({ id: "t-260926-7k3f", title: "x", status: "later" }).success).toBe(false);
  });

  it("fact", () => {
    const rec = {
      name: "quota-overrun-prone",
      description: "We exhaust the weekly quota about weekly.",
      type: "pattern" as const,
      since: "2026-09-19",
      until: null,
      confidence: "medium" as const,
      evidence: ["ep-260912-0310-a4", "ep-260919-0455-c7"],
    };
    expect(roundTrip(factWriteSchema, factReadSchema, rec, "Twice.\n## History\n- created\n")).toEqual(rec);
  });

  it("fact read accepts the MEMORY-RESEARCH `metadata.type` spelling and a blank until", () => {
    const doc = parseFrontmatter("---\nname: n\ndescription: d\nmetadata: { type: pattern }\nuntil:\n---\n");
    expect(factReadSchema.parse(doc.data)).toMatchObject({ name: "n", type: "pattern", until: null, evidence: [] });
  });

  it("run (the §4 sample)", () => {
    const rec = {
      id: "r-260926-0700-k3",
      trigger: "wake",
      kind: "wake" as const,
      objective: "burn-down-issues",
      status: "succeeded" as const,
      started: "2026-09-26T07:00:02Z",
      finished: "2026-09-26T07:06:41Z",
      sessionId: "7c1e0000-0000-0000-0000-000000000000",
      model: "claude-opus-5",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
      episodes: ["ep-260926-0704-c7"],
      tasksTouched: ["t-260926-7k3f"],
      reports: [],
      artifacts: [{ kind: "comment", ref: "widget-lib#412", note: "triage", at: "2026-09-26T07:05:00Z" }],
      mcpCalls: { paddock: { list_chats: 1, create_chat: 1 } },
      expect: { kind: "episode" as const, within: "48h" },
      expectResult: "met" as const,
      briefing: { path: ".managers/briefings/r-260926-0700-k3.md", sha256: "abc" },
      error: null,
    };
    const text = YAML.stringify(runWriteSchema.parse(rec));
    expect(runReadSchema.parse(YAML.parse(text))).toEqual({
      ...rec,
      expect: { ...rec.expect, report: null, description: null },
    });
    expect(runWriteSchema.safeParse({ ...rec, expect: { kind: "episode", within: "2 days" } }).success).toBe(false);
  });

  it("episode: format → parse is the identity", () => {
    const ep = episodeWriteSchema.parse({
      id: "ep-260926-0704-c7",
      at: "2026-09-26T07:04:00Z",
      importance: 6,
      run: "r-260926-0700-k3",
      tags: ["dispatch", "issues"],
      text: "Dispatched keeper chat for widget-lib#412 (templated triage). Awaiting result.",
      refs: ["widget-lib#412", "t-260926-7k3f"],
    });
    const { entries, errors } = parseEpisodeFile(`# Journal\n\n${formatEpisode(ep)}`);
    expect(errors).toEqual([]);
    expect(entries).toEqual([{ ...ep, chat: null, source: null, line: 3 }]);
    expect(episodeWriteSchema.safeParse({ ...ep, text: "x".repeat(1201) }).success).toBe(false);
    expect(episodeWriteSchema.safeParse({ ...ep, tags: ["Bad Tag"] }).success).toBe(false);
    expect(episodeWriteSchema.safeParse({ ...ep, refs: ["https://evil.example"] }).success).toBe(false);
  });
});

describe("episode header grammar", () => {
  const SAMPLE =
    "## 2026-09-26 07:04Z · ep-260926-0704-c7 · imp 6 · run r-260926-0700-k3 · #dispatch #issues";

  it("matches the §4 sample exactly", () => {
    expect(EPISODE_HEADER_RE.test(SAMPLE)).toBe(true);
    expect(parseEpisodeHeader(SAMPLE, 7)).toEqual({
      id: "ep-260926-0704-c7",
      at: "2026-09-26T07:04:00Z",
      importance: 6,
      run: "r-260926-0700-k3",
      chat: null,
      source: null,
      tags: ["dispatch", "issues"],
      text: "",
      refs: [],
      line: 7,
    });
  });

  it("parses the §4 block, with its refs line", () => {
    const text = [
      SAMPLE,
      "Dispatched keeper chat for widget-lib#412 (templated triage). Awaiting result.",
      "refs: widget-lib#412, t-260926-7k3f",
      "",
    ].join("\n");
    const { entries } = parseEpisodeFile(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "Dispatched keeper chat for widget-lib#412 (templated triage). Awaiting result.",
      refs: ["widget-lib#412", "t-260926-7k3f"],
    });
  });

  it("accepts the optional segments in any order, and no segments at all", () => {
    expect(parseEpisodeHeader("## 2026-09-26 09:00Z · ep-260926-0900-ab · imp 3 · #answer · source ed · chat 1234-abcd")).toMatchObject({
      tags: ["answer"],
      source: "ed",
      chat: "1234-abcd",
      run: null,
    });
    expect(parseEpisodeHeader("## 2026-09-26 09:00Z · ep-260926-0900-ab · imp 10")).toMatchObject({ importance: 10, tags: [] });
  });

  it("rejects malformed headers", () => {
    for (const bad of [
      "## 2026-09-26 · ep-260926-0900-ab · imp 3",
      "## 2026-09-26 09:00Z · ep-260926-0900-ab",
      "## 2026-09-26 09:00Z · ep-260926-0900-ab · imp 11",
      "## 2026-09-26 25:00Z · ep-260926-0900-ab · imp 3",
      "## Some notes",
    ]) {
      expect(typeof parseEpisodeHeader(bad)).toBe("string");
    }
  });

  it("skips a malformed block with an error and keeps its neighbours", () => {
    const text = [
      "## 2026-09-01 10:00Z · ep-260901-1000-aa · imp 2",
      "first",
      "## a hand-written heading",
      "orphan text",
      "## 2026-09-02 10:00Z · ep-260902-1000-bb · imp 4 · #x",
      "second",
      "## 2026-09-03 10:00Z · ep-260903-1000-cc · imp 4",
      "",
    ].join("\n");
    const { entries, errors } = parseEpisodeFile(text);
    expect(entries.map((e) => e.id)).toEqual(["ep-260901-1000-aa", "ep-260902-1000-bb"]);
    expect(errors.map((e) => e.line)).toEqual([3, 7]);
    expect(errors[1]!.error).toMatch(/no text/);
  });
});

describe("month paging", () => {
  const all = ["2026-09", "2026-08", "2026-07", "2026-06"];
  it("pages newest first and hands back the cursor", () => {
    expect(pickMonths(all, { months: 2 })).toEqual({ months: ["2026-09", "2026-08"], nextBefore: "2026-08" });
    expect(pickMonths(all, { months: 2, before: "2026-08" })).toEqual({ months: ["2026-07", "2026-06"], nextBefore: null });
    expect(pickMonths(all, {})).toEqual({ months: ["2026-09", "2026-08", "2026-07"], nextBefore: "2026-07" });
    expect(pickMonths([], {})).toEqual({ months: [], nextBefore: null });
  });
});

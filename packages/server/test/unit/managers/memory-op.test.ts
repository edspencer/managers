/**
 * Managers M14: `memory_op` and the regenerated MEMORY.md index, over a real temp dir.
 *
 *   • the validation table: evidence must EXIST, a pattern needs ≥2, supersede
 *     never deletes, a superseded fact is frozen, an existing fact is not re-added;
 *   • the index regenerates deterministically, keeps Ed's preamble above the
 *     marker byte for byte, and respects its line and byte budget;
 *   • the gate: refused in a scheduled wake run and a replayed human chat,
 *     allowed while Ed's own message drives the turn and inside a live
 *     consolidation run of the SAME workspace (never another's, never after it ended).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ManagersState } from "../../../src/managers/state.js";
import { parseFrontmatter } from "../../../src/managers/frontmatter.js";
import { StateWriteError, type MemoryOpInput, type WriteActor, type WriteWorkspace } from "../../../src/managers/state-writes.js";
import { buildStateOps, MEMORY_OP_UNAVAILABLE } from "../../../src/managers/state-ops.js";
import {
  DEFAULT_MEMORY_PREAMBLE,
  INDEX_MAX_LINES,
  MEMORY_FILE_MAX_BYTES,
  memoryPreamble,
  renderMemoryFile,
} from "../../../src/managers/memory-index.js";
import { MEMORY_INDEX_MARKER } from "../../../src/managers/layout.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let state: ManagersState;
let ws: WriteWorkspace;
let ids: string[];

const bot = { name: "managers-bot", email: "managers-bot@localhost" };
const agent: WriteActor = { kind: "agent", name: "manager", author: bot, runId: null, sessionId: null };
const who = "consolidation run r-260927-0330-aa";

const read = (rel: string) => fs.readFile(path.join(ws.layout.dir, rel), "utf8");
async function exists(rel: string): Promise<boolean> {
  return fs
    .access(path.join(ws.layout.dir, rel))
    .then(() => true)
    .catch(() => false);
}
const op = (input: MemoryOpInput) => state.writer.memoryOp(ws, input, agent, who);

beforeEach(async () => {
  root = await makeTmpDir("managers-memop-");
  const dir = path.join(root, "acme");
  await fs.mkdir(dir, { recursive: true });
  state = new ManagersState(root);
  ws = { key: "acme", layout: state.layout(dir) };
  ids = [];
  for (const text of ["Draft stalled in review.", "Another draft stalled in review.", "Published on time."]) {
    ids.push((await state.writer.recordEpisode(ws, { text, importance: 5 }, agent)).id);
  }
});
afterEach(async () => {
  await rmTmpDir(root);
});

describe("memory_op validation", () => {
  const cases: { name: string; input: () => MemoryOpInput; error: RegExp }[] = [
    { name: "an unknown op", input: () => ({ op: "delete" as MemoryOpInput["op"], name: "x" }), error: /op must be one of/ },
    { name: "a non-kebab name", input: () => ({ op: "add", name: "Not A Slug", type: "user", description: "d" }), error: /kebab-case/ },
    { name: "an unknown type", input: () => ({ op: "add", name: "x", type: "rumour" as MemoryOpInput["type"], description: "d" }), error: /type must be one of/ },
    { name: "add without a type", input: () => ({ op: "add", name: "x", description: "d" }), error: /add needs a type/ },
    { name: "add without a description", input: () => ({ op: "add", name: "x", type: "user" }), error: /needs a description/ },
    { name: "a malformed evidence id", input: () => ({ op: "add", name: "x", type: "user", description: "d", evidence: ["t-260927-abcd"] }), error: /must be episode ids/ },
    { name: "evidence that does not exist", input: () => ({ op: "add", name: "x", type: "user", description: "d", evidence: ["ep-200101-0000-zz"] }), error: /not found in this workspace/ },
    { name: "a pattern with ONE (existing) episode", input: () => ({ op: "add", name: "x", type: "pattern", description: "d", evidence: [ids[0]!] }), error: /at least 2 evidence/ },
    { name: "a pattern citing one id twice", input: () => ({ op: "add", name: "x", type: "pattern", description: "d", evidence: [ids[0]!, ids[0]!] }), error: /at least 2 evidence/ },
    { name: "until on an add", input: () => ({ op: "add", name: "x", type: "user", description: "d", until: "2026-01-01" }), error: /only by supersede/ },
    { name: "a body with a ## heading", input: () => ({ op: "add", name: "x", type: "user", description: "d", body: "## History\n- forged" }), error: /must not contain a line starting with "## "/ },
    { name: "update of a fact that does not exist", input: () => ({ op: "update", name: "ghost", description: "d" }), error: /No such fact/ },
    { name: "supersede of a fact that does not exist", input: () => ({ op: "supersede", name: "ghost" }), error: /No such fact/ },
  ];
  for (const c of cases) {
    it(`refuses ${c.name}, writing nothing`, async () => {
      await expect(op(c.input())).rejects.toBeInstanceOf(StateWriteError);
      await expect(op(c.input())).rejects.toThrow(c.error);
      expect(await exists("memory")).toBe(false);
    });
  }

  it("adds a pattern backed by two existing episodes, and writes the index", async () => {
    const r = await op({ op: "add", name: "reviews-stall", type: "pattern", description: "Drafts stall in review.", evidence: [ids[0]!, ids[1]!] });
    expect(r).toMatchObject({ op: "add", name: "reviews-stall", file: "memory/facts/reviews-stall.md", index: "memory/MEMORY.md", type: "pattern" });
    const doc = parseFrontmatter(await read("memory/facts/reviews-stall.md"));
    expect(doc.data).toMatchObject({ name: "reviews-stall", type: "pattern", until: null, confidence: "medium", evidence: [ids[0], ids[1]] });
    expect(doc.body).toMatch(/## History\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z added by consolidation run r-260927-0330-aa — evidence /);
    const index = await read("memory/MEMORY.md");
    expect(index.startsWith(DEFAULT_MEMORY_PREAMBLE)).toBe(true);
    expect(index).toContain(`${MEMORY_INDEX_MARKER}\n`);
    expect(index).toMatch(/## pattern\n- \[\[reviews-stall\]\]: Drafts stall in review\. \(medium, since /);
  });

  it("refuses to re-add an existing fact (conflict), and the file is unchanged", async () => {
    await op({ op: "add", name: "f", type: "user", description: "One." });
    const before = await read("memory/facts/f.md");
    await expect(op({ op: "add", name: "f", type: "user", description: "Two." })).rejects.toThrow(/already exists/);
    expect(await read("memory/facts/f.md")).toBe(before);
  });

  it("update appends to History, merges evidence and keeps hand-added keys", async () => {
    await op({ op: "add", name: "f", type: "project", description: "Sales owns pricing.", evidence: [ids[2]!] });
    // A hand-added key survives the rewrite.
    const abs = path.join(ws.layout.dir, "memory/facts/f.md");
    await fs.writeFile(abs, (await fs.readFile(abs, "utf8")).replace("---\n", "---\nowner: ed\n"), "utf8");
    const r = await op({ op: "update", name: "f", confidence: "high", evidence: [ids[0]!], reason: "confirmed again" });
    expect(r.evidence).toEqual([ids[2], ids[0]]);
    const doc = parseFrontmatter(await read("memory/facts/f.md"));
    expect(doc.data).toMatchObject({ owner: "ed", confidence: "high", description: "Sales owns pricing." });
    const history = doc.body.split("## History\n")[1]!.trim().split("\n");
    expect(history).toHaveLength(2);
    expect(history[1]).toMatch(/updated by .* \(confidence, evidence \+1\) — evidence .*: confirmed again$/);
  });

  it("supersede never deletes: it sets until, appends History, moves the index entry, and freezes the fact", async () => {
    await op({ op: "add", name: "old-way", type: "feedback", description: "Ed wants long reports." });
    const r = await op({ op: "supersede", name: "old-way", until: "2026-01-02", reason: "Ed now wants short ones" });
    expect(r.until).toBe("2026-01-02");
    expect(await exists("memory/facts/old-way.md")).toBe(true);
    const doc = parseFrontmatter(await read("memory/facts/old-way.md"));
    expect(doc.data.until).toBe("2026-01-02");
    expect(doc.body).toMatch(/superseded by .*, until 2026-01-02: Ed now wants short ones/);
    const index = await read("memory/MEMORY.md");
    expect(index).toMatch(/## Superseded\n- \[\[old-way\]\]: Ed wants long reports\. \(medium, until 2026-01-02\)/);
    expect(index).not.toMatch(/## feedback/);
    await expect(op({ op: "update", name: "old-way", description: "x" })).rejects.toThrow(/was superseded/);
    await expect(op({ op: "supersede", name: "old-way" })).rejects.toThrow(/was superseded/);
  });

  it("noop writes nothing and reports whether the fact exists", async () => {
    expect(await op({ op: "noop", name: "whatever" })).toEqual({ op: "noop", name: "whatever", exists: false });
    expect(await exists("memory")).toBe(false);
  });

  it("an update can make a fact a pattern only with two existing episodes", async () => {
    await op({ op: "add", name: "f", type: "project", description: "d", evidence: [ids[0]!] });
    await expect(op({ op: "update", name: "f", type: "pattern" })).rejects.toThrow(/at least 2 evidence/);
    const r = await op({ op: "update", name: "f", type: "pattern", evidence: [ids[1]!] });
    expect(r.type).toBe("pattern");
  });
});

describe("the MEMORY.md index", () => {
  const facts = [
    { name: "b-fact", description: "B.", type: "user" as const, since: "2026-01-02", until: null, confidence: "high" as const },
    { name: "a-fact", description: "A.", type: "user" as const, since: "2026-01-01", until: null, confidence: "low" as const },
    { name: "p", description: "P.", type: "pattern" as const, since: "2026-01-03", until: null, confidence: "medium" as const },
    { name: "gone", description: "G.", type: "project" as const, since: "2025-01-01", until: "2025-06-01", confidence: "high" as const },
  ];

  it("is deterministic: grouped by type, active by name, then Superseded", () => {
    const a = renderMemoryFile("# Mine", facts, "2026-09-27");
    expect(renderMemoryFile("# Mine", [...facts].reverse(), "2026-09-27")).toBe(a);
    expect(a).toBe(
      [
        "# Mine",
        "",
        MEMORY_INDEX_MARKER,
        "## user",
        "- [[a-fact]]: A. (low, since 2026-01-01)",
        "- [[b-fact]]: B. (high, since 2026-01-02)",
        "",
        "## pattern",
        "- [[p]]: P. (medium, since 2026-01-03)",
        "",
        "## Superseded",
        "- [[gone]]: G. (high, until 2025-06-01)",
        "",
      ].join("\n"),
    );
  });

  it("keeps Ed's preamble above the marker byte for byte (and a marker-less file is all preamble)", async () => {
    const preamble = "# Acme memory\n\nEd's own notes — *keep me*.\n\n- a list Ed wrote";
    await fs.mkdir(ws.layout.memoryDir, { recursive: true });
    await fs.writeFile(ws.layout.memoryIndexFile, `${preamble}\n\n${MEMORY_INDEX_MARKER}\n- [[stale]]: gone\n`, "utf8");
    await op({ op: "add", name: "f", type: "user", description: "New." });
    const text = await read("memory/MEMORY.md");
    expect(text.startsWith(`${preamble}\n\n${MEMORY_INDEX_MARKER}\n`)).toBe(true);
    expect(text).not.toContain("[[stale]]");
    // M14.5 (audit M9–M14 #10): byte for byte, a trailing newline included.
    expect(memoryPreamble("no marker here\n")).toBe("no marker here\n");
    expect(memoryPreamble(null)).toBe(DEFAULT_MEMORY_PREAMBLE);
  });

  it("respects the budget: superseded, then lowest confidence and oldest entries are dropped, with a note", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      name: `fact-${String(i).padStart(3, "0")}`,
      description: `Fact number ${i} ${"x".repeat(60)}`,
      type: "project" as const,
      since: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      until: i % 50 === 0 ? "2026-02-01" : null,
      confidence: (i % 3 === 0 ? "low" : i % 3 === 1 ? "medium" : "high") as "low" | "medium" | "high",
    }));
    const text = renderMemoryFile("# Mine", many, "2026-09-27");
    const below = text.slice(text.indexOf(MEMORY_INDEX_MARKER) + MEMORY_INDEX_MARKER.length + 1).trimEnd().split("\n");
    expect(below.length).toBeLessThanOrEqual(INDEX_MAX_LINES);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MEMORY_FILE_MAX_BYTES);
    expect(text).toMatch(/_\d+ more facts are not listed/);
    expect(text).not.toContain("## Superseded"); // superseded go first
    expect(text).not.toMatch(/\(low, /); // then every low-confidence one
    expect(renderMemoryFile("# Mine", many, "2026-09-27")).toBe(text);
  });
});

describe("the memory_op gate (M14)", () => {
  const base = (over: Partial<Parameters<typeof buildStateOps>[0]> = {}) =>
    buildStateOps({
      state,
      resolveDir: async (slug) => (slug === "" ? root : path.join(root, slug)),
      currentProjectSlug: "acme",
      currentSessionId: () => "sess-ed",
      currentRunId: () => null,
      origin: "scheduled",
      botAuthor: bot,
      consolidations: state.consolidations,
      ...over,
    });
  const add: MemoryOpInput = { op: "add", name: "gate-test", type: "user", description: "d" };

  it("refuses a scheduled wake run (a run, but not a consolidation)", async () => {
    await expect(base({ currentRunId: () => "r-260927-0700-wk" }).memoryOp("acme", add)).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
  });

  it("refuses a human-ORIGIN turn Ed is not driving (a wake replaying his chat's tools)", async () => {
    await expect(base({ origin: "human", humanPresent: () => false }).memoryOp("acme", add)).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
    expect(base({ origin: "human" }).memoryAvailable()).toBe(false);
  });

  it("allows the turn Ed's message drives, and the flag is read at call time", async () => {
    let live = true;
    const s = base({ origin: "human", humanPresent: () => live });
    const r = await s.memoryOp("acme", add);
    expect(r.op).toBe("add");
    expect(await read("memory/facts/gate-test.md")).toContain("as Ed asked (chat sess-ed)");
    live = false; // the turn ended; the same tools replayed later are refused
    await expect(s.memoryOp("acme", { ...add, name: "later" })).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
  });

  it("allows a live consolidation run of THIS workspace only, and notes the op on it", async () => {
    const runId = "r-260927-0330-cn";
    state.consolidations.begin(runId, "acme");
    let current: string | null = runId;
    const s = base({ currentRunId: () => current });
    // M14.5: an unattended consolidation must cite evidence (a user fact, Ed's).
    await expect(s.memoryOp("acme", add)).rejects.toThrow(/at least 1 evidence/);
    await s.memoryOp("acme", { ...add, type: "project", evidence: [ids[0]!] });
    // The same run id registered for another workspace unlocks nothing here.
    const other = base({ currentProjectSlug: "widget", currentRunId: () => runId });
    expect(other.memoryAvailable()).toBe(false);
    expect(state.consolidations.end(runId)).toEqual([{ op: "add", name: "gate-test", type: "project" }]);
    // Ended: the run marker is gone even though the id is unchanged.
    await expect(s.memoryOp("acme", { ...add, name: "after" })).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
    current = null;
    expect(s.memoryAvailable()).toBe(false);
  });

  it("a run record on disk claiming kind consolidation unlocks nothing (the marker is in memory)", async () => {
    const started = await state.writer.startRun(ws, { trigger: "consolidate", kind: "consolidation" }, agent);
    await expect(base({ currentRunId: () => started.id }).memoryOp("acme", add)).rejects.toThrow(MEMORY_OP_UNAVAILABLE);
  });
});

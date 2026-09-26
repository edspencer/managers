/**
 * Managers M5: id uniqueness under the write lock, with collisions FORCED.
 *
 * The real episode suffix has 1024 values per minute, so 50 concurrent writes
 * only collide by luck. Here the minter draws from 100 values, so without the
 * per-workspace lock (every write reading the id index before any appends) the
 * 50 writes would almost surely mint a duplicate — and with it, they never do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("../../../src/managers/ids.js", async (orig) => {
  const real = await orig<typeof import("../../../src/managers/ids.js")>();
  return {
    ...real,
    newEpisodeId: () => `ep-260926-0700-${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`,
  };
});

import { ManagersState } from "../../../src/managers/state.js";
import { parseEpisodeFile } from "../../../src/managers/episodes-store.js";
import type { WriteActor } from "../../../src/managers/state-writes.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
beforeEach(async () => {
  root = await makeTmpDir("managers-conc-");
});
afterEach(async () => {
  await rmTmpDir(root);
});

const agent: WriteActor = { kind: "agent", name: "manager", author: { name: "b", email: "b@x" } };

describe("record_episode under forced id collisions", () => {
  it("50 concurrent writes still get 50 unique ids and 50 parseable blocks", async () => {
    const dir = path.join(root, "acme");
    await fs.mkdir(dir, { recursive: true });
    const state = new ManagersState(root);
    const ws = { key: "acme", layout: state.layout(dir) };
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) => state.writer.recordEpisode(ws, { text: `e${i}`, importance: 2 }, agent)),
    );
    expect(new Set(res.map((r) => r.id)).size).toBe(50);
    const [file] = await fs.readdir(path.join(dir, "log"));
    const parsed = parseEpisodeFile(await fs.readFile(path.join(dir, "log", file!), "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(50);
    expect(new Set(parsed.entries.map((e) => e.id)).size).toBe(50);
  });
});

/** Managers M12: a memory fact's evidence ids resolved to journal/log locations and web links. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodesStore } from "../../../src/managers/episodes-store.js";
import { workspaceLayout } from "../../../src/managers/layout.js";
import {
  EvidenceResolver,
  episodeHref,
  objectiveOfFile,
  viewBaseOf,
} from "../../../src/managers/evidence-links.js";

let root: string;

async function put(rel: string, text: string) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
}

const ep = (id: string, day = "2026-09-02") => `## ${day} 10:00Z · ${id} · imp 3\ntext of ${id}\n`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mgr-evidence-"));
  // The project: one entry in an objective journal (an OLDER month), one in the log.
  await put("acme/objectives/grow/journal/2026-08.md", ep("ep-260830-1000-aa", "2026-08-30"));
  await put("acme/objectives/grow/journal/2026-09.md", ep("ep-260902-1000-bb"));
  await put("acme/log/2026-09.md", ep("ep-260903-1000-cc", "2026-09-03"));
  // Home: its own journal entry.
  await put("objectives/coord/journal/2026-09.md", ep("ep-260904-1000-hh", "2026-09-04"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("evidence link helpers (M12)", () => {
  it("builds web URLs for journal and log entries, at a project and at Home", () => {
    expect(viewBaseOf("")).toBe("");
    expect(viewBaseOf("acme")).toBe("/projects/acme");
    expect(objectiveOfFile("objectives/grow/journal/2026-09.md")).toBe("grow");
    expect(objectiveOfFile("log/2026-09.md")).toBeNull();
    expect(episodeHref("acme", "objectives/grow/journal/2026-09.md", "ep-1")).toBe("/projects/acme/objectives/grow#ep-1");
    expect(episodeHref("acme", "log/2026-09.md", "ep-1")).toBe("/projects/acme/files/log/2026-09.md");
    expect(episodeHref("", "objectives/coord/journal/2026-09.md", "ep-1")).toBe("/objectives/coord#ep-1");
  });
});

describe("EvidenceResolver (M12)", () => {
  const store = new EpisodesStore();
  const project = () => ({ key: "acme", layout: workspaceLayout(path.join(root, "acme")) });
  const home = () => ({ key: "", layout: workspaceLayout(root) });

  it("resolves a project fact's evidence in the project: journal (any month) and log", async () => {
    const r = new EvidenceResolver(store, project(), home());
    const links = await r.resolve({ scope: "project", evidence: ["ep-260830-1000-aa", "ep-260903-1000-cc"] });
    expect(links).toEqual([
      {
        episode: "ep-260830-1000-aa",
        found: true,
        workspace: "acme",
        objective: "grow",
        file: "objectives/grow/journal/2026-08.md",
        line: 1,
        href: "/projects/acme/objectives/grow#ep-260830-1000-aa",
      },
      {
        episode: "ep-260903-1000-cc",
        found: true,
        workspace: "acme",
        objective: null,
        file: "log/2026-09.md",
        line: 1,
        href: "/projects/acme/files/log/2026-09.md",
      },
    ]);
  });

  it("keeps an id it cannot find, marked not found, in order", async () => {
    const r = new EvidenceResolver(store, project(), home());
    const links = await r.resolve({ scope: "project", evidence: ["ep-000000-0000-zz", "ep-260902-1000-bb"] });
    expect(links.map((l) => [l.episode, l.found, l.href])).toEqual([
      ["ep-000000-0000-zz", false, null],
      ["ep-260902-1000-bb", true, "/projects/acme/objectives/grow#ep-260902-1000-bb"],
    ]);
  });

  it("a project fact never resolves into Home, and a root fact looks in Home first, then the viewing project", async () => {
    const r = new EvidenceResolver(store, project(), home());
    const own = await r.resolve({ scope: "project", evidence: ["ep-260904-1000-hh"] });
    expect(own[0]!.found).toBe(false);
    const shared = await r.resolve({ scope: "root", evidence: ["ep-260904-1000-hh", "ep-260902-1000-bb"] });
    expect(shared.map((l) => [l.workspace, l.href])).toEqual([
      ["", "/objectives/coord#ep-260904-1000-hh"],
      ["acme", "/projects/acme/objectives/grow#ep-260902-1000-bb"],
    ]);
  });

  it("at Home itself, a root fact looks only in Home", async () => {
    const r = new EvidenceResolver(store, null, home());
    const links = await r.resolve({ scope: "root", evidence: ["ep-260904-1000-hh", "ep-260902-1000-bb"] });
    expect(links.map((l) => l.found)).toEqual([true, false]);
  });

  it("an empty evidence list resolves to no links", async () => {
    const r = new EvidenceResolver(store, project(), home());
    expect(await r.resolve({ scope: "project", evidence: [] })).toEqual([]);
  });
});

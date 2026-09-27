/**
 * Managers M9.5 (audit #1): project.yaml writes are serialised per workspace and
 * atomic. Before the fix a reader racing a write could parse a truncated file,
 * which for the ROOT normalised to blank defaults (no `behaviours:`) — and a
 * writer that read that then wrote it back, wiping Home.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProjectStore } from "../../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

let root: string;
let store: ProjectStore;
const BEHAVIOURS = { "triage-external-prs": { description: "d", triggers: ["triage-prs"], tools: ["mcp__paddock__create_chat"] } };

beforeEach(async () => {
  root = await makeTmpDir("m95-yaml-");
  store = new ProjectStore(root);
  await store.init();
  await fs.writeFile(
    path.join(root, "project.yaml"),
    YAML.stringify({ name: "Home", started: "2026-07-28", behaviours: BEHAVIOURS }),
  );
});
afterEach(async () => rmTmpDir(root));

describe("project.yaml writes (M9.5)", () => {
  it("rewrites by rename, never in place (a reader cannot see a torn file)", async () => {
    // A hard link pins the file's old inode. An in-place write (truncate, then
    // write — what a racing reader saw half of) changes what the link reads; a
    // temp file + rename leaves the old inode whole and swaps in a new one.
    const file = path.join(root, "project.yaml");
    const pinned = path.join(root, "pinned-inode.yaml");
    await fs.link(file, pinned);
    const before = await fs.readFile(pinned, "utf8");
    await store.update("", { summary: "rewritten" });
    expect(await fs.readFile(pinned, "utf8")).toBe(before);
    expect((await fs.stat(file)).ino).not.toBe((await fs.stat(pinned)).ino);
    const doc = YAML.parse(await fs.readFile(file, "utf8"));
    expect(doc.summary).toBe("rewritten");
    expect(doc.behaviours).toEqual(BEHAVIOURS);
    expect(doc.started).toBe("2026-07-28");
  });

  it("concurrent writers of different keys all land (no lost update)", async () => {
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) =>
        store.setTrigger("", `t${i}`, { trigger: { type: "schedule", cron: "0 4 1 1 *" }, run: { prompt: "p" }, enabled: false }),
      ),
      ...Array.from({ length: 15 }, (_, i) => store.update("", { summary: `s${i}` })),
      store.setBehaviourEnabled("", "triage-external-prs", true),
      store.pinFile("", "project.yaml"),
    ]);
    const p = await store.get("");
    for (let i = 0; i < 15; i++) expect(p.triggers?.[`t${i}`], `t${i}`).toBeTruthy();
    expect(p.behaviours?.["triage-external-prs"]).toMatchObject({ enabled: true, triggers: ["triage-prs"] });
    expect(p.pinned).toEqual(["project.yaml"]);
  });

  it("an unparseable root is flagged and never rewritten", async () => {
    const broken = 'name: "Home\nbehaviours: [oops\n';
    await fs.writeFile(path.join(root, "project.yaml"), broken);
    const p = await store.get("");
    expect(p.configError).toMatch(/not valid YAML/);
    await expect(store.update("", { summary: "flatten" })).rejects.toThrow(/Refusing to rewrite Home's project\.yaml/);
    await expect(store.setTrigger("", "t", { trigger: { type: "schedule", cron: "0 4 1 1 *" }, run: { prompt: "p" } })).rejects.toThrow(
      /Refusing/,
    );
    expect(await fs.readFile(path.join(root, "project.yaml"), "utf8")).toBe(broken);
  });

  it("a behaviours: block that would thin out on sanitising is a configError (project too)", async () => {
    await fs.mkdir(path.join(root, "acme"));
    await fs.writeFile(
      path.join(root, "acme", "project.yaml"),
      YAML.stringify({ name: "Acme", behaviours: { "triage-external-prs": { triggers: "triage-prs" } } }),
    );
    expect((await store.get("acme")).configError).toMatch(/behaviours\.triage-external-prs\.triggers is not a list/);
    await expect(store.update("acme", { summary: "s" })).rejects.toThrow(/Refusing to rewrite "acme"'s/);
  });

  it("an empty or absent root file is a fresh record, not an error", async () => {
    await fs.writeFile(path.join(root, "project.yaml"), "");
    expect((await store.get("")).configError).toBeUndefined();
    await fs.rm(path.join(root, "project.yaml"));
    expect((await store.get("")).configError).toBeUndefined();
  });
});

/**
 * Managers M1: the data-dir safety guard. A non-empty projects root holding
 * projects but no `.managers-data` marker is refused; the marker or the adopt
 * flag lets boot proceed; a fresh root is claimed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadPaddockConfig } from "../../src/config.js";
import {
  DATA_REPO_MARKER,
  claimProjectsRoot,
  dataDirGuardRefusal,
} from "../../src/data-dir-guard.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const TOUCHED = ["MANAGERS_DATA_DIR", "MANAGERS_PROJECTS_DIR", "MANAGERS_ADOPT_DATA_DIR"];

function seedForeignProject(root: string, slug = "acme-site"): void {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, "project.yaml"), `slug: ${slug}\nname: Acme\n`);
}

describe("data-dir guard", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("managers-guard-");
    saved = {};
    for (const k of TOUCHED) saved[k] = process.env[k];
    process.env.MANAGERS_DATA_DIR = dataDir;
    delete process.env.MANAGERS_PROJECTS_DIR;
    delete process.env.MANAGERS_ADOPT_DATA_DIR;
  });
  afterEach(async () => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("refuses a non-empty projects root with projects and no marker", () => {
    const root = path.join(dataDir, "projects");
    seedForeignProject(root);
    expect(() => loadPaddockConfig()).toThrow(/Refusing to start.*1 project.*\.managers-data/s);
    // Refusing writes nothing into the foreign directory.
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(false);
  });

  it("refuses via MANAGERS_PROJECTS_DIR too, wherever it points", async () => {
    const elsewhere = await makeTmpDir("managers-guard-foreign-");
    try {
      seedForeignProject(elsewhere, "widget-lib");
      seedForeignProject(elsewhere, "empty-project");
      process.env.MANAGERS_PROJECTS_DIR = elsewhere;
      expect(() => loadPaddockConfig()).toThrow(/2 projects/);
    } finally {
      await rmTmpDir(elsewhere);
    }
  });

  it("boots when the marker is present", () => {
    const root = path.join(dataDir, "projects");
    seedForeignProject(root);
    fs.writeFileSync(path.join(root, DATA_REPO_MARKER), "");
    expect(() => loadPaddockConfig()).not.toThrow();
  });

  it("boots with MANAGERS_ADOPT_DATA_DIR=1, and does NOT write the marker", () => {
    const root = path.join(dataDir, "projects");
    seedForeignProject(root);
    process.env.MANAGERS_ADOPT_DATA_DIR = "1";
    expect(() => loadPaddockConfig()).not.toThrow();
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(false);
  });

  it("ignores a falsy adopt flag", () => {
    const root = path.join(dataDir, "projects");
    seedForeignProject(root);
    process.env.MANAGERS_ADOPT_DATA_DIR = "0";
    expect(() => loadPaddockConfig()).toThrow(/Refusing to start/);
  });

  it("claims a fresh (absent) root by writing the marker, so later boots pass", () => {
    const cfg = loadPaddockConfig();
    expect(fs.existsSync(path.join(cfg.projectsRoot, DATA_REPO_MARKER))).toBe(true);
    seedForeignProject(cfg.projectsRoot);
    expect(() => loadPaddockConfig()).not.toThrow();
  });

  // M9.5 (audit #7): this used to be claimed — a marker, git init, README and
  // .managers/ written into somebody's real directory of notes or code.
  it("refuses a non-empty root with NO projects (loose files, a code dir) and writes nothing", () => {
    const root = path.join(dataDir, "projects");
    fs.mkdirSync(path.join(root, "somerepo", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes.txt"), "hi\n");
    fs.writeFileSync(path.join(root, "somerepo", "src", "a.ts"), "export {};\n");
    const before = fs.readdirSync(root).sort();
    expect(dataDirGuardRefusal(root, {})).toMatch(/not empty.*\.managers-data/s);
    expect(() => loadPaddockConfig()).toThrow(/Refusing to start.*not empty/s);
    claimProjectsRoot(root);
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it("claims an EMPTY existing root", () => {
    const root = path.join(dataDir, "projects");
    fs.mkdirSync(root, { recursive: true });
    expect(dataDirGuardRefusal(root, {})).toBeUndefined();
    loadPaddockConfig();
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(true);
  });

  it("adopts a non-empty, project-less root only with MANAGERS_ADOPT_DATA_DIR=1 (and never marks it)", () => {
    const root = path.join(dataDir, "projects");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "notes.txt"), "hi\n");
    process.env.MANAGERS_ADOPT_DATA_DIR = "1";
    expect(() => loadPaddockConfig()).not.toThrow();
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(false);
  });

  // M15: a fresh `git clone` of an empty managers-data holds only `.git/`.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("claims a root holding only the .git of an empty clone", () => {
    const root = path.join(dataDir, "projects");
    const bare = path.join(dataDir, "remote.git");
    git(dataDir, "init", "-q", "--bare", bare);
    git(dataDir, "clone", "-q", bare, root);
    expect(fs.readdirSync(root)).toEqual([".git"]);
    expect(dataDirGuardRefusal(root, {})).toBeUndefined();
    loadPaddockConfig();
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(true);
  });

  it("claims a root holding only a freshly git-init'ed .git", () => {
    const root = path.join(dataDir, "projects");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    expect(dataDirGuardRefusal(root, {})).toBeUndefined();
  });

  it("refuses a .git-only root whose HEAD has content (a --no-checkout clone of a real repo)", () => {
    const src = path.join(dataDir, "src");
    fs.mkdirSync(src, { recursive: true });
    git(src, "init", "-q");
    fs.writeFileSync(path.join(src, "notes.md"), "real data\n");
    git(src, "add", "notes.md");
    git(src, "commit", "-q", "-m", "x");
    const root = path.join(dataDir, "projects");
    git(dataDir, "clone", "-q", "--no-checkout", src, root);
    expect(fs.readdirSync(root)).toEqual([".git"]);
    expect(dataDirGuardRefusal(root, {})).toMatch(/not empty/);
    claimProjectsRoot(root);
    expect(fs.existsSync(path.join(root, DATA_REPO_MARKER))).toBe(false);
  });

  it("refuses .git plus anything else without the marker", () => {
    const root = path.join(dataDir, "projects");
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q");
    fs.writeFileSync(path.join(root, "notes.txt"), "hi\n");
    expect(dataDirGuardRefusal(root, {})).toMatch(/not empty/);
  });

  it("createDataDir: false (config show) checks but never claims", () => {
    loadPaddockConfig({ createDataDir: false });
    expect(fs.existsSync(path.join(dataDir, "projects", DATA_REPO_MARKER))).toBe(false);
  });
});

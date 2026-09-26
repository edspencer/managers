/**
 * memory-store — semantic memory (plan §4): `memory/MEMORY.md` (a human preamble
 * above `<!-- managers:index -->`, a server-generated index below it),
 * `memory/facts/<name>.md` and `memory/playbooks/<name>.md`.
 *
 * Two scopes. The ROOT workspace's `memory/` is shared — it cascades into every
 * project (plan §2.2) — so a project's memory view is its own facts plus the
 * root's, each tagged `scope: "project" | "root"`. The root workspace itself has
 * only `root`.
 *
 * Reads only in M4; `memory_op` (M14) writes.
 */
import path from "node:path";
import { MEMORY_INDEX_MARKER, isName, type WorkspaceLayout } from "./layout.js";
import { parseFrontmatter } from "./frontmatter.js";
import { describeZodError, factReadSchema, type FactFrontmatter } from "./schemas.js";
import { FileCache, listNames, splitSections, type ParseError, type Parsed } from "./store-util.js";

export type MemoryScope = "root" | "project";

export interface MemoryIndex {
  scope: MemoryScope;
  file: string;
  /** Ed's text above the index marker (the whole file when there is no marker). */
  preamble: string;
  /** The generated index below the marker (`""` when absent). */
  index: string;
}

export interface FactSummary extends FactFrontmatter {
  scope: MemoryScope;
  file: string;
}

export interface FactDetail extends FactSummary {
  /** The body without its `## History` section. */
  body: string;
  /** `## History` bullet lines, without the leading `- `. */
  history: string[];
}

export interface PlaybookSummary {
  name: string;
  description: string | null;
  scope: MemoryScope;
  file: string;
}

export interface MemoryView {
  /** One per scope present, root last. `null` entries are scopes with no MEMORY.md. */
  indexes: Record<MemoryScope, MemoryIndex | null>;
  facts: FactSummary[];
  playbooks: PlaybookSummary[];
  parseErrors: (ParseError & { scope: MemoryScope })[];
}

interface ParsedFact {
  fm: FactFrontmatter;
  body: string;
  history: string[];
}

function parseFact(text: string, file: string): Parsed<ParsedFact> {
  const nameFromFile = path.basename(file, ".md");
  const doc = parseFrontmatter(text);
  if (!doc.hasFrontmatter) return { ok: false, error: "fact has no frontmatter" };
  const r = factReadSchema.safeParse({ name: nameFromFile, ...doc.data });
  if (!r.success) return { ok: false, error: describeZodError(r.error) };
  if (r.data.name !== nameFromFile) {
    return { ok: false, error: `frontmatter name ${r.data.name} does not match the file name ${nameFromFile}` };
  }
  const { preamble, sections } = splitSections(doc.body);
  const rest: string[] = [preamble];
  let history: string[] = [];
  for (const s of sections) {
    if (s.heading.trim().toLowerCase() === "history" && history.length === 0) {
      history = s.body
        .split("\n")
        .filter((l) => /^\s*[-*] /.test(l))
        .map((l) => l.replace(/^\s*[-*] /, "").trimEnd());
    } else rest.push(`## ${s.heading}\n${s.body}`);
  }
  return { ok: true, value: { fm: r.data, body: rest.filter(Boolean).join("\n\n"), history } };
}

function parseIndex(text: string): Parsed<{ preamble: string; index: string }> {
  const src = text.replace(/\r\n?/g, "\n");
  const at = src.indexOf(MEMORY_INDEX_MARKER);
  if (at === -1) return { ok: true, value: { preamble: src.trimEnd(), index: "" } };
  return {
    ok: true,
    value: {
      preamble: src.slice(0, at).trimEnd(),
      index: src.slice(at + MEMORY_INDEX_MARKER.length).replace(/^\n+/, "").trimEnd(),
    },
  };
}

function parsePlaybook(text: string, file: string): Parsed<{ description: string | null }> {
  try {
    const doc = parseFrontmatter(text);
    const d = doc.data.description;
    if (typeof d === "string" && d.trim()) return { ok: true, value: { description: d.trim() } };
    const h = /^#\s+(.+)$/m.exec(doc.body);
    return { ok: true, value: { description: h ? h[1]!.trim() : null } };
  } catch (err) {
    return { ok: false, error: `${path.basename(file)}: ${(err as Error).message}` };
  }
}

export class MemoryStore {
  private readonly facts = new FileCache<ParsedFact>(parseFact);
  private readonly indexes = new FileCache(parseIndex);
  private readonly playbooks = new FileCache(parsePlaybook);

  /**
   * The memory view for a workspace. `root` is the shared (projects-root)
   * layout; pass `project: null` for the root workspace itself.
   */
  async view(scopes: { project: WorkspaceLayout | null; root: WorkspaceLayout }): Promise<MemoryView> {
    const out: MemoryView = { indexes: { root: null, project: null }, facts: [], playbooks: [], parseErrors: [] };
    const pairs: [MemoryScope, WorkspaceLayout][] = [];
    if (scopes.project) pairs.push(["project", scopes.project]);
    pairs.push(["root", scopes.root]);
    for (const [scope, layout] of pairs) {
      const idx = await this.indexes.get(layout.memoryIndexFile);
      if (idx?.ok) out.indexes[scope] = { scope, file: layout.rel(layout.memoryIndexFile), ...idx.value };
      for (const name of await listNames(layout.factsDir, ".md")) {
        const abs = path.join(layout.factsDir, `${name}.md`);
        if (!isName(name)) {
          out.parseErrors.push({ scope, file: layout.rel(abs), error: "file name is not a valid fact name (kebab-case)" });
          continue;
        }
        const got = await this.facts.get(abs);
        if (!got) continue;
        if (!got.ok) out.parseErrors.push({ scope, file: layout.rel(abs), error: got.error });
        else out.facts.push({ ...got.value.fm, scope, file: layout.rel(abs) });
      }
      for (const name of await listNames(layout.playbooksDir, ".md")) {
        if (!isName(name)) continue;
        const abs = path.join(layout.playbooksDir, `${name}.md`);
        const got = await this.playbooks.get(abs);
        if (!got) continue;
        if (!got.ok) out.parseErrors.push({ scope, file: layout.rel(abs), error: got.error });
        else out.playbooks.push({ name, description: got.value.description, scope, file: layout.rel(abs) });
      }
    }
    return out;
  }

  /**
   * One fact. Without `scope`, the project's fact wins over a root fact of the
   * same name (the nearer memory is the more specific).
   */
  async getFact(
    scopes: { project: WorkspaceLayout | null; root: WorkspaceLayout },
    name: string,
    scope?: MemoryScope,
  ): Promise<FactDetail | { parseError: ParseError & { scope: MemoryScope } } | null> {
    const order: [MemoryScope, WorkspaceLayout][] = [];
    if (scopes.project && scope !== "root") order.push(["project", scopes.project]);
    if (scope !== "project") order.push(["root", scopes.root]);
    for (const [s, layout] of order) {
      const abs = layout.factFile(name);
      const got = await this.facts.get(abs);
      if (!got) continue;
      if (!got.ok) return { parseError: { scope: s, file: layout.rel(abs), error: got.error } };
      return { ...got.value.fm, scope: s, file: layout.rel(abs), body: got.value.body, history: got.value.history };
    }
    return null;
  }
}

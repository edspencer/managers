/**
 * objectives-store — `objectives/<slug>/objective.md` (plan §4).
 *
 * The frontmatter carries title/status/success/triggers/timestamps; the body is
 * three conventional sections — `## Where we are` (the rolling summary
 * `update_objective` rewrites), `## Strategy`, `## Lessons` — plus whatever else
 * a human added, which is preserved in `otherSections`.
 */
import { isName, type WorkspaceLayout } from "./layout.js";
import { parseFrontmatter } from "./frontmatter.js";
import { describeZodError, objectiveReadSchema, type ObjectiveFrontmatter } from "./schemas.js";
import { FileCache, readdirSafe, splitSections, type ParseError, type Parsed } from "./store-util.js";
import type { EpisodePage, EpisodesStore, PageOpts } from "./episodes-store.js";

export interface ObjectiveSummary extends ObjectiveFrontmatter {
  id: string;
  file: string;
}

export interface ObjectiveDetail extends ObjectiveSummary {
  preamble: string;
  whereWeAre: string;
  strategy: string;
  lessons: string;
  /** `[[name]]` fact links found in the Lessons section. */
  lessonLinks: string[];
  otherSections: { heading: string; body: string }[];
  journal: EpisodePage;
}

interface ParsedObjective {
  fm: ObjectiveFrontmatter;
  preamble: string;
  sections: { heading: string; body: string }[];
}

const KNOWN: Record<string, "whereWeAre" | "strategy" | "lessons"> = {
  "where we are": "whereWeAre",
  strategy: "strategy",
  lessons: "lessons",
};

function parseObjective(text: string, id: string): Parsed<ParsedObjective> {
  const doc = parseFrontmatter(text);
  if (!doc.hasFrontmatter) return { ok: false, error: "objective.md has no frontmatter" };
  const r = objectiveReadSchema.safeParse({ title: id, ...doc.data });
  if (!r.success) return { ok: false, error: describeZodError(r.error) };
  const { preamble, sections } = splitSections(doc.body);
  return { ok: true, value: { fm: r.data, preamble, sections } };
}

export class ObjectivesStore {
  private readonly cache = new Map<string, FileCache<ParsedObjective>>();

  constructor(private readonly episodes: EpisodesStore) {}

  private cacheFor(id: string): FileCache<ParsedObjective> {
    let c = this.cache.get(id);
    if (!c) {
      c = new FileCache((text) => parseObjective(text, id));
      this.cache.set(id, c);
    }
    return c;
  }

  async list(layout: WorkspaceLayout): Promise<{ objectives: ObjectiveSummary[]; parseErrors: ParseError[] }> {
    const objectives: ObjectiveSummary[] = [];
    const parseErrors: ParseError[] = [];
    for (const d of await readdirSafe(layout.objectivesDir)) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const dirRel = `objectives/${d.name}`;
      if (!isName(d.name)) {
        parseErrors.push({ file: dirRel, error: "directory name is not a valid objective id (kebab-case)" });
        continue;
      }
      const abs = layout.objectiveFile(d.name);
      const got = await this.cacheFor(d.name).get(abs);
      if (!got) {
        parseErrors.push({ file: `${dirRel}/objective.md`, error: "missing objective.md" });
        continue;
      }
      if (!got.ok) {
        parseErrors.push({ file: layout.rel(abs), error: got.error });
        continue;
      }
      objectives.push({ ...got.value.fm, id: d.name, file: layout.rel(abs) });
    }
    const rank = { active: 0, paused: 1, done: 2, retired: 3 } as const;
    objectives.sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
    return { objectives, parseErrors };
  }

  /**
   * One objective with its sections and a page of its journal. `null` when it
   * does not exist; `{ parseError }` when its file will not parse.
   */
  async get(
    layout: WorkspaceLayout,
    id: string,
    journal: PageOpts = {},
  ): Promise<ObjectiveDetail | { parseError: ParseError } | null> {
    const abs = layout.objectiveFile(id);
    const got = await this.cacheFor(id).get(abs);
    if (!got) return null;
    if (!got.ok) return { parseError: { file: layout.rel(abs), error: got.error } };
    const { fm, preamble, sections } = got.value;
    const known = { whereWeAre: "", strategy: "", lessons: "" };
    const otherSections: { heading: string; body: string }[] = [];
    for (const s of sections) {
      const k = KNOWN[s.heading.trim().toLowerCase()];
      if (k && !known[k]) known[k] = s.body;
      else otherSections.push(s);
    }
    const lessonLinks = [...known.lessons.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1]!);
    return {
      ...fm,
      id,
      file: layout.rel(abs),
      preamble,
      ...known,
      lessonLinks: [...new Set(lessonLinks)],
      otherSections,
      journal: await this.episodes.page(layout, id, journal),
    };
  }
}

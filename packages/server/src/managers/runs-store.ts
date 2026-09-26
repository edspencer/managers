/**
 * runs-store — `runs/YYYY-MM/<run-id>.yaml` (plan §4), the dead-man's-switch
 * records one per trigger fire (written from M6). Reads only in M4, paged by
 * month like the episodic log.
 */
import path from "node:path";
import YAML from "yaml";
import { MONTH_RE, isRunId, monthOfId, type WorkspaceLayout } from "./layout.js";
import { describeZodError, runReadSchema, type RunRecord } from "./schemas.js";
import { FileCache, listDirsDesc, listNames, type ParseError, type Parsed } from "./store-util.js";
import { pickMonths, type PageOpts } from "./episodes-store.js";

export interface RunSummary extends RunRecord {
  file: string;
}

export interface RunPage {
  /** Newest-started first. */
  runs: RunSummary[];
  months: string[];
  nextBefore: string | null;
  parseErrors: ParseError[];
}

export interface RunFilter extends PageOpts {
  trigger?: string;
  status?: RunRecord["status"];
}

function parseRun(text: string, file: string): Parsed<RunRecord> {
  const idFromName = path.basename(file, ".yaml");
  let data: unknown;
  try {
    data = YAML.parse(text, { schema: "core" });
  } catch (err) {
    return { ok: false, error: `YAML: ${(err as Error).message.split("\n")[0]}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "run record is not a YAML mapping" };
  }
  const r = runReadSchema.safeParse({ id: idFromName, ...(data as object) });
  if (!r.success) return { ok: false, error: describeZodError(r.error) };
  if (r.data.id !== idFromName) {
    return { ok: false, error: `id ${r.data.id} does not match the file name ${idFromName}` };
  }
  return { ok: true, value: r.data };
}

export class RunsStore {
  private readonly cache = new FileCache<RunRecord>(parseRun);

  async months(layout: WorkspaceLayout): Promise<string[]> {
    return listDirsDesc(layout.runsDir, MONTH_RE);
  }

  async list(layout: WorkspaceLayout, filter: RunFilter = {}): Promise<RunPage> {
    const { months, nextBefore } = pickMonths(await this.months(layout), filter);
    const runs: RunSummary[] = [];
    const parseErrors: ParseError[] = [];
    for (const m of months) {
      const dir = layout.runsMonthDir(m);
      for (const name of await listNames(dir, ".yaml")) {
        const abs = path.join(dir, `${name}.yaml`);
        const got = await this.cache.get(abs);
        if (!got) continue;
        if (!got.ok) {
          parseErrors.push({ file: layout.rel(abs), error: got.error });
          continue;
        }
        if (filter.trigger && got.value.trigger !== filter.trigger) continue;
        if (filter.status && got.value.status !== filter.status) continue;
        runs.push({ ...got.value, file: layout.rel(abs) });
      }
    }
    runs.sort((a, b) => (b.started ?? "").localeCompare(a.started ?? "") || b.id.localeCompare(a.id));
    return { runs, months, nextBefore, parseErrors };
  }

  /** One run by id: the month its id dates from first, then every other month. */
  async get(layout: WorkspaceLayout, id: string): Promise<RunSummary | { parseError: ParseError } | null> {
    if (!isRunId(id)) return null;
    const home = monthOfId(id);
    const months = await this.months(layout);
    for (const m of [...months.filter((x) => x === home), ...months.filter((x) => x !== home)]) {
      const abs = layout.runFile(m, id);
      const got = await this.cache.get(abs);
      if (!got) continue;
      if (!got.ok) return { parseError: { file: layout.rel(abs), error: got.error } };
      return { ...got.value, file: layout.rel(abs) };
    }
    return null;
  }
}

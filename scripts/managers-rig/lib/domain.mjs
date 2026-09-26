/**
 * lib/domain.mjs — render Managers domain-state fixtures (plan §4) as files.
 *
 * fixtures.mjs describes objectives, episodes, tasks, facts, runs and reports as
 * DATA with relative times (`daysAgo`); these helpers turn them into the exact
 * on-disk shapes the server's stores read, resolved against the seed clock. The
 * formats here must match `packages/server/src/managers/` — the M4 integration
 * test and the rig QA both read them back through the real API.
 */

const pad = (n) => String(n).padStart(2, "0");

/** A clock: `at(daysAgo, hh, mm)` is that many days before `now`, at hh:mm UTC. */
export function makeClock(now) {
  const at = (daysAgo, hh = 9, mm = 0) => {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    d.setUTCHours(hh, mm, 0, 0);
    return d;
  };
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const ymd = (d) => `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hm = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return {
    at,
    iso,
    date: (d) => d.toISOString().slice(0, 10),
    month: (d) => d.toISOString().slice(0, 7),
    taskId: (d, suffix) => `t-${ymd(d)}-${suffix}`,
    episodeId: (d, suffix) => `ep-${ymd(d)}-${hm(d)}-${suffix}`,
    runId: (d, suffix) => `r-${ymd(d)}-${hm(d)}-${suffix}`,
  };
}

/** YAML for one scalar/array/object, JSON-style (always valid YAML). */
const y = (v) => (v === null || v === undefined ? "null" : JSON.stringify(v));

function frontmatter(obj) {
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${y(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Render a list of episodes into `{ path: text }`, grouped into
 * `objectives/<obj>/journal/YYYY-MM.md` or `log/YYYY-MM.md` by date.
 * Each episode: `{ suffix, daysAgo, hh, mm, imp, objective?, run?, source?, tags?, text, refs? }`.
 */
export function renderEpisodes(clock, episodes) {
  const files = {};
  const sorted = [...episodes].sort((a, b) => b.daysAgo - a.daysAgo || (a.hh ?? 9) - (b.hh ?? 9));
  for (const e of sorted) {
    const d = clock.at(e.daysAgo, e.hh ?? 9, e.mm ?? 0);
    const m = clock.month(d);
    const file = e.objective ? `objectives/${e.objective}/journal/${m}.md` : `log/${m}.md`;
    const segs = [`${clock.date(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`, clock.episodeId(d, e.suffix), `imp ${e.imp}`];
    if (e.run) segs.push(`run ${e.run}`);
    if (e.source) segs.push(`source ${e.source}`);
    if (e.tags?.length) segs.push(e.tags.map((t) => `#${t}`).join(" "));
    const block = [`## ${segs.join(" · ")}`, e.text, ...(e.refs?.length ? [`refs: ${e.refs.join(", ")}`] : [])].join("\n");
    const title = e.objective ? `# Journal: ${e.objective}, ${m}` : `# Log, ${m}`;
    files[file] = files[file] ? `${files[file]}\n${block}\n` : `${title}\n\n${block}\n`;
  }
  return files;
}

/** `objectives/<id>/objective.md`. */
export function renderObjective(clock, o) {
  return {
    [`objectives/${o.id}/objective.md`]:
      frontmatter({
        title: o.title,
        status: o.status,
        success: o.success,
        triggers: o.triggers,
        created: clock.iso(clock.at(o.createdDaysAgo)),
        updated: clock.iso(clock.at(o.updatedDaysAgo ?? 0, 8)),
      }) +
      [
        "## Where we are",
        o.whereWeAre,
        "",
        "## Strategy",
        o.strategy,
        "",
        "## Lessons",
        ...(o.lessons ?? []).map((l) => `- ${l}`),
        "",
      ].join("\n"),
  };
}

/**
 * One task file. Open statuses go to `tasks/open/`; done/dropped to
 * `tasks/done/<month closed>/`. `{ suffix, createdDaysAgo, updatedDaysAgo, status, title, … }`.
 */
export function renderTask(clock, t) {
  const created = clock.at(t.createdDaysAgo, 8, 30);
  const updated = clock.at(t.updatedDaysAgo ?? t.createdDaysAgo, 9, 15);
  const id = clock.taskId(created, t.suffix);
  const closed = t.status === "done" || t.status === "dropped";
  const file = closed ? `tasks/done/${clock.month(updated)}/${id}.md` : `tasks/open/${id}.md`;
  const fm = frontmatter({
    id,
    title: t.title,
    status: t.status,
    objective: t.objective ?? null,
    source: t.source ?? "manager",
    ask: t.ask ?? null,
    options: t.options ?? [],
    answer: t.answer ? { by: "ed", at: clock.iso(updated), ...t.answer } : null,
    github: t.github ?? [],
    dispatched: [],
    shovel_ready: t.shovel_ready ?? false,
    due: t.dueInDays === undefined ? null : clock.date(clock.at(-t.dueInDays)),
    created: clock.iso(created),
    updated: clock.iso(updated),
  });
  const log = [`- ${clock.iso(created).slice(0, 16)}Z ${t.source ?? "manager"}: created, ${t.initialStatus ?? t.status}`];
  if (t.status !== (t.initialStatus ?? t.status)) log.push(`- ${clock.iso(updated).slice(0, 16)}Z manager: → ${t.status}`);
  return { [file]: `${fm}${t.notes ?? ""}\n\n## Log\n${log.join("\n")}\n` };
}

/** `memory/facts/<name>.md`. `evidence` entries are `{ daysAgo, hh, suffix }` episode refs. */
export function renderFact(clock, f) {
  return {
    [`memory/facts/${f.name}.md`]:
      frontmatter({
        name: f.name,
        description: f.description,
        type: f.type,
        since: clock.date(clock.at(f.sinceDaysAgo)),
        until: null,
        confidence: f.confidence,
        evidence: (f.evidence ?? []).map((e) => clock.episodeId(clock.at(e.daysAgo, e.hh ?? 9, e.mm ?? 0), e.suffix)),
      }) + `${f.body}\n\n## History\n- ${clock.date(clock.at(f.sinceDaysAgo))} created.\n`,
  };
}

/** `memory/MEMORY.md`: Ed's preamble, then the generated index below the marker. */
export function renderMemoryIndex(preamble, facts) {
  return {
    "memory/MEMORY.md": `${preamble}\n\n<!-- managers:index -->\n${facts.map((f) => `- [[${f.name}]]: ${f.description}`).join("\n")}\n`,
  };
}

/** `runs/<month>/<id>.yaml`. `{ suffix, daysAgo, hh, trigger, status, minutes, expect?, expectResult?, error?, … }`. */
export function renderRun(clock, r) {
  const started = clock.at(r.daysAgo, r.hh ?? 7, r.mm ?? 0);
  const id = clock.runId(started, r.suffix);
  const finished = r.status === "running" ? null : clock.iso(new Date(started.getTime() + (r.minutes ?? 5) * 60_000));
  const rec = {
    id,
    trigger: r.trigger,
    kind: r.kind ?? "wake",
    objective: r.objective ?? null,
    status: r.status,
    started: clock.iso(started),
    finished,
    sessionId: null,
    model: "claude-opus-5",
    usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 30000, cacheCreationTokens: 2000 },
    episodes: r.episodes ?? [],
    tasksTouched: r.tasksTouched ?? [],
    reports: [],
    artifacts: [],
    mcpCalls: r.mcpCalls ?? {},
    expect: r.expect ?? null,
    expectResult: r.expectResult ?? null,
    briefing: null,
    error: r.error ?? null,
  };
  return { [`runs/${clock.month(started)}/${id}.yaml`]: `${Object.entries(rec).map(([k, v]) => `${k}: ${y(v)}`).join("\n")}\n` };
}

/** Merge several `{ path: text }` maps (later wins). */
export const merge = (...maps) => Object.assign({}, ...maps);

/**
 * `reports/status/<date>.md` per entry, plus `current.md` = the newest one.
 * Each entry `{ daysAgo, body }`.
 */
export function renderReportsStatus(clock, entries) {
  const files = {};
  const sorted = [...entries].sort((a, b) => a.daysAgo - b.daysAgo);
  for (const e of sorted) {
    const d = clock.at(e.daysAgo, 7, 10);
    files[`reports/status/${clock.date(d)}.md`] = `${frontmatter({ type: "status", updated: clock.iso(d) })}# Status\n\n${e.body}\n`;
  }
  const newest = sorted[0];
  if (newest) {
    const d = clock.at(newest.daysAgo, 7, 10);
    files["reports/status/current.md"] = files[`reports/status/${clock.date(d)}.md`];
  }
  return files;
}

/**
 * fixtures.mjs — the synthetic world the Managers QA rig boots into.
 *
 * EVERYTHING HERE IS INVENTED: no real projects, people, hosts, repositories or
 * credentials. Screenshots of this rig end up in reports and PRs, so keep it that
 * way when you extend it.
 *
 * ── How to extend it (later milestones) ─────────────────────────────────────
 * `seed.mjs` is generic: it walks ROOT_WORKSPACE and PROJECTS and writes whatever
 * they describe. To add fixture state, add data here rather than code there:
 *
 *   • a new project           → append to PROJECTS (keep the three below; earlier
 *                               milestones' QA relies on them);
 *   • files in a project       → `files: { "path/under/project.md": "…" }` — this is
 *                               also how domain state (objectives/, tasks/, memory/,
 *                               reports/, runs/) gets seeded, as plain files;
 *   • extra project.yaml keys  → `yaml: { key: value }`, serialised as JSON-in-YAML
 *                               (always valid YAML), appended after the base keys;
 *   • triggers                 → `triggers` (+ `triggerPrompts` for promptFile ones);
 *   • chats                    → `chats: [{ label, prompt, reply, hoursAgo, … }]`;
 *   • Managers domain state    → `state: (clock) => ({ path: text })`, built with the
 *                               renderers in lib/domain.mjs from relative-time data
 *                               (M4: objectives + journals, tasks in every status,
 *                               facts, runs, reports). `clock` is makeClock(seed time).
 *
 * TIMES ARE RELATIVE. Every timestamp is expressed as `hoursAgo` / `daysAgo` and
 * resolved against the wall clock at seed time (or `--now`, which exists only for
 * screenshot determinism). Never hard-code a date: a rig whose "recent" chats are
 * three weeks old stops exercising anything time-sensitive.
 */

import {
  merge,
  renderEpisodes,
  renderFact,
  renderMemoryIndex,
  renderObjective,
  renderReportsStatus,
  renderRun,
  renderTask,
} from "./lib/domain.mjs";
import { makeIds } from "./lib/transcript.mjs";

// The session id seed.mjs gives a fixture chat (`<slug>:<label>`), so a run
// record can point at a seeded chat. Must match seed.mjs's makeIds namespace.
const rigIds = makeIds("managers-rig-v1");
const seededChatId = (slug, label) => rigIds.stableUuid(`chat:${slug}:${label}`);

// ── Managers domain state (M4) ──────────────────────────────────────────────
// Home's SHARED memory: two facts every project's manager sees (scope: root).
const ROOT_FACTS = [
  {
    name: "house-style",
    description: "Ed prefers short, plain sentences and one idea per paragraph.",
    type: "feedback",
    sinceDaysAgo: 50,
    confidence: "high",
    body: "Applies to every report, post draft and task ask. Long preambles get skipped.",
  },
  {
    name: "weekend-quiet",
    description: "Nothing needs Ed's decision on a weekend; batch asks for Monday.",
    type: "user",
    sinceDaysAgo: 30,
    confidence: "medium",
    body: "Stated in a Home chat. Urgent breakage is the exception.",
  },
];

// acme-site: two objectives, 25 journal entries over 40 days, a project log,
// tasks in EVERY status (two awaiting-ed), two facts, four runs (one failed, one
// whose expected artifact went missing) and a status report.
const ACME_JOURNAL = [
  // blog-cadence: 16 entries
  [40, 9, "aa", 5, ["kickoff"], "Set the objective: one post a week for eight weeks. Drafted a list of twelve topics."],
  [38, 10, "ab", 3, ["drafting"], "First draft of the launch retrospective post is ready for review."],
  [36, 9, "ac", 4, ["review"], "Review round one came back with two structural notes; revised."],
  [34, 14, "ad", 6, ["published"], "Published the launch retrospective. First week of the cadence met."],
  [31, 9, "ae", 2, ["drafting"], "Started the pricing-philosophy post; blocked on the pricing rewrite."],
  [29, 11, "af", 5, ["published"], "Published a shorter post on the new footer instead. Week two met."],
  [27, 9, "ag", 3, ["topics"], "Pruned the topic list to nine; three were duplicates of existing pages."],
  [24, 16, "ah", 7, ["missed"], "Week three missed: the draft stalled in review for five days."],
  [22, 9, "ai", 4, ["process"], "Proposed a two-day review window to stop drafts stalling.", ["t-REVIEW"]],
  [20, 10, "aj", 5, ["published"], "Published the careers-page post. Back on cadence."],
  [17, 9, "ak", 3, ["drafting"], "Drafted the hardware-teardown post outline."],
  [15, 13, "al", 6, ["published"], "Published the teardown post; it is the most-read post so far."],
  [12, 9, "am", 2, ["topics"], "Added two reader-suggested topics to the list."],
  [8, 10, "an", 5, ["published"], "Published the shipping-times post. Week seven met."],
  [4, 9, "ao", 4, ["drafting"], "Final post of the eight is in draft; asked Ed to pick between two titles.", ["t-TITLE"]],
  [1, 7, "ap", 3, ["wake"], "Morning wake: nothing new overnight; the title decision is still open."],
  // pricing-rewrite: 9 entries
  [39, 15, "ba", 6, ["kickoff"], "Set the objective: a pricing page a visitor understands in ten seconds."],
  [35, 9, "bb", 4, ["research"], "Collected five competitor pricing pages for comparison."],
  [32, 11, "bc", 5, ["copy"], "Wrote three headline options; Ed picked the shortest."],
  [28, 9, "bd", 3, ["blocked"], "Blocked: the enterprise tier price is not decided."],
  [23, 10, "be", 6, ["copy"], "Rewrote the tier table; cut it from seven rows to four."],
  [18, 9, "bf", 4, ["review"], "Review from sales: keep the annual-discount line."],
  [13, 14, "bg", 7, ["shipped"], "Shipped the new headline and tier table to the live site."],
  [9, 9, "bh", 5, ["metrics"], "First week after the rewrite: fewer pricing questions in support."],
  [3, 11, "bi", 4, ["followup"], "Enterprise price still undecided; the task is awaiting Ed.", ["t-ENTERPRISE"]],
];

const ACME_TASKS = [
  { key: "t-TITLE", suffix: "t1tl", createdDaysAgo: 4, status: "awaiting-ed", objective: "blog-cadence", title: "Pick the title for the final cadence post", ask: "Which title for the eighth post?", options: ["Eight weeks of posts", "What we learned shipping weekly"], notes: "Both are under eight words. The second tested better with two readers." },
  { key: "t-ENTERPRISE", suffix: "entp", createdDaysAgo: 28, updatedDaysAgo: 3, status: "awaiting-ed", initialStatus: "blocked", objective: "pricing-rewrite", title: "Decide the enterprise tier price", ask: "Publish the enterprise tier as 'Contact us', or with a price?", options: ["contact-us", "show-price"], notes: "Sales prefers 'Contact us'. The rewrite is otherwise done." },
  { key: "t-REVIEW", suffix: "rvw2", createdDaysAgo: 22, updatedDaysAgo: 2, status: "doing", objective: "blog-cadence", title: "Adopt a two-day review window for drafts", notes: "Trialling it on the final post." },
  { suffix: "tpcs", createdDaysAgo: 12, status: "open", objective: "blog-cadence", title: "Turn the reader-suggested topics into outlines", shovel_ready: true, dueInDays: 5 },
  { suffix: "imgs", createdDaysAgo: 10, updatedDaysAgo: 6, status: "blocked", title: "Replace the stock photos on the about page", notes: "Waiting for the photo shoot to be scheduled." },
  { suffix: "hdln", createdDaysAgo: 32, updatedDaysAgo: 13, status: "done", objective: "pricing-rewrite", title: "Ship the new pricing headline", answer: { choice: "Pay for what you ship" } },
  { suffix: "ftr1", createdDaysAgo: 37, updatedDaysAgo: 33, status: "dropped", title: "Redesign the footer", notes: "Dropped: the broken-link fix was enough." },
];
// M12: what the manager saw on the failed morning-check run (its briefing file).
const ACME_FAILED_BRIEFING = [
  "# Wake briefing: Acme Site (morning-check)",
  "",
  "## Protocol",
  "Read the briefing, do one useful thing toward the bound objective, record an episode.",
  "",
  "## Objective: blog-cadence",
  "Seven of eight weeks met (week three missed). The final post is in draft, waiting on a title.",
  "",
  "## Open tasks",
  "- awaiting-ed: Pick the title for the final cadence post",
  "- awaiting-ed: Decide the enterprise tier price",
  "",
].join("\n");

const acmeTaskIds = (clock) =>
  Object.fromEntries(ACME_TASKS.filter((t) => t.key).map((t) => [t.key, clock.taskId(clock.at(t.createdDaysAgo, 8, 30), t.suffix)]));

function acmeDomain(clock) {
  const ids = acmeTaskIds(clock);
  // M11: the wake run links the seeded "morning" chat, so a journal entry's run
  // link has a chat to open.
  const wakeRun = { daysAgo: 1, hh: 7, suffix: "wk", sessionId: seededChatId("acme-site", "morning") };
  const wakeRunId = clock.runId(clock.at(wakeRun.daysAgo, wakeRun.hh), wakeRun.suffix);
  const episodes = ACME_JOURNAL.map(([daysAgo, hh, suffix, imp, tags, text, refs]) => ({
    daysAgo,
    hh,
    suffix,
    imp,
    tags,
    text,
    objective: suffix.startsWith("a") ? "blog-cadence" : "pricing-rewrite",
    refs: (refs ?? []).map((r) => ids[r] ?? r),
    run: suffix === "ap" ? wakeRunId : undefined,
  }));
  // M6: publish-check's last MET run was four days ago, so its 48h window has
  // lapsed and it shows as `stale:publish-check` until it is run again.
  const publishRun = { daysAgo: 4, hh: 6, suffix: "pc" };
  const publishRunId = clock.runId(clock.at(publishRun.daysAgo, publishRun.hh), publishRun.suffix);
  const log = [
    { daysAgo: 4, hh: 6, mm: 1, suffix: "pc", imp: 2, tags: ["publish-check"], run: publishRunId, text: "Publish check: the shipping-times post is live and indexed." },
    { daysAgo: 26, hh: 12, suffix: "ca", imp: 3, tags: ["site"], text: "Fixed the broken careers-page footer link found by the link check." },
    { daysAgo: 11, hh: 9, suffix: "cb", imp: 2, tags: ["site"], text: "Link check: every link resolves." },
    { daysAgo: 2, hh: 18, suffix: "cc", imp: 4, tags: ["answer"], source: "ed", text: "Ed: keep the two-day review window going for the final post." },
  ];
  const facts = [
    {
      name: "reviews-stall-drafts",
      description: "Drafts stall when review has no deadline; a two-day window keeps the cadence.",
      type: "pattern",
      sinceDaysAgo: 22,
      confidence: "medium",
      evidence: [{ daysAgo: 24, hh: 16, suffix: "ah" }, { daysAgo: 22, hh: 9, suffix: "ai" }],
      body: "Seen twice in the blog cadence. The review window is being trialled.",
    },
    {
      name: "pricing-owner",
      description: "Sales owns the enterprise tier; marketing owns the rest of the pricing page.",
      type: "project",
      sinceDaysAgo: 35,
      confidence: "high",
      // M12: one entry in an OLDER journal month (the chip pages the objective back to
      // it) and one id that resolves nowhere (shown struck through).
      evidence: [{ daysAgo: 35, hh: 9, suffix: "bb" }, "ep-200101-0000-zz"],
      body: "Decisions about enterprise pricing go to Ed, who confirms with sales.",
    },
  ];
  return merge(
    renderObjective(clock, {
      id: "blog-cadence",
      title: "Publish one blog post a week for eight weeks",
      status: "active",
      success: "Eight posts published in eight consecutive weeks.",
      triggers: ["morning-check"],
      createdDaysAgo: 40,
      updatedDaysAgo: 1,
      whereWeAre: "Seven of eight weeks met (week three missed). The final post is in draft, waiting on a title.",
      strategy: "Short posts over long ones. Draft early in the week; review within two days.",
      lessons: ["[[reviews-stall-drafts]]"],
    }),
    renderObjective(clock, {
      id: "pricing-rewrite",
      title: "Rewrite the pricing page",
      status: "active",
      success: "A visitor can tell which tier fits them within ten seconds.",
      createdDaysAgo: 39,
      updatedDaysAgo: 3,
      whereWeAre: "Headline and tier table shipped. Only the enterprise price is undecided.",
      strategy: "Fewer rows, plain words, one call to action per tier.",
      lessons: ["[[pricing-owner]]"],
    }),
    renderObjective(clock, {
      id: "fix-broken-links",
      title: "No broken links on the site",
      status: "done",
      success: "The weekly link check reports zero broken links.",
      createdDaysAgo: 45,
      updatedDaysAgo: 11,
      whereWeAre: "Done: two link checks in a row came back clean.",
      strategy: "Weekly scheduled link check.",
    }),
    renderEpisodes(clock, [...episodes, ...log]),
    ...ACME_TASKS.map((t) => renderTask(clock, t)),
    ...facts.map((f) => renderFact(clock, f)),
    renderMemoryIndex("# Acme Site memory\n\nWhat the Acme Site manager has learned.", facts),
    // M14: the consolidation run's prompt (behaviours.consolidate-memory.config.promptFile).
    // It cites two REAL seeded journal entries, so the pattern it adds is valid; the
    // one-evidence variant is the unhappy path (copy it over consolidate.md).
    {
      ".managers/triggers/consolidate.md": [
        "# Consolidation",
        "",
        "Turn recent journal entries into facts.",
        "",
        `[[MCP managers.memory_op {"op":"add","name":"qa-pattern","type":"pattern","description":"Short posts get published on time; long ones stall.","evidence":["${clock.episodeId(clock.at(29, 11), "af")}","${clock.episodeId(clock.at(20, 10), "aj")}"],"confidence":"medium"}]]`,
      ].join("\n"),
      ".managers/triggers/consolidate-one-evidence.md": [
        "# Consolidation (unhappy path: a pattern with ONE evidence id)",
        "",
        `[[MCP managers.memory_op {"op":"add","name":"qa-one-evidence","type":"pattern","description":"This must not be written.","evidence":["${clock.episodeId(clock.at(29, 11), "af")}"]}]]`,
      ].join("\n"),
    },
    renderRun(clock, { ...wakeRun, trigger: "morning-check", status: "succeeded", minutes: 4, objective: "blog-cadence", expect: { kind: "episode", within: "48h" }, expectResult: "met", episodes: [clock.episodeId(clock.at(1, 7), "ap")] }),
    // M12: the failed run keeps its briefing, so the run drawer's "What the manager saw" has text.
    renderRun(clock, { daysAgo: 2, hh: 7, suffix: "fl", trigger: "morning-check", status: "failed", minutes: 1, error: "Turn ended early: the model returned an error.", expect: { kind: "episode", within: "48h" }, expectResult: "missing", briefing: ACME_FAILED_BRIEFING }),
    renderRun(clock, { daysAgo: 3, hh: 7, suffix: "ms", trigger: "morning-check", status: "succeeded", minutes: 3, expect: { kind: "report", report: "status" }, expectResult: "missing" }),
    renderRun(clock, { ...publishRun, trigger: "publish-check", status: "succeeded", minutes: 2, expect: { kind: "episode", within: "48h" }, expectResult: "met", episodes: [clock.episodeId(clock.at(4, 6, 1), "pc")] }),
    renderRun(clock, { daysAgo: 34, hh: 7, suffix: "ol", trigger: "morning-check", status: "succeeded", minutes: 6, expectResult: "n/a", mcpCalls: { paddock: { list_chats: 1 } } }),
    renderReportsStatus(clock, [
      // M12: the stored Needs you/Alerts are what the server wrote THEN; Home re-renders both live.
      { daysAgo: 0, body: "## Needs you\n- Pick the final post's title.\n- Decide the enterprise tier price.\n\n## Alerts\n- None.\n\n## In flight\n- Blog cadence: the final post is in draft, waiting on a title.\n- Pricing rewrite: shipped except the enterprise tier.\n\n## Notes\n- Seven of eight blog weeks met." },
      { daysAgo: 1, body: "Seven of eight blog weeks met. The final post is in draft." },
    ]),
  );
}

function widgetDomain(clock) {
  const t = clock.taskId(clock.at(1, 8, 30), "rn88");
  return merge(
    renderObjective(clock, {
      id: "burn-down-issues",
      title: "Get the open issue count under 40",
      status: "active",
      success: "Fewer than 40 open issues for two consecutive weeks.",
      createdDaysAgo: 20,
      updatedDaysAgo: 1,
      whereWeAre: "56 open issues, down from 71. Date-picker bugs are most of the rest.",
      strategy: "Close duplicates first, then batch the date-picker fixes into 2.4.1.",
    }),
    renderEpisodes(clock, [
      { daysAgo: 20, hh: 9, suffix: "da", imp: 5, objective: "burn-down-issues", tags: ["kickoff"], text: "Set the objective: under 40 open issues." },
      { daysAgo: 6, hh: 10, suffix: "db", imp: 4, objective: "burn-down-issues", tags: ["triage"], text: "Closed nine duplicates.", refs: ["widget-lib#401", "widget-lib#402"] },
      { daysAgo: 1, hh: 7, suffix: "dc", imp: 6, objective: "burn-down-issues", tags: ["dispatch", "issues"], text: "Asked Ed whether to merge the renovate major bump.", refs: ["widget-lib#88", t] },
    ]),
    renderTask(clock, {
      suffix: "rn88",
      createdDaysAgo: 1,
      status: "awaiting-ed",
      objective: "burn-down-issues",
      title: "Decide whether to merge renovate bump #88",
      ask: "Renovate #88 bumps a major version; merge?",
      options: ["merge", "skip"],
      github: ["widget-lib#88"],
    }),
    // M13: a status report three days old, so Home's Needs you shows its
    // "Status report 3d old" hint (acme-site's is fresh).
    renderReportsStatus(clock, [
      { daysAgo: 3, body: "## In flight\n- Burn-down: 56 open issues; the renovate bump waits on Ed.\n\n## Notes\n- Date-picker fixes are batched for 2.4.1." },
    ]),
    // A deliberately MALFORMED task (unknown status): the parseError fixture. The
    // list must skip it and report it, never fail.
    {
      [`tasks/open/${clock.taskId(clock.at(2, 8, 30), "bad0")}.md`]: `---\nid: ${clock.taskId(clock.at(2, 8, 30), "bad0")}\ntitle: A hand edit gone wrong\nstatus: someday\n---\nThis file is broken on purpose (M4 parseError fixture).\n`,
    },
  );
}

function homeDomain(clock) {
  return merge(
    ...ROOT_FACTS.map((f) => renderFact(clock, f)),
    renderMemoryIndex("# Shared memory\n\nApplies to every project's manager.", ROOT_FACTS),
    renderTask(clock, {
      suffix: "home",
      createdDaysAgo: 2,
      status: "awaiting-ed",
      title: "Choose which project gets this week's review slot",
      ask: "Acme Site or Widget Lib first this week?",
      options: ["acme-site", "widget-lib"],
    }),
  );
}

export const ROOT_WORKSPACE = {
  name: "Home",
  status: "active",
  startedDaysAgo: 60,
  summary: "The Managers home: cross-project coordination and anything not yet a project.",
  state: homeDomain,
  // M8: Home DEFINES behaviours for every project. Its own `enabled` would apply to
  // Home only, so none is set: every project starts with this OFF.
  yaml: {
    behaviours: {
      "triage-external-prs": {
        description: "Triage PRs from outside contributors by dispatching templated work to Paddock.",
        triggers: ["triage-prs"],
        tools: ["mcp__paddock__create_chat"],
        instructions: "Name the PR by number only; never paste PR content into a prompt.",
      },
    },
  },
  files: {
    "OVERVIEW.md": [
      "# Home",
      "",
      "The root workspace of this synthetic Managers rig. Cross-project notes and",
      "one-off questions live here; each project below has its own manager.",
    ].join("\n"),
    "CHANGELOG.md": ["# Changelog — Home", "", "## Recent", "- Seeded the QA rig."].join("\n"),
    "CLAUDE.md": [
      "# Home (applies to every manager)",
      "",
      "This is a synthetic QA fixture. Nothing here refers to a real project.",
    ].join("\n"),
  },
  chats: [
    {
      label: "weekly-plan",
      prompt: "Which project needs attention first this week?",
      reply:
        "Widget Lib. Its issue queue has grown for three weeks running while Acme Site is steady, and Empty Project has not started yet.",
      hoursAgo: 5,
      unread: true,
    },
  ],
};

export const PROJECTS = [
  {
    slug: "acme-site",
    name: "Acme Site",
    status: "active",
    group: "web",
    domain: ["website", "marketing"],
    startedDaysAgo: 45,
    summary: "The marketing site for a fictional hardware company: copy, pages and launch posts.",
    state: acmeDomain,
    // M10: the built-in `status` report type, left UNSCHEDULED (no `enabled`), with
    // a prompt file so "Refresh now" has something for the fake claude to do: it
    // calls write_report, including a model-written "Needs you" the server drops.
    yaml: {
      reports: {
        status: { promptFile: "status-report.md" },
      },
      // M14: consolidation ships OFF (no `enabled`); only its prompt file is set, so
      // "Run consolidation now" has something for the fake claude to do once Ed
      // switches it on in Settings → Behaviours.
      behaviours: {
        "consolidate-memory": { config: { promptFile: "consolidate.md" } },
      },
    },
    files: {
      "OVERVIEW.md": [
        "# Acme Site — Overview",
        "",
        "A small static marketing site. The launch page is live; the pricing page",
        "is being rewritten and the blog needs a regular cadence.",
      ].join("\n"),
      "CHANGELOG.md": [
        "# Changelog — Acme Site",
        "",
        "## Recent",
        "- Rewrote the pricing page headline.",
        "- Fixed the broken footer link on the careers page.",
      ].join("\n"),
    },
    triggers: {
      "morning-check": {
        trigger: { type: "schedule", cron: "0 7 * * *" },
        run: { promptFile: "morning-check.md", session: "new", maxTurns: 20 },
        enabled: false,
      },
      // M6: an ENABLED trigger with an expectation, so the dead-man's switch has
      // something to watch. The cron (03:00 on 1 January) never fires during QA;
      // "Run now" is how it is exercised. Its prompt records one episode.
      "publish-check": {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: {
          prompt:
            'Publish check. [[MCP managers.record_episode {"text":"Publish check: the latest post is live.","importance":3,"tags":["publish-check"]}]]',
          session: "new",
          expect: { kind: "episode", within: "48h" },
        },
        enabled: true,
      },
      // M7: the wake briefing. A schedule trigger is briefed by default, so Run now
      // sends the briefing wrapped around this body; `[[TOOL]]` gives the chat a
      // tool call to render. Disabled: QA fires it by hand.
      wake: {
        trigger: { type: "schedule", cron: "0 7 * * *" },
        run: { prompt: "Wake. [[TOOL]]", session: "new" },
        enabled: false,
      },
      // M14 gate: a WAKE calling memory_op is refused ("not available in this
      // turn") — memory is edited only while Ed is present or in a consolidation run.
      "memory-wake": {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: {
          prompt: 'Wake, and try to write memory. [[MCP managers.memory_op {"op":"add","name":"from-a-wake","type":"user","description":"This must not be written."}]]',
          session: "new",
        },
        enabled: false,
      },
      // M10 unhappy path: a report of a type this project does not have. The
      // tool call errors and nothing is written. Disabled: QA fires it by hand.
      "bogus-report": {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: {
          prompt: 'Write a bogus report. [[MCP managers.write_report {"type":"bogus","body":"## Notes\\n- this must not be written"}]]',
          session: "new",
        },
        enabled: false,
      },
    },
    triggerPrompts: {
      // M10: the status report run's prompt (reports.status.promptFile).
      "status-report.md": [
        "# Status report",
        "",
        "Write the status report from the briefing.",
        "",
        '[[MCP managers.write_report {"type":"status","body":"## Needs you\\n- (the model\'s own list; the server replaces it)\\n\\n## In flight\\n- Pricing rewrite: the copy is done; the enterprise price waits on Ed.\\n- Blog cadence: post seven is drafted, post eight needs a title.\\n- Next scheduled: publish-check (armed).\\n\\n## Notes\\n- The publish check has not had a met run inside its window."}]]',
      ].join("\n"),
      "morning-check.md": [
        "# Morning check",
        "",
        "List anything on the site that changed overnight and flag broken links.",
      ].join("\n"),
    },
    chats: [
      {
        label: "pricing",
        prompt: "Tighten the pricing page headline.",
        reply:
          "Done. The headline is now \"Pay for what you ship\" — six words instead of fourteen, and it keeps the one claim the page can back up.",
        hoursAgo: 3,
        durationMin: 4,
      },
      {
        label: "links",
        prompt: "Check the site for broken links.",
        reply: "One broken link: the careers page footer pointed at a retired jobs board. I've repointed it to /careers.",
        hoursAgo: 28,
        unread: true,
        tool: {
          name: "Grep",
          input: { pattern: "jobs\\.example\\.invalid", output_mode: "content", "-n": true },
          content: "pages/careers.md:41:  [Open roles](https://jobs.example.invalid/acme)",
        },
      },
      {
        label: "morning",
        prompt: "List anything on the site that changed overnight and flag broken links.",
        reply: "Nothing changed overnight and every link resolves.",
        hoursAgo: 9,
        durationMin: 2,
        origin: "scheduled",
        schedule: "morning-check",
      },
    ],
  },
  {
    slug: "widget-lib",
    name: "Widget Lib",
    status: "active",
    group: "libraries",
    domain: ["library", "open-source"],
    startedDaysAgo: 120,
    summary: "A fictional open-source UI widget library with a growing issue queue.",
    state: widgetDomain,
    // M8: a project-defined behaviour (off), beside the one inherited from Home.
    yaml: {
      behaviours: {
        "draft-release-notes": {
          description: "Draft the monthly release notes as a task for Ed to review.",
          instructions: "Draft only; never publish.",
        },
      },
      // M9: this project's Paddock connection — the rig's fake Paddock /mcp
      // (serve.mjs), authenticated by MANAGERS_MCP_PADDOCK_WIDGET_LIB (set by rigEnv
      // to the synthetic "Bearer rig-token"). The url is an env ref too, because
      // the fake's port is only known when serve.mjs starts it.
      mcp: {
        paddock: {
          url: "env:MANAGERS_RIG_PADDOCK_URL",
          headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_WIDGET_LIB" },
          tools: ["list_projects", "list_chats", "create_chat", "read_chat"],
          description: "This project's Paddock deployment (the rig's fake)",
        },
      },
    },
    // M8: an ENABLED trigger bound to Home's triage-external-prs, which is OFF here —
    // so it is not armed and "Run now" is refused until Ed switches it on. The cron
    // (03:00 on 1 January) never fires during QA.
    triggers: {
      "triage-prs": {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: {
          prompt: "Triage external PRs. [[TOOL]]",
          session: "new",
          behaviour: "triage-external-prs",
        },
        enabled: true,
      },
      // M13: an ENABLED wake (its cron, 03:00 on 1 January, never fires during QA),
      // so answering widget-lib's ask with "Wake the manager now" from Home's Needs
      // you really fires a run. Its prompt records one episode on the objective.
      wake: {
        trigger: { type: "schedule", cron: "0 3 1 1 *" },
        run: {
          prompt:
            'Wake: pick up Ed\'s answers. [[MCP managers.record_episode {"text":"Woke on Ed\'s answer and picked up the renovate decision.","importance":4,"tags":["wake"],"objective":"burn-down-issues"}]]',
          session: "new",
        },
        enabled: true,
      },
      // M9: Run-now QA of a real call on the paddock connection. Disabled (it never
      // fires on its own); unscoped, so it runs as the keeper with the connection.
      // create_chat is ALSO a tool of Home's triage-external-prs behaviour, which is
      // OFF here — so it is denied until Ed switches that behaviour on.
      "paddock-dispatch": {
        trigger: { type: "schedule", cron: "0 4 1 1 *" },
        run: {
          prompt: 'Dispatch. [[MCP paddock.list_projects {}]] [[MCP paddock.create_chat {"project":"demo","prompt":"triage #12"}]]',
          session: "new",
        },
        enabled: false,
      },
    },
    files: {
      "OVERVIEW.md": [
        "# Widget Lib — Overview",
        "",
        "An open-source widget library. Releases are monthly; the issue queue is",
        "the main source of work and has been growing.",
      ].join("\n"),
      "CHANGELOG.md": [
        "# Changelog — Widget Lib",
        "",
        "## Recent",
        "- Triaged twelve new issues.",
        "- Released 2.4.0 with the new date picker.",
      ].join("\n"),
    },
    chats: [
      {
        label: "triage",
        prompt: "Summarise this week's new issues.",
        reply:
          "Nine new issues: four are date-picker edge cases from the 2.4.0 release, three are docs requests, and two are duplicates I have linked.",
        hoursAgo: 20,
        durationMin: 5,
      },
      {
        label: "release",
        prompt: "Draft the 2.4.1 release notes.",
        reply: "Draft ready: three date-picker fixes, one accessibility fix for keyboard focus, and a docs typo.",
        hoursAgo: 50,
      },
    ],
  },
  {
    // Deliberately bare: no chats, no triggers, only the project.yaml. Every
    // milestone's empty-state QA runs against this project.
    slug: "empty-project",
    name: "Empty Project",
    status: "idea",
    startedDaysAgo: 2,
    summary: "A project with nothing in it yet (the empty-state fixture).",
    chats: [],
  },
  {
    // M9 unhappy path: a Paddock connection whose token variable is NOT set.
    slug: "broken-conn",
    name: "Broken Conn",
    status: "active",
    startedDaysAgo: 5,
    summary: "A project whose Paddock connection is missing its token (M9 fixture).",
    yaml: {
      mcp: {
        paddock: {
          url: "env:MANAGERS_RIG_PADDOCK_URL",
          headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_BROKEN_CONN" },
          description: "Paddock, but the token was never set",
        },
      },
    },
    chats: [],
  },
  {
    // M9 unhappy path: a Paddock connection with the WRONG (synthetic) token.
    slug: "wrong-token",
    name: "Wrong Token",
    status: "active",
    startedDaysAgo: 4,
    summary: "A project whose Paddock connection has a token the server rejects (M9 fixture).",
    yaml: {
      mcp: {
        paddock: {
          url: "env:MANAGERS_RIG_PADDOCK_URL",
          headers: { Authorization: "env:MANAGERS_MCP_PADDOCK_WRONG_TOKEN" },
          description: "Paddock, with a stale token",
        },
      },
    },
    chats: [],
  },
];

/**
 * Replies for the fake `claude` binary, keyed by exact prompt. A prompt that isn't
 * here gets the fake's default "Acknowledged: <prompt>" echo, which is what most
 * QA wants anyway.
 */
export const FAKE_SCRIPT = {
  "Which project needs attention first this week?": ROOT_WORKSPACE.chats[0].reply,
};

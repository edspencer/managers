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
 *   • chats                    → `chats: [{ label, prompt, reply, hoursAgo, … }]`.
 *
 * TIMES ARE RELATIVE. Every timestamp is expressed as `hoursAgo` / `daysAgo` and
 * resolved against the wall clock at seed time (or `--now`, which exists only for
 * screenshot determinism). Never hard-code a date: a rig whose "recent" chats are
 * three weeks old stops exercising anything time-sensitive.
 */

export const ROOT_WORKSPACE = {
  name: "Home",
  status: "active",
  startedDaysAgo: 60,
  summary: "The Managers home: cross-project coordination and anything not yet a project.",
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
    },
    triggerPrompts: {
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
];

/**
 * Replies for the fake `claude` binary, keyed by exact prompt. A prompt that isn't
 * here gets the fake's default "Acknowledged: <prompt>" echo, which is what most
 * QA wants anyway.
 */
export const FAKE_SCRIPT = {
  "Which project needs attention first this week?": ROOT_WORKSPACE.chats[0].reply,
};

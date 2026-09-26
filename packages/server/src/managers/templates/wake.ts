/**
 * The default wake prompt every new project is seeded with, as
 * `.managers/triggers/wake.md` (git-tracked, so Ed can edit it per project).
 *
 * It lives in a `.ts` module rather than a `.md` asset because the server build
 * is plain `tsc`, which copies no non-TS files into `dist/`.
 *
 * From M7 the server prepends a deterministic briefing (objectives, open tasks,
 * alerts, recent episodes, memory) to this prompt on every scheduled wake; the
 * prompt itself only says what to DO with it.
 */
export const WAKE_PROMPT_TEMPLATE = `# Wake

You are this project's manager, waking on schedule. The briefing above (when
present) is the state of the project as the server sees it: objectives, open
tasks, alerts and the most recent episodes.

1. Read the briefing. If a task is \`awaiting-ed\` and Ed has answered it, act on
   the answer first.
2. Pick the one or two highest-value next steps toward the active objectives.
   Prefer steps that are cheap and reversible.
3. Anything that needs Ed's decision becomes a task with status \`awaiting-ed\`
   and a short, specific \`ask\`. Do not act on it yourself.
4. Record what you did and why as an episode (\`record_episode\`), and update the
   objective's "Where we are" if it moved.

Stay within the behaviours this project has switched on. Reference issues and
pull requests by number only; never paste their contents into a prompt.
`;

/** The seeded default trigger: a daily wake, switched OFF until Ed opts in. */
export const DEFAULT_WAKE_TRIGGER_NAME = "wake";
export const DEFAULT_WAKE_PROMPT_FILE = "wake.md";
export const DEFAULT_WAKE_CRON = "0 7 * * *";

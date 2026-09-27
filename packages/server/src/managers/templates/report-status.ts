/**
 * The report prompts (M10). A derived `report-<type>` trigger runs one of these
 * unless its report config names a `promptFile` (a `.managers/triggers/*.md`
 * file, read fresh at fire time, falling back to the template when unreadable).
 *
 * They live in a `.ts` module rather than `.md` assets for the same reason as
 * `wake.ts`: the server build is plain `tsc`, which copies no non-TS files.
 *
 * The server prepends a `report` briefing (the standard sections plus the
 * schedule, the previous report and what changed since it), and renders the
 * report's "Needs you" and "Alerts" sections itself at write time, so the model
 * is told to leave them out.
 */
export const STATUS_REPORT_TEMPLATE = `# Status report

You are writing this project's **status report**: what you, its manager, are
working on and what is in flight. The briefing above holds everything you need:
objectives, open tasks, recent runs, the schedule, the previous report and what
changed since it.

Write the report with ONE call to \`write_report\` (type \`status\`), in Markdown,
with exactly these two sections:

## In flight
- Chats you dispatched and work you are waiting on (reference issues, pull
  requests and chats by number or id only).
- Open work, most important first, one line each.
- The next scheduled wakes, from the briefing's Schedule section.

## Notes
- What changed since the previous report.
- Anything else Ed should know that is not a decision.

Do NOT write "Needs you" or "Alerts" sections: the server renders both from the
awaiting-ed tasks and the alerts when you call \`write_report\`, so they are always
there and always current. This is a reporting run: do not create tasks, record
episodes or edit objectives. Keep it short and plain.
`;

/** The prompt for a report type that is not built in and names no `promptFile`. */
export function genericReportTemplate(type: string, description: string): string {
  const what = description ? `\n\nWhat this report is for: ${description.trim()}` : "";
  return `# ${type} report

You are writing this project's **${type}** report.${what}

The briefing above holds the project's state, the previous ${type} report and what
changed since it. Write the report with ONE call to \`write_report\` (type
\`${type}\`), in Markdown, using \`##\` sections of your choosing.

Do NOT write "Needs you" or "Alerts" sections: the server renders both when you
call \`write_report\`. This is a reporting run: do not create tasks, record episodes
or edit objectives. Keep it short and plain.
`;
}

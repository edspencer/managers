/** Synthetic DTOs for the Managers M11 component tests. */
import type { Episode, ObjectiveDetail, ObjectiveSummary, TaskDetail, TaskSummary } from "../../lib/types";

export function task(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t-260926-aaaa",
    title: "A task",
    status: "open",
    objective: null,
    source: "manager",
    ask: null,
    options: [],
    answer: null,
    github: [],
    dispatched: [],
    shovel_ready: false,
    due: null,
    created: "2026-09-20T08:30:00Z",
    updated: "2026-09-24T09:15:00Z",
    location: "open",
    month: null,
    file: "tasks/open/t-260926-aaaa.md",
    ...over,
  };
}

export function taskDetail(over: Partial<TaskDetail> = {}): TaskDetail {
  return { ...task(over), notes: over.notes ?? "", log: over.log ?? [] };
}

export function objective(over: Partial<ObjectiveSummary> = {}): ObjectiveSummary {
  return {
    id: "blog-cadence",
    title: "Publish weekly",
    status: "active",
    success: "Eight posts in eight weeks.",
    triggers: [],
    created: "2026-08-17T09:00:00Z",
    updated: "2026-09-25T08:00:00Z",
    file: "objectives/blog-cadence/objective.md",
    excerpt: "Seven of eight weeks met.",
    openTasks: 2,
    ...over,
  };
}

export function episode(over: Partial<Episode> = {}): Episode {
  return {
    id: "ep-260925-0700-ap",
    at: "2026-09-25T07:00:00Z",
    importance: 3,
    run: null,
    chat: null,
    source: null,
    tags: [],
    text: "An entry.",
    refs: [],
    objective: "blog-cadence",
    file: "objectives/blog-cadence/journal/2026-09.md",
    line: 1,
    ...over,
  };
}

export function objectiveDetail(over: Partial<ObjectiveDetail> = {}): ObjectiveDetail {
  return {
    ...objective(),
    preamble: "",
    whereWeAre: "Seven of eight weeks met.",
    strategy: "Short posts.",
    lessons: "- [[reviews-stall-drafts]]",
    lessonLinks: ["reviews-stall-drafts"],
    otherSections: [],
    journal: { entries: [], months: ["2026-09"], nextBefore: null },
    ...over,
  };
}

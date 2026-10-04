/**
 * A chat that is already open sees what changed since its previous turn (M15
 * shakedown #11): Ed answered a task on Home while a chat was open, the chat
 * never heard, and wrote a stale status into an objective.
 *
 * Real WS turns on the fake `claude` (batch), which records the exact prompt it
 * got as the transcript's user message, so the second user message IS what the
 * manager was sent. Each test uses its own project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug && typeof e.payload?.sessionId === "string";

describe("integration: chat turns see state changes made since the chat's previous turn", () => {
  let t: TestApp;
  let ws: WsClient;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function freshProject(): Promise<string> {
    const name = `Delta ${++n}`;
    const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    expect(res.statusCode).toBeLessThan(300);
    return name.toLowerCase().replace(/\s+/g, "-");
  }

  async function turn(slug: string, sessionId: string | null, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId, message } });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    return complete.payload!.sessionId as string;
  }

  async function userMessages(slug: string, sessionId: string): Promise<string[]> {
    const res = await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/${sessionId}/messages` });
    return (res.json().messages as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .map((m) => m.content);
  }

  it("an answer Ed records after turn 1 is in turn 2's delta", async () => {
    const slug = await freshProject();
    const created = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/managers/tasks`,
      payload: { title: "Ship the release?", status: "awaiting-ed", ask: "Ship v2 now?", options: ["ship", "wait"] },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const sessionId = await turn(slug, null, "what is waiting on me?");

    // Ed answers on Home while the chat stays open.
    const answered = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/managers/tasks/${taskId}/answer`,
      payload: { choice: "ship" },
    });
    expect(answered.statusCode).toBe(200);

    expect(await turn(slug, sessionId, "update the objective")).toBe(sessionId);
    const users = await userMessages(slug, sessionId);
    expect(users).toHaveLength(2);
    expect(users[0]).toBe("what is waiting on me?");
    const second = users[1]!;
    expect(second.startsWith("<managers-delta>\n## Changed since your last turn\n")).toBe(true);
    expect(second).toContain("Answers from Ed (1):");
    expect(second).toMatch(new RegExp(`- ${taskId} · answered by .+ · chose "ship" · now `));
    expect(second.endsWith("</managers-delta>\n\nupdate the objective")).toBe(true);
    // Ids, not the task's own text.
    expect(second).not.toContain("Ship the release?");
  });

  it("control: no delta when nothing changed since the previous turn", async () => {
    const slug = await freshProject();
    const sessionId = await turn(slug, null, "first");
    await turn(slug, sessionId, "second");
    await turn(slug, sessionId, "third");
    expect(await userMessages(slug, sessionId)).toEqual(["first", "second", "third"]);
  });

  it("the chat's own earlier turn is the baseline: a change before turn 2 is not repeated in turn 3", async () => {
    const slug = await freshProject();
    const created = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/managers/tasks`,
      payload: { title: "Pick a name", status: "awaiting-ed", ask: "Which name?" },
    });
    const taskId = (created.json() as { task: { id: string } }).task.id;
    const sessionId = await turn(slug, null, "one");
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/managers/tasks/${taskId}/answer`,
      payload: { text: "Call it Lark" },
    });
    await turn(slug, sessionId, "two");
    await turn(slug, sessionId, "three");
    const users = await userMessages(slug, sessionId);
    expect(users[1]).toContain(`- ${taskId} · answered by`);
    expect(users[1]).toContain("said: Call it Lark");
    expect(users[2]).toBe("three");
  });
});

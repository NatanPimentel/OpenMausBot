import { afterEach, describe, expect, it, vi } from "vitest";
import { answerSubject, localMidnight, type QuestionSubject } from "./needs-you";

const subject: QuestionSubject = {
  kind: "question", id: "r-1", since: 0, askers: [{ name: "Ada" }], text: "Merge the duplicates?", options: ["Yes", "No"],
  answer: { cards: [{ threadId: "t-1", requestId: "r-1" }, { threadId: "t-2", requestId: "r-2" }] },
};

afterEach(() => vi.unstubAllGlobals());

describe("answerSubject", () => {
  it("answers every card the way its own buttons do, then reloads the page", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.startsWith("/api/needs-you?") ? { count: 0, subjects: [], settled: [] } : { ok: true }), { status: 200 });
    }));
    expect(await answerSubject(subject, "Yes")).toEqual({ failed: 0 });
    expect(calls.map((call) => call.url)).toEqual(["/api/threads/t-1/respond", "/api/threads/t-2/respond", `/api/needs-you?since=${localMidnight()}`]);
    expect(calls[0]!.body).toEqual({ requestId: "r-1", behavior: "answer", message: "Yes" });
  });

  it("keeps answering the other cards when one refuses, and counts the refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/threads/t-1/respond"
      ? new Response(JSON.stringify({ error: "this question is no longer available" }), { status: 404 })
      : new Response(JSON.stringify({ ok: true, count: 0, subjects: [], settled: [] }), { status: 200 })));
    expect(await answerSubject(subject, "Yes")).toEqual({ failed: 1 });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain("/api/threads/t-2/respond");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeedsYouPage } from "../../shared/needs-you";
import { answerSubject, dismissSubject, localMidnight, needsYouSnapshot, refreshNeedsYou, undoDismiss, type QuestionSubject } from "./needs-you";

const subject: QuestionSubject = {
  kind: "question", id: "r-1", since: 0, askers: [{ name: "Brunson" }], text: "Mesclar?", options: ["Sim", "Não"],
  answer: { cards: [{ threadId: "t-1", requestId: "r-1" }, { threadId: "t-2", requestId: "r-2" }], pedidos: ["47ac81ef"], everyPedido: ["47ac81ef", "c27da3f1"] },
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("answerSubject", () => {
  it("answers every card the way its own buttons do, then the pedir-natan request, then reloads the page", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.startsWith("/api/needs-you?") ? { count: 0, subjects: [], settled: [] } : { ok: true }), { status: 200 });
    }));
    expect(await answerSubject(subject, "Sim")).toEqual({ failed: 0 });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/threads/t-1/respond", "/api/threads/t-2/respond", "/api/needs-you/pedidos", `/api/needs-you?since=${localMidnight()}`,
    ]);
    expect(calls[0]!.body).toEqual({ requestId: "r-1", behavior: "answer", message: "Sim" });
    expect(calls[2]!.body).toEqual({ ids: ["47ac81ef"], text: "Sim" });
  });

  it("keeps answering the other cards when one refuses, and counts the refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/threads/t-1/respond"
      ? new Response(JSON.stringify({ error: "this question is no longer available" }), { status: 404 })
      : new Response(JSON.stringify({ ok: true, count: 0, subjects: [], settled: [] }), { status: 200 })));
    expect(await answerSubject(subject, "Sim")).toEqual({ failed: 1 });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain("/api/threads/t-2/respond");
  });
});

describe("dismissSubject", () => {
  const other: QuestionSubject = { ...subject, id: "r-9", answer: { cards: [{ threadId: "t-9", requestId: "r-9" }], pedidos: [], everyPedido: [] } };
  const full: NeedsYouPage = { count: 2, subjects: [subject, other], settled: [] };
  // The snapshot every reader shares: the hook only subscribes to it, so reading it outside React is enough here.
  const read = () => needsYouSnapshot().page;

  function stubServer() {
    const calls: Array<{ url: string; body: unknown }> = [];
    let page = full;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/needs-you/dismiss") {
        page = { count: 1, subjects: [other], settled: [] };
        return new Response(JSON.stringify({ dismissed: 4, failed: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(page), { status: 200 });
    }));
    return calls;
  }

  it("takes the row and its count off at once, then closes every card and request on the subject without an answer", async () => {
    vi.useFakeTimers();
    const calls = stubServer();
    await refreshNeedsYou();
    expect(read()?.count).toBe(2);

    const outcome = dismissSubject(subject, 5000);
    expect(read()).toMatchObject({ count: 1, subjects: [other] });
    expect(calls.some((call) => call.url === "/api/needs-you/dismiss")).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe("dismissed");
    expect(calls.find((call) => call.url === "/api/needs-you/dismiss")!.body).toEqual({
      ids: ["r-1"], cards: subject.answer.cards, pedidos: ["47ac81ef", "c27da3f1"],
    });
    expect(calls.some((call) => call.url.includes("/respond") || call.url === "/api/needs-you/pedidos")).toBe(false);
    expect(read()).toMatchObject({ count: 1, subjects: [other] });
  });

  it("puts the row back and sends nothing when undone in time", async () => {
    vi.useFakeTimers();
    const calls = stubServer();
    await refreshNeedsYou();

    const outcome = dismissSubject(subject, 5000);
    expect(read()?.count).toBe(1);
    undoDismiss(subject.id);
    expect(await outcome).toBe("undone");
    expect(read()?.count).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.some((call) => call.url === "/api/needs-you/dismiss")).toBe(false);
  });
});

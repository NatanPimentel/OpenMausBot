import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { DUPLICATE_CONTACTS, STALLED_QUOTE, type FixtureQuestion } from "./needs-you.fixtures.ts";

it("lists a subject two bots asked once, and answering each card settles it in both conversations", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-needs-you-"));
  const release = join(gates, "release");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const sockets: Socket[] = [];
  console.log(`needs-you fixture: ${fixture.info.logPath}`);

  const ask = async (name: string, questions: FixtureQuestion[]) => {
    const bot = (await cli("new-bot", "--name", name)).bot;
    const threadId = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id).threadId as string;
    const before = (() => { try { return readFileSync(fixture.fixtureDumpPath, "utf8"); } catch { return ""; } })();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Ask me" })).status).toBeLessThan(300);
    await expect.poll(async () => Boolean((await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => {
      try {
        const dump = readFileSync(fixture.fixtureDumpPath, "utf8");
        return dump !== before ? JSON.parse(dump).mcpConfig?.mcpServers?.ogb?.args[1] : undefined;
      } catch { return undefined; }
    }, { timeout: 5_000 }).toEqual(expect.any(String));
    const socket = connect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.ogb.args[1]);
    sockets.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const ids: string[] = [];
    for (const question of questions) {
      const id = randomUUID();
      ids.push(id);
      socket.write(JSON.stringify({
        t: "ask", kind: "question", id, tool: "AskUserQuestion",
        input: { questions: [{ question: question.text, options: question.options.map((label) => ({ label })) }] },
      }) + "\n");
    }
    await expect.poll(async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages
      .filter((message: any) => ids.includes(message.card?.requestId)).length, { timeout: 5_000 }).toBe(ids.length);
    return { bot, threadId, ids };
  };
  const page = async () => (await api("GET", `/api/needs-you?since=${Date.now() - 3600_000}`)).body;

  try {
    const sales = await ask("Ada · Sales", [DUPLICATE_CONTACTS[0]!, STALLED_QUOTE]);
    const operations = await ask("Bruno · Operations", [DUPLICATE_CONTACTS[1]!]);

    const before = await page();
    expect(before.count).toBe(2);
    const duplicated = before.subjects.find((subject: any) => subject.id === sales.ids[0]);
    expect(duplicated).toMatchObject({
      kind: "question", askers: [expect.objectContaining({ botId: sales.bot.id, name: "Ada" }), expect.objectContaining({ botId: operations.bot.id, name: "Bruno" })],
      options: DUPLICATE_CONTACTS[0]!.options,
      answer: { cards: [{ threadId: sales.threadId, requestId: sales.ids[0] }, { threadId: operations.threadId, requestId: operations.ids[0] }] },
    });
    expect(before.subjects.find((subject: any) => subject.id === sales.ids[1])).toMatchObject({ kind: "question", answer: { cards: [{ requestId: sales.ids[1] }] } });

    // The page answers each card the way the card's own button does.
    const answer = "Merge both pairs";
    for (const card of duplicated.answer.cards) {
      const response = await api("POST", `/api/threads/${card.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: answer });
      expect(response, JSON.stringify(response.body)).toMatchObject({ status: 200, body: { ok: true } });
    }
    const after = await page();
    expect(after.count).toBe(1);
    expect(after.subjects.map((subject: any) => subject.id)).toEqual([sales.ids[1]]);
    expect(after.settled).toEqual([expect.objectContaining({ id: sales.ids[0], how: answer })]);
    for (const [threadId, requestId] of [[sales.threadId, sales.ids[0]], [operations.threadId, operations.ids[0]]]) {
      const card = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages.find((message: any) => message.card?.requestId === requestId).card;
      expect(card).toMatchObject({ answered: "answer", answeredText: answer, answeredBy: { at: expect.any(Number) } });
    }
    expect((await api("GET", "/api/needs-you?since=soon")).status).toBe(400);
    expect((await api("POST", `/api/needs-you?since=${Date.now()}`, {})).status).toBe(405);
    expect((await api("GET", "/api/needs-you")).body).toEqual({ items: expect.any(Array) });
  } finally {
    writeFileSync(release, "");
    for (const socket of sockets) socket.destroy();
    await fixture.close();
    rmSync(gates, { recursive: true, force: true });
  }
}, 90_000);

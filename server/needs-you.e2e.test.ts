import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { FUNNEL_DUPLICATES, STALLED_PROPOSAL, type FixtureQuestion } from "./needs-you.fixtures.ts";

it("lists a subject two bots asked once, and one answer settles every card and the pedir-natan request", async () => {
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

  // The fixture's HOME is its data dir, where the server looks for the local pedir-natan queue and command.
  const state = join(fixture.info.dataDir, ".local", "state", "pedir-natan");
  const bin = join(fixture.info.dataDir, ".local", "bin");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const queue = new DatabaseSync(join(state, "pedidos.db"));
  queue.exec("CREATE TABLE pedidos(id text primary key, criado text, origem text, titulo text, texto text, opcoes text, recomendada int, estado text, resposta text, respondido_em text)");
  queue.prepare("INSERT INTO pedidos VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', NULL, NULL)")
    .run("47ac81ef", new Date().toISOString(), "Faxina de cartões (Brunson)", "Confirmação da call das 11h", "", JSON.stringify(["Ligo a proteção", "Mando eu mesmo"]), 1);
  queue.close();
  const answered = join(gates, "answered.json");
  writeFileSync(join(bin, "pedir-natan"), `#!${process.execPath}
const { DatabaseSync } = require("node:sqlite");
const [, , verb, id, text] = process.argv;
require("node:fs").writeFileSync(${JSON.stringify(answered)}, JSON.stringify({ verb, id, text }));
new DatabaseSync(${JSON.stringify(join(state, "pedidos.db"))}).prepare("UPDATE pedidos SET estado = 'respondido', resposta = ?, respondido_em = ? WHERE id = ?")
  .run(JSON.stringify({ texto: text }), new Date().toISOString(), id);
`);
  chmodSync(join(bin, "pedir-natan"), 0o755);

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
    const funnel = await ask("Brunson · Funil", [FUNNEL_DUPLICATES[0]!, STALLED_PROPOSAL[0]!]);
    const chief = await ask("Sandberg · Chefe", [FUNNEL_DUPLICATES[1]!]);

    const before = await page();
    expect(before.count).toBe(3);
    const duplicated = before.subjects.find((subject: any) => subject.id === funnel.ids[0]);
    expect(duplicated).toMatchObject({
      kind: "question", askers: [expect.objectContaining({ botId: funnel.bot.id, name: "Brunson" })], options: FUNNEL_DUPLICATES[0]!.options,
      answer: { cards: [{ threadId: funnel.threadId, requestId: funnel.ids[0] }, { threadId: chief.threadId, requestId: chief.ids[0] }], pedidos: [] },
    });
    expect(before.subjects.find((subject: any) => subject.id === funnel.ids[1])).toMatchObject({ kind: "question", answer: { cards: [{ requestId: funnel.ids[1] }] } });
    expect(before.subjects.find((subject: any) => subject.id === "pedido:47ac81ef")).toMatchObject({ options: ["Mando eu mesmo", "Ligo a proteção"], answer: { cards: [], pedidos: ["47ac81ef"] } });

    const answer = "Mesclar os 4 pares";
    for (const card of duplicated.answer.cards) {
      const response = await api("POST", `/api/threads/${card.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: answer });
      expect(response, JSON.stringify(response.body)).toMatchObject({ status: 200, body: { ok: true } });
    }
    const after = await page();
    expect(after.subjects.map((subject: any) => subject.id).sort()).toEqual([funnel.ids[1], "pedido:47ac81ef"].sort());
    expect(after.settled).toEqual([expect.objectContaining({ id: funnel.ids[0], how: answer })]);
    for (const [threadId, requestId] of [[funnel.threadId, funnel.ids[0]], [chief.threadId, chief.ids[0]]]) {
      const card = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages.find((message: any) => message.card?.requestId === requestId).card;
      expect(card).toMatchObject({ answered: "answer", answeredText: answer, answeredBy: { at: expect.any(Number) } });
    }

    expect((await api("POST", "/api/needs-you/pedidos", { ids: ["47ac81ef"], text: "Mando eu mesmo" })).status).toBe(202);
    expect((await page()).subjects.map((subject: any) => subject.id)).toEqual([funnel.ids[1]]);
    await expect.poll(() => { try { return JSON.parse(readFileSync(answered, "utf8")); } catch { return null; } }, { timeout: 10_000 })
      .toEqual({ verb: "responder", id: "47ac81ef", text: "Mando eu mesmo" });
    await expect.poll(async () => (await page()).settled.map((settled: any) => settled.how), { timeout: 10_000 }).toEqual(["Mando eu mesmo", answer]);
    expect((await page()).subjects.map((subject: any) => subject.id)).toEqual([funnel.ids[1]]);
    expect((await api("POST", "/api/needs-you/pedidos", { ids: ["47ac81ef"], text: "again" })).status).toBe(409);
  } finally {
    writeFileSync(release, "");
    for (const socket of sockets) socket.destroy();
    await fixture.close();
    rmSync(gates, { recursive: true, force: true });
  }
}, 90_000);

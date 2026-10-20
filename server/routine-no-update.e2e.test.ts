import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("a run with nothing new leaves no unread mark or notification, and a run with news still does", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const planFile = join(dataDir, "next-turn.json");
  const nothingNew = () => writeFileSync(planFile, JSON.stringify({ tools: [{ name: "routine_no_update", server: "agents", input: {} }], replies: [""] }));
  const somethingNew = () => rmSync(planFile, { force: true });
  const wrapper = join(dataDir, "no-update-cli.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { existsSync, readFileSync } from "node:fs";',
    `const plan = existsSync(${JSON.stringify(planFile)}) ? JSON.parse(readFileSync(${JSON.stringify(planFile)}, "utf8")) : undefined;`,
    "if (plan) { process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify(plan.tools); process.env.FAKE_CLAUDE_REPLIES = JSON.stringify(plan.replies); }",
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  const runs = async () => (await api("GET", "/api/routines")).runs as any[];
  const finished = async (id: string) => {
    await expect.poll(async () => (await runs()).find((run) => run.id === id)?.status, { timeout: 30_000 }).toBe("completed");
    await expect.poll(async () => (await bot()).tasks.every((task: any) => !task.busy), { timeout: 30_000 }).toBe(true);
    return (await runs()).find((run) => run.id === id);
  };
  let botId = "";
  const bot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === botId);
  const task = async (threadId: string) => (await bot()).tasks.find((candidate: any) => candidate.threadId === threadId);
  const notifications = async () => (await api("GET", "/api/notifications")).notifications as any[];
  try {
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    botId = ((await runControlOmb(["new-bot", "--name", "Infra", "--url", url])) as any).bot.id;
    const main = (await bot()).threadId as string;
    await api("POST", `/api/bots/${botId}/read`, { threadId: main });
    const { routine } = await api("POST", "/api/routines", {
      name: "Drain queue", prompt: "Drain the queue.", botId, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);

    nothingNew();
    const quiet = await finished((await api("POST", `/api/routines/${routine.id}/run`, undefined, 201)).run.id);
    expect(quiet).toMatchObject({ noUpdate: true, resultsThreadId: main });
    const quietCard = (await api("GET", `/api/threads/${main}/messages?limit=100`)).messages
      .find((message: any) => message.kind === "routine.run" && message.routineRun.runId === quiet.id);
    expect(quietCard.routineRun).toMatchObject({ status: "completed" });
    expect((await task(main)).unread).toBe(false);
    expect((await task(quiet.threadId)).unread).toBe(false);
    expect((await notifications()).filter((entry) => entry.threadId === main || entry.threadId === quiet.threadId)).toEqual([]);

    somethingNew();
    const reported = await finished((await api("POST", `/api/routines/${routine.id}/run`, undefined, 201)).run.id);
    expect(reported.noUpdate).toBeUndefined();
    expect((await task(main)).unread).toBe(true);
    expect((await notifications()).filter((entry) => entry.threadId === main && !entry.read)).toHaveLength(1);

    const created = await api("POST", "/api/webhooks", { name: "Support round", prompt: "Check the support inbox.", botId }, 201);
    await api("PATCH", `/api/webhooks/${created.webhook.id}`, { enabled: true, verificationPending: false });
    const deliver = async () => {
      const response = await fetch(created.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round: Date.now() }) });
      expect(response.status).toBe(202);
      return finished(((await response.json()) as { runId: string }).runId);
    };

    nothingNew();
    const quietHook = await deliver();
    expect(quietHook.noUpdate).toBe(true);
    expect(await task(quietHook.threadId)).toMatchObject({ unread: false, archivedAt: expect.any(Number) });
    expect((await api("GET", `/api/threads/${quietHook.threadId}/messages?limit=100`)).messages.length).toBeGreaterThan(0);
    expect((await notifications()).filter((entry) => entry.threadId === quietHook.threadId)).toEqual([]);

    somethingNew();
    const loudHook = await deliver();
    expect(await task(loudHook.threadId)).toMatchObject({ unread: true });
    expect((await task(loudHook.threadId)).archivedAt).toBeFalsy();
    expect((await notifications()).filter((entry) => entry.threadId === loudHook.threadId && !entry.read)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 120_000);

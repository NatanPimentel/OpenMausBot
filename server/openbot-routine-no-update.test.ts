import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { RoutineManager } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function started() {
  const dir = mkdtempSync(join(tmpdir(), "omb-no-update-"));
  dirs.push(dir);
  let thread = 0;
  const options = {
    file: join(dir, "routines.json"),
    botState: () => "ready" as const,
    createTask: () => ({ threadId: `thread-${++thread}` }),
    startTurn: async () => {},
  };
  const manager = new RoutineManager(options);
  const routine = manager.create({ name: "Queue", prompt: "Drain the queue", botId: "bot-1", enabled: false,
    schedule: { type: "interval", everyMinutes: 20, anchorAt: Date.now() + 3_600_000 } });
  const run = manager.runNow(routine.id)!;
  await manager.tick();
  const threadId = manager.listRuns().find((candidate) => candidate.id === run.id)!.threadId!;
  const event = (fields: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">) =>
    manager.handleRuntimeEvent({ eventId: `${fields.type}-${Math.random()}`, provider: "fake", threadId, createdAt: new Date().toISOString(), ...fields } as RuntimeEvent);
  return { manager, options, run, event };
}

it("stamps a run that said it had nothing new and then completed, and keeps it after a restart", async () => {
  const { manager, options, run, event } = await started();
  expect(manager.markNoUpdate(run.id)).toBe(true);
  expect(event({ type: "turn.completed", ok: true })).toMatchObject({ status: "completed", noUpdate: true });
  expect(new RoutineManager(options).listRuns().find((candidate) => candidate.id === run.id)?.noUpdate).toBe(true);
  expect(manager.markNoUpdate(run.id)).toBe(false);
});

it("leaves a run that answered with text, failed or then asked the person to report as before", async () => {
  const plain = await started();
  expect(plain.event({ type: "turn.completed", ok: true })).toMatchObject({ status: "completed" });
  expect(plain.manager.listRuns()[0]!.noUpdate).toBeUndefined();

  const failed = await started();
  failed.manager.markNoUpdate(failed.run.id);
  expect(failed.event({ type: "turn.completed", ok: false })?.noUpdate).toBeUndefined();

  const retried = await started();
  retried.manager.markNoUpdate(retried.run.id);
  retried.manager.failThread(retried.manager.listRuns()[0]!.threadId!, "the turn stalled", { stalled: true });
  expect(retried.manager.listRuns()[0]).toMatchObject({ status: "queued" });

  const asked = await started();
  asked.manager.markNoUpdate(asked.run.id);
  asked.event({ type: "request.opened", requestType: "question", tool: "ask", summary: "Which account?" } as Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">);
  asked.event({ type: "request.resolved", behavior: "answer", source: "user" } as Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">);
  expect(asked.event({ type: "turn.completed", ok: true })).toMatchObject({ status: "completed" });
  expect(asked.manager.listRuns()[0]!.noUpdate).toBeUndefined();
});

// A turn stopped by its engine's usage limit, end to end against a real server with fake engines: the stopped turn's
// "Continue when your limit resets" sets up an automation that continues the conversation after the reset; with a
// backup configured the conversation continues on the backup and goes back after the reset; a backup that is only
// another sign-in to the same engine is never used. The limit clock hook shortens the minute after a reset to a
// second, so each run is watched without waiting.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const codex = { instanceId: "codex", model: "gpt-fake-default" };
const jsonLines = (path: string): unknown[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

interface Fixture {
  api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  /** The fake Claude refuses every turn until this reset (epoch seconds); `lift()` ends the limit. */
  limit: (resetsAt: number) => void;
  lift: () => void;
  claudePrompts: () => unknown[];
  dataDir: string;
  evidence: unknown[];
  memoryUrl?: string;
}

async function withLimitFixture(setup: { recovery?: unknown; secondClaude?: boolean; fleetAccountFailover?: boolean; memoryBridge?: "echo" | "offline" | "hold" | "real" }, check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const limitedFile = join(dataDir, "claude-limited.json");
  const promptsFile = join(dataDir, "claude-prompts.jsonl");
  const usageFile = join(dataDir, "plan-usage.json");
  const evidence: unknown[] = [{ url, setup }];
  let server: ChildProcess | undefined;
  let memoryServer: ChildProcess | undefined;
  let memoryUrl: string | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_LIMITED_FILE: limitedFile, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_TOOL_CALLS: "[]" };
    if (setup.memoryBridge === "real") {
      config.instances.claude.environment.FAKE_CLAUDE_REPLIES = JSON.stringify([
        `ASSISTANT_RECEIPT receipt-A was sent. Historical diagnostics: ${"historical investigation detail ".repeat(600)}`,
        `ASSISTANT_DIAGNOSTICS ${"superseded investigation detail ".repeat(600)}`,
      ]);
      config.instances.claude.environment.FAKE_CLAUDE_REPLY_STATE = join(dataDir, "real-memory-reply-state");
    }
    config.instances.codex = { driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) } };
    if (setup.secondClaude) config.instances.claudeWork = { ...config.instances.claude, displayName: "Second Claude sign-in" };
    if (setup.fleetAccountFailover) {
      config.instances.claude.config.configDir = join(dataDir, "primary-profile");
      config.instances.claude.environment.FAKE_CLAUDE_SESSION_START_FRAMES = "1";
      config.instances.claudeWork.config = { ...config.instances.claude.config, configDir: join(dataDir, "backup-profile") };
      config.instances.claudeWork.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_LIMITED_FILE: join(dataDir, "unused-limit.json") };
    }
    if (setup.recovery) config.automaticRecovery = setup.recovery;
    writeFileSync(configPath, JSON.stringify(config));
    const memoryBridgePath = join(dataDir, "memory-bridge.py");
    if (setup.memoryBridge === "real") {
      const realBridgePath = process.env.OMB_AI_MEMORY_TEST_BRIDGE;
      expect(realBridgePath && existsSync(realBridgePath), "Provide OMB_AI_MEMORY_TEST_BRIDGE pointing to the real checkpoint bridge").toBe(true);
      const port = await freePortBlock([0], 23_000, 3_000);
      memoryUrl = `http://127.0.0.1:${port}`;
      const memoryHome = join(dataDir, "memory-home");
      mkdirSync(memoryHome);
      const memoryLogPath = `${logPath}.ai-memory.log`;
      const memoryLog = openSync(memoryLogPath, "a", 0o600);
      try {
        memoryServer = spawn(process.env.OMB_AI_MEMORY_TEST_BINARY ?? join(userInfo().homedir, ".local", "bin", "ai-memory"), [
          "--data-dir", join(dataDir, "memory-data"), "serve", "--transport", "http", "--bind", `127.0.0.1:${port}`,
          "--workspace", "fixture", "--project", "handoff", "--no-watcher",
        ], {
          env: { HOME: memoryHome, USERPROFILE: memoryHome, PATH: `${dirname(process.execPath)}${delimiter}/usr/bin`, LANG: "C.UTF-8" },
          stdio: ["ignore", memoryLog, memoryLog],
        });
        memoryServer.on("error", () => {});
      } finally { closeSync(memoryLog); }
      await expect.poll(async () => {
        try { return (await fetch(`${memoryUrl}/workstream/invalid/events`, { signal: AbortSignal.timeout(500) })).status; }
        catch { return 0; }
      }, { timeout: 15_000 }).toBe(400);
      evidence.push({ memoryUrl, memoryLogPath, memoryPid: memoryServer?.pid, isolatedMemoryData: join(dataDir, "memory-data") });
    }
    if (setup.memoryBridge) writeFileSync(memoryBridgePath, [
      "import json, pathlib, sys, time",
      "request = json.load(sys.stdin)",
      `root = pathlib.Path(${JSON.stringify(dataDir)})`,
      '(root / "memory-bridge-request.json").write_text(json.dumps(request))',
      ...(setup.memoryBridge === "offline" ? ["sys.exit(1)"] : []),
      ...(setup.memoryBridge === "hold" ? ['while not (root / "memory-bridge-release").exists(): time.sleep(0.02)'] : []),
      ...(setup.memoryBridge === "real" ? [
        "import importlib.util",
        "sys.dont_write_bytecode = True",
        `spec = importlib.util.spec_from_file_location("real_handoff_bridge", ${JSON.stringify(process.env.OMB_AI_MEMORY_TEST_BRIDGE)})`,
        "bridge = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(bridge)",
        `result = bridge.exchange(request, server_url=${JSON.stringify(memoryUrl)}, state_dir=root / "memory-refs")`,
        '(root / "memory-bridge-response.json").write_text(json.dumps(result))',
        "json.dump(result, sys.stdout)",
      ] : ['json.dump(dict(request, workspace="default", project=request["conversationId"].split(":")[0], handoffId="fixture-checkpoint", text=request["summary"]), sys.stdout)']),
    ].join("\n"));
    // No engine reports usage here: what the server knows of the limit comes from the refusal itself.
    writeFileSync(usageFile, JSON.stringify({ providers: [] }));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, [
      "--experimental-strip-types", "--import", new URL("./testing/limit-clock-hooks.mjs", import.meta.url).href, fileURLToPath(new URL("./index.ts", import.meta.url)),
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_LIMIT_CLOCK: "1", OMB_TEST_PLAN_USAGE_FILE: usageFile,
        ...(setup.memoryBridge ? { OMB_AI_MEMORY_HANDOFF_COMMAND: memoryBridgePath, PATH: `${dirname(process.execPath)}${delimiter}/usr/bin` } : {}),
        ...(setup.fleetAccountFailover ? { OMB_CLAUDE_ACCOUNT_FAILOVER: "1" } : {}) },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.some((option: any) => option.id === codex.model);
    }, { timeout: 20_000 }).toBe(true);
    await check({
      api, control, dataDir, evidence, memoryUrl,
      limit: (resetsAt) => writeFileSync(limitedFile, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt })),
      lift: () => rmSync(limitedFile, { force: true }),
      claudePrompts: () => jsonLines(promptsFile),
    });
  } finally {
    const evidencePath = `${logPath}.limit-reset.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await waitForExit(memoryServer, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

const messagesOf = async (api: Fixture["api"], threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const recoveryLines = (messages: any[]) => messages.filter((message) => message.tool?.name?.startsWith("recovery:")).map((message) => message.tool.name as string);

it("the stopped turn's Continue sets up a run that continues the conversation once the limit resets", async () => {
  await withLimitFixture({}, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 10;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Scout");
    const threadId = bot.activeTaskId;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Write the quarterly report");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const stopped = await messagesOf(api, threadId);
    const failure = stopped.find((message) => message.tool?.name?.startsWith("error:"));
    expect(failure.tool).toMatchObject({ ok: false, limitResetsAt: resetsAt * 1000 });
    expect(recoveryLines(stopped)).toEqual([]);
    expect((await api("GET", "/api/limit-resets")).engines).toContainEqual(expect.objectContaining({ engine: "claude", blocked: true, resetsAt: resetsAt * 1000 }));

    const { routine } = await api("POST", "/api/limit-resets/continue", { botId: bot.id, threadId }, 201);
    expect(routine).toMatchObject({ sourceThreadId: threadId, enabled: true, nextRunAt: resetsAt * 1000 + 1_000, schedule: { type: "limit_reset", engine: "claude", repeat: "once" } });
    expect(routine.prompt).toContain("cut off because Verification fixture's usage limit was reached");
    const card = (await messagesOf(api, threadId)).find((message) => message.card?.routineRequest?.resultId === routine.id);
    expect(card.card).toMatchObject({ autoApplied: true, answered: "allow" });
    expect(claudePrompts()).toHaveLength(1);

    lift();
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === routine.id)?.status, { timeout: 40_000 }).toBe("completed");
    const { runs, routines } = await api("GET", "/api/routines");
    const run = runs.find((candidate: any) => candidate.routineId === routine.id);
    expect(run.threadId).toBe(threadId);
    expect(run.startedAt).toBeGreaterThanOrEqual(resetsAt * 1000 + 1_000);
    expect(routines.find((candidate: any) => candidate.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    const prompts = claudePrompts();
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("Your previous turn here was cut off because Verification fixture's usage limit was reached");
    const after = await messagesOf(api, threadId);
    expect(after.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ stopped, routine, run, after });
  });
}, 120_000);

it.each(["echo", "offline"] as const)("uses a durable account handoff only after the memory bridge succeeds (%s)", async memoryBridge => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, fleetAccountFailover: true, memoryBridge },
    async ({ api, control, limit, claudePrompts, dataDir }) => {
      const { bot } = await control("new-bot", "--name", "Memory continuity");
      const threadId = bot.activeTaskId;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...bot.modelSelection, effort: "medium" } });
      for (const text of ["OLD_GOAL use port 9000", "COMPLETED_ACTION receipt-A was already sent; never send it twice", "CORRECTION cancel port 9000, use port 9001", "RECENT_WORK keep the receipt and finish the report"]) {
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      }
      const before = await messagesOf(api, threadId);
      const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling continuity" })).task;
      limit(Math.floor(Date.now() / 1000) + 600);
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "LATEST_REQUEST finish the corrected report once");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      const messages = await messagesOf(api, threadId);
      for (const previous of before) expect(messages.some(message => message.id === previous.id)).toBe(true);
      expect(messages.filter(message => message.kind === "compaction")).toHaveLength(memoryBridge === "echo" ? 1 : 0);
      const prompt = JSON.stringify(claudePrompts().at(-1));
      expect(prompt).toContain("COMPLETED_ACTION");
      expect(prompt).toContain("CORRECTION");
      expect(prompt.match(/LATEST_REQUEST/g)).toHaveLength(1);
      expect(messages.filter(message => message.role === "user" && message.text?.includes("LATEST_REQUEST"))).toHaveLength(1);
      const task = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((item: any) => item.id === bot.id).tasks.find((item: any) => item.threadId === threadId);
      expect(task.modelSelection).toMatchObject({ instanceId: "claudeWork", effort: "medium" });
      if (memoryBridge === "echo") {
        expect(prompt).toContain("Earlier conversation summary");
        expect(task.appliedCompactionId).toBe(messages.find(message => message.kind === "compaction").id);
        const dump = JSON.parse(readFileSync(join(dataDir, "fake-claude-dump.json"), "utf8"));
        expect(dump.argv).not.toContain("--resume");
        const request = JSON.parse(readFileSync(join(dataDir, "memory-bridge-request.json"), "utf8"));
        expect(request.conversationId).toBe(`${bot.id}:${threadId}`);
        expect(request.summary).not.toContain("LATEST_REQUEST");
      }
      expect((await messagesOf(api, sibling.threadId)).some(message => message.kind === "compaction")).toBe(false);
    });
}, 120_000);

it.each(["Stop", "new input", "branch edit"] as const)("does not apply a late memory handoff after %s", async action => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, fleetAccountFailover: true, memoryBridge: "hold" },
    async ({ api, control, limit, claudePrompts, dataDir }) => {
      const { bot } = await control("new-bot", "--name", "Memory cancellation");
      const threadId = bot.activeTaskId;
      for (const text of ["ORIGINAL_BRANCH", "SECOND_EXCHANGE", "THIRD_EXCHANGE"]) {
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      }
      limit(Math.floor(Date.now() / 1000) + 600);
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "STALE_REQUEST");
      await expect.poll(() => existsSync(join(dataDir, "memory-bridge-request.json")), { timeout: 15_000 }).toBe(true);
      const promptsBefore = claudePrompts().length;
      if (action === "Stop") await control("interrupt", "--bot", bot.id, "--task", threadId);
      else if (action === "new input") await control("send", "--bot", bot.id, "--task", threadId, "--text", "NEW_REQUEST wins");
      else {
        const original = (await messagesOf(api, threadId)).find(message => message.text === "ORIGINAL_BRANCH");
        await control("interrupt", "--bot", bot.id, "--task", threadId);
        await control("edit", "--bot", bot.id, "--task", threadId, "--message", original.id, "--text", "NEW_BRANCH wins");
      }
      writeFileSync(join(dataDir, "memory-bridge-release"), "release");
      await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
      const messages = await messagesOf(api, threadId);
      expect(messages.filter(message => message.kind === "compaction")).toHaveLength(0);
      const laterPrompts = claudePrompts().slice(promptsBefore);
      if (action === "Stop") expect(laterPrompts).toHaveLength(0);
      else expect(JSON.stringify(laterPrompts)).toContain(action === "new input" ? "NEW_REQUEST" : "NEW_BRANCH");
      expect(JSON.stringify(laterPrompts)).not.toContain("Earlier conversation summary");
    });
}, 120_000);

it("continues on the backup engine with one line, and goes back to its own engine after the reset", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: codex } }, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 25;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Planner");
    const threadId = bot.activeTaskId;
    const claudeModel = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
    expect(claudeModel.instanceId).toBe("claude");
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const first = await messagesOf(api, threadId);
    expect(recoveryLines(first)).toEqual([expect.stringMatching(/^recovery: Verification fixture hit its limit \(resets .+\), so Codex took over\.$/)]);
    expect(first.some((message) => message.tool?.ok === false)).toBe(false);
    expect(first.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "done from fake codex", turnSucceeded: true });
    const task = async (id: string) => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === id);
    expect((await task(threadId)).modelSelection).toEqual(codex);
    expect(claudePrompts()).toHaveLength(1);

    // Known to be refusing: a new conversation goes to the backup without spending a refused turn on Claude.
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(recoveryLines(await messagesOf(api, other.threadId))).toHaveLength(1);
    expect(claudePrompts()).toHaveLength(1);

    lift();
    await expect.poll(() => Date.now() > resetsAt * 1000 + 500, { timeout: 40_000, interval: 500 }).toBe(true);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now polish it");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const back = await messagesOf(api, threadId);
    expect(recoveryLines(back)).toEqual([
      expect.stringContaining("so Codex took over"),
      "recovery: Verification fixture's limit has reset, so this conversation is back on Verification fixture.",
    ]);
    expect((await task(threadId)).modelSelection).toEqual(claudeModel);
    expect(claudePrompts()).toHaveLength(2);
    expect(JSON.stringify(claudePrompts()[1])).toContain("Now polish it");
    expect(back.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ first, back });
  });
}, 150_000);

it("never moves to another sign-in of the same engine; the stopped turn offers Continue instead", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true },
    async ({ api, control, limit, claudePrompts }) => {
      const resetsAt = Math.floor(Date.now() / 1000) + 600;
      limit(resetsAt);
      const { bot } = await control("new-bot", "--name", "One account");
      const threadId = bot.activeTaskId;
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "Summarize the inbox");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
      const messages = await messagesOf(api, threadId);
      expect(recoveryLines(messages)).toEqual([]);
      expect(messages.find((message) => message.tool?.name?.startsWith("error:")).tool).toMatchObject({ ok: false, limitResetsAt: resetsAt * 1000 });
      expect(claudePrompts()).toHaveLength(1);
      expect((await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    });
}, 120_000);

it.each(["low", undefined] as const)("preserves the fleet's configured Claude account fallback after a pre-start quota refusal (backup effort %s)", async (backupEffort) => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5", ...(backupEffort ? { effort: backupEffort } : {}) } }, secondClaude: true, fleetAccountFailover: true },
    async ({ api, control, limit }) => {
      limit(Math.floor(Date.now() / 1000) + 600);
      const { bot } = await control("new-bot", "--name", "Fleet fallback");
      const threadId = bot.activeTaskId;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...bot.modelSelection, effort: "high" }, updateBotDefault: true });
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "Summarize the inbox once");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      const messages = await messagesOf(api, threadId);
      expect(recoveryLines(messages)).toHaveLength(1);
      expect(messages.filter((message) => message.role === "user" && message.kind === "text" && message.text === "Summarize the inbox once")).toHaveLength(1);
      expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude", turnSucceeded: true });
      const task = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId);
      expect(task.modelSelection.instanceId).toBe("claudeWork");
      expect(task.modelSelection.effort).toBe(backupEffort ?? "high");
    });
}, 120_000);

it("preserves the preceding checkpoint verbatim through a second account handoff", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, fleetAccountFailover: true, memoryBridge: "echo" },
    async ({ api, control, limit, dataDir }) => {
      const { bot } = await control("new-bot", "--name", "Repeated checkpoint");
      const threadId = bot.activeTaskId;
      const send = async (text: string) => {
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      };
      for (const text of ["OLD_RECEIPT receipt-A already sent", "OLD_CORRECTION use port 9001", "KEEP_SECOND", "KEEP_THIRD"]) await send(text);
      limit(Math.floor(Date.now() / 1000) + 600);
      await send("FIRST_HANDOFF finish the report");
      const previous = (await messagesOf(api, threadId)).find(message => message.kind === "compaction").compaction.summary;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: bot.modelSelection });
      await send("SECOND_HANDOFF retain the receipt and finish once");
      const records = (await messagesOf(api, threadId)).filter(message => message.kind === "compaction");
      expect(records).toHaveLength(2);
      expect(records[1].compaction.summary).toContain(previous);
      expect(Buffer.byteLength(records[1].compaction.summary)).toBeLessThanOrEqual(6_000);
      const request = JSON.parse(readFileSync(join(dataDir, "memory-bridge-request.json"), "utf8"));
      expect(request.summary).toContain(previous);
    });
}, 120_000);

it("keeps ordinary account recovery when folding would lose an older file attachment", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, fleetAccountFailover: true, memoryBridge: "echo" },
    async ({ api, control, limit, dataDir, claudePrompts }) => {
      const { bot } = await control("new-bot", "--name", "Keep attachment evidence");
      const threadId = bot.activeTaskId;
      const evidencePath = join(dataDir, "evidence.csv");
      writeFileSync(evidencePath, "receipt,status\nA,sent\n");
      for (const text of [`Use the attached receipt evidence.\n<attached-file path="${evidencePath}" name="evidence.csv"/>`, "KEEP_SECOND", "KEEP_THIRD"]) {
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      }
      limit(Math.floor(Date.now() / 1000) + 600);
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "CURRENT_REQUEST use the receipt once");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      expect((await messagesOf(api, threadId)).some(message => message.kind === "compaction")).toBe(false);
      expect(existsSync(join(dataDir, "memory-bridge-request.json"))).toBe(false);
      const prompt = JSON.stringify(claudePrompts().at(-1));
      expect(prompt).toContain("evidence.csv");
      expect(prompt.match(/CURRENT_REQUEST/g)).toHaveLength(1);
    });
}, 120_000);

it.runIf(process.env.OMB_REAL_AI_MEMORY_HANDOFF_TEST === "1")("roundtrips account handoff through real AI-Memory", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, fleetAccountFailover: true, memoryBridge: "real" },
    async ({ api, control, limit, dataDir, claudePrompts, evidence, memoryUrl }) => {
      const { bot } = await control("new-bot", "--name", "Real memory continuity");
      const threadId = bot.activeTaskId;
      const cwd = join(dataDir, "memory-checkout");
      mkdirSync(cwd);
      writeFileSync(join(cwd, ".ai-memory.toml"), 'workspace = "fixture"\nproject = "handoff"\n');
      await api("PATCH", `/api/bots/${bot.id}`, { cwd });
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...bot.modelSelection, effort: "medium" } });
      for (const text of [
        "OLD_RECEIPT receipt-A was already sent. Verify it before sending anything again.",
        "OLD_CONSTRAINT cancel port 9000; use port 9001 and retain receipt-A.",
        "OLDER_DETAILS_A finish investigating the earlier diagnostics",
        "OLDER_DETAILS_B retain the correction and existing receipt",
        "RECENT_EXCHANGE_A keep the agreed port",
        "RECENT_EXCHANGE_B finish the report using existing receipts",
      ]) {
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      }
      const before = await messagesOf(api, threadId);
      const originalConversationBytes = Buffer.byteLength(JSON.stringify(before.filter(message => message.kind === "text").map(({ role, text }) => ({ role, text }))));
      expect(before.some(message => message.role === "bot" && (message.text?.length ?? 0) > 10_000)).toBe(true);
      expect(originalConversationBytes).toBeGreaterThan(30_000);
      limit(Math.floor(Date.now() / 1000) + 600);
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "LATEST_REAL_REQUEST finish the report once with the corrected port");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      const messages = await messagesOf(api, threadId);
      const records = messages.filter(message => message.kind === "compaction");
      expect(records).toHaveLength(1);
      for (const previous of before) expect(messages.some(message => message.id === previous.id)).toBe(true);
      const request = JSON.parse(readFileSync(join(dataDir, "memory-bridge-request.json"), "utf8"));
      const checkpoint = JSON.parse(readFileSync(join(dataDir, "memory-bridge-response.json"), "utf8"));
      const latestRequest = messages.find(message => message.role === "user" && message.text?.includes("LATEST_REAL_REQUEST"));
      expect(request).toMatchObject({ schemaVersion: 1, source: "openmausbot", conversationId: `${bot.id}:${threadId}`, boundaryId: `${latestRequest.id}:claudeWork`, cwd });
      expect(checkpoint).toMatchObject({ schemaVersion: 1, source: "openmausbot", conversationId: request.conversationId, boundaryId: request.boundaryId, workspace: "fixture", project: "handoff" });
      expect(checkpoint.handoffId).not.toBe("fixture-checkpoint");
      const response = await fetch(`${memoryUrl}/workstream/${checkpoint.handoffId}/events?limit=10`, { signal: AbortSignal.timeout(2_000) });
      expect(response.ok).toBe(true);
      const events = await response.json() as any[];
      const storedCheckpoint = JSON.parse(events.find(event => event.kind === "checkpoint" && event.source_record_id === request.boundaryId).content);
      expect(storedCheckpoint).toMatchObject({ source: "openmausbot", workspace: "fixture", project: "handoff", conversationId: request.conversationId, boundaryId: request.boundaryId, text: checkpoint.text });
      expect(records[0].compaction.summary).toBe(checkpoint.text);
      expect(checkpoint.text).toContain("OLD_RECEIPT");
      expect(checkpoint.text).toContain("OLD_CONSTRAINT");
      expect(checkpoint.text).toContain("ASSISTANT_RECEIPT");
      const prompt = JSON.stringify(claudePrompts().at(-1));
      const providerPromptBytes = Buffer.byteLength(prompt);
      expect(prompt).toContain("Earlier conversation summary");
      expect(prompt).toContain("OLD_RECEIPT");
      expect(prompt).toContain("OLD_CONSTRAINT");
      expect(prompt.match(/LATEST_REAL_REQUEST/g)).toHaveLength(1);
      expect(messages.filter(message => message.role === "user" && message.text?.includes("LATEST_REAL_REQUEST"))).toHaveLength(1);
      expect(providerPromptBytes).toBeLessThan(24_000);
      expect(providerPromptBytes).toBeLessThan(originalConversationBytes / 2);
      const dump = JSON.parse(readFileSync(join(dataDir, "fake-claude-dump.json"), "utf8"));
      expect(dump.argv).not.toContain("--resume");
      const task = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((item: any) => item.id === bot.id).tasks.find((item: any) => item.threadId === threadId);
      expect(task.modelSelection).toMatchObject({ instanceId: "claudeWork", effort: "medium" });
      expect(task.appliedCompactionId).toBe(records[0].id);
      evidence.push({ realMemoryRoundtrip: { originalConversationBytes, providerPromptBytes, checkpointBytes: Buffer.byteLength(checkpoint.text), checkpoint, storedCheckpoint, request, compactionId: records[0].id, latestRequestCount: 1 } });
      console.info(JSON.stringify({ realMemoryRoundtrip: true, originalConversationBytes, providerPromptBytes, checkpointBytes: Buffer.byteLength(checkpoint.text), handoffId: checkpoint.handoffId }));
    });
}, 150_000);

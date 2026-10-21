import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { callOpenBotDataTool, OPENBOT_DATA_INTERNAL_PATH, OPENBOT_DATA_TOOL_DEFINITIONS } from "../drivers/agents-openbot-data.ts";
import { createHarnessClient } from "../drivers/agents-client.ts";
import type { ToolCallContext } from "../drivers/agents-call.ts";
import { createOpenBotDataHost, openBotDataErrorStatus } from "./host.ts";
import { OpenBotDataError } from "./store.ts";
import { json, readBody } from "../harness/http.ts";

let directory: string;
let host: ReturnType<typeof createOpenBotDataHost>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-openbot-data-host-fixture-"));
  const path = join(directory, "synthetic-shared.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE openbot_metadata (table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.close();
  host = createOpenBotDataHost(path);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const active = { botId: "alice", allowSharedData: true, assertActive() {} };

it("has no bot, user or path selectors and rejects identity injection at every request level", async () => {
  for (const tool of OPENBOT_DATA_TOOL_DEFINITIONS) {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const selector of ["botId", "bot_id", "owner_agent_id", "userId", "databasePath", "path"]) expect(tool.inputSchema.properties).not.toHaveProperty(selector);
  }
  for (const body of [
    { name: "list_tables", arguments: {}, botId: "bob" },
    { name: "list_tables", arguments: { botId: "bob" } },
    { name: "query_data", arguments: { sql: "SELECT 1", path: "/not-a-db" } },
    { name: "execute_data", arguments: { sql: "CREATE TABLE x (id INTEGER)", owner_agent_id: "bob" } },
    { name: "delete_table", arguments: { table_name: "x", userId: "user" } },
  ]) await expect(host.handle(body, active)).rejects.toThrow(/Extra fields/);
  await expect(host.handle({ name: "list_tables", arguments: {} }, { ...active, botId: "" })).rejects.toThrow(/authenticated/);
});

it("rechecks capability liveness immediately before storage and refuses an unconfigured host", async () => {
  let assertions = 0;
  await expect(host.handle({ name: "execute_data", arguments: { sql: "CREATE TABLE should_not_exist (id INTEGER)" } }, {
    botId: "alice", allowSharedData: true, assertActive() { if (++assertions === 2) throw new Error("fixture capability expired"); },
  })).rejects.toThrow(/capability expired/);
  expect(await host.handle({ name: "list_tables", arguments: {} }, active)).toEqual({ tables: [] });
  await expect(createOpenBotDataHost(undefined).handle({ name: "list_tables", arguments: {} }, active)).rejects.toThrow(/not configured/);
});

it("refuses global data without an explicit host grant before opening a child", async () => {
  for (const allowSharedData of [false, undefined]) await expect(host.handle({ name: "query_data", arguments: { sql: "SELECT 1" } }, { ...active, allowSharedData } as typeof active)).rejects.toMatchObject({ code: "forbidden" });
});

it("proves adapter → authenticated HTTP → ownership checks → persisted synthetic SQLite state", async () => {
  const requests: Array<{ authenticatedBot: string; body: unknown }> = [];
  const tokens = new Map([["fixture-alice", "alice"], ["fixture-bob", "bob"]]);
  const server = createServer(async (req, res) => {
    if (req.url !== OPENBOT_DATA_INTERNAL_PATH || req.method !== "POST") return json(res, 404, { error: "not found" });
    const botId = tokens.get(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!botId) return json(res, 401, { error: "unauthorized" });
    try {
      const body = await readBody(req);
      requests.push({ authenticatedBot: botId, body });
      return json(res, 200, await host.handle(body, { botId, allowSharedData: true, assertActive() {} }));
    } catch (error) {
      if (error instanceof OpenBotDataError) return json(res, openBotDataErrorStatus(error), { error: error.message, code: error.code });
      return json(res, 500, { error: "fixture server failed" });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = (token: string): ToolCallContext => ({
    botId: "model-claimed-id-is-not-authority", threadId: "fixture-thread", depth: 0, externalRuntime: false, sharedComputers: false,
    client: createHarnessClient(url, token),
  });
  try {
    expect((await callOpenBotDataTool("list_tables", {}, context("invalid"))).isError).toBe(true);
    const created = await callOpenBotDataTool("execute_data", { sql: "CREATE TABLE contacts (id INTEGER PRIMARY KEY, email TEXT UNIQUE)" }, context("fixture-alice"));
    expect(created.isError).not.toBe(true);
    expect((await callOpenBotDataTool("execute_data", { sql: "INSERT INTO contacts (id, email) VALUES (?, ?)", params: [1, "fixture@example.test"] }, context("fixture-bob"))).isError).not.toBe(true);
    const listed = await callOpenBotDataTool("list_tables", {}, context("fixture-bob"));
    expect(JSON.parse(listed.text)).toMatchObject({ tables: [{ name: "contacts", owner_agent_id: "alice", row_count: 1 }] });
    const read = await callOpenBotDataTool("query_data", { sql: "SELECT * FROM contacts WHERE id = ?", params: [1] }, context("fixture-alice"));
    expect(JSON.parse(read.text).rows).toEqual([{ id: 1, email: "fixture@example.test" }]);
    expect((await callOpenBotDataTool("delete_table", { table_name: "contacts" }, context("fixture-bob"))).isError).toBe(true);
    expect((await callOpenBotDataTool("execute_data", { sql: "ALTER TABLE contacts ADD COLUMN stolen TEXT" }, context("fixture-bob"))).isError).toBe(true);
    expect((await callOpenBotDataTool("delete_table", { table_name: "contacts", botId: "alice" }, context("fixture-bob"))).isError).toBe(true);
    expect((await callOpenBotDataTool("delete_table", { table_name: "contacts" }, context("fixture-alice"))).isError).not.toBe(true);
    expect(await host.handle({ name: "list_tables", arguments: {} }, active)).toEqual({ tables: [] });
    expect(requests.every(({ body }) => !Object.hasOwn(body as object, "botId"))).toBe(true);
    console.info(JSON.stringify({ fixture: "synthetic-shared-sqlite", steps: requests.map(({ authenticatedBot, body }) => ({ authenticatedBot, tool: (body as { name: string }).name })), finalTables: [] }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

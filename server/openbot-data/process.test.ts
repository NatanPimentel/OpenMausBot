import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpenBotDataStore } from "./store.ts";

let directory: string;
let path: string;
const authority = { assertActive() {} };
const owner = "fixture-owner";
const withRaw = (work: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(path);
  try { work(db); } finally { db.close(); }
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-data-process-fixture-"));
  path = join(directory, "synthetic.db");
  withRaw(db => {
    db.exec("CREATE TABLE openbot_metadata(table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE numbers(n INTEGER PRIMARY KEY); CREATE TABLE values_data(value INTEGER)");
    db.exec("INSERT INTO numbers VALUES " + Array.from({ length: 300 }, (_, n) => `(${n})`).join(","));
    db.prepare("INSERT INTO openbot_metadata VALUES (?, ?, ?)").run("numbers", owner, "fixture");
    db.prepare("INSERT INTO openbot_metadata VALUES (?, ?, ?)").run("values_data", owner, "fixture");
  });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("keeps the parent responsive and kills an expensive finite aggregate at its deadline", async () => {
  const pids: number[] = [];
  const store = createOpenBotDataStore(path, { timeoutMs: 800, onEngineStart: pid => pids.push(pid) });
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  const started = Date.now();
  try {
    await expect(store.query(owner, { sql: "SELECT SUM(a.n + b.n + c.n + d.n) AS total FROM numbers a CROSS JOIN numbers b CROSS JOIN numbers c CROSS JOIN numbers d" }, authority)).rejects.toMatchObject({ code: "timeout" });
  } finally { clearInterval(heartbeat); }
  expect(ticks).toBeGreaterThan(5);
  expect(Date.now() - started).toBeLessThan(2_500);
  expect(pids).toHaveLength(1);
  expect(() => process.kill(pids[0]!, 0)).toThrow();
  expect((await createOpenBotDataStore(path).query(owner, { sql: "SELECT COUNT(*) AS n FROM numbers" }, authority)).rows).toEqual([{ n: 300 }]);
});

it("applies the SQLite and JavaScript heap budgets inside the isolated engine", async () => {
  const budgets: Array<{ sqliteHeapBytes: number; javascriptHeapBytes: number }> = [];
  const store = createOpenBotDataStore(path, { onResourceBudget: budget => budgets.push(budget) });
  expect((await store.query(owner, { sql: "SELECT ? AS value", params: ["fixture within resource budget"] }, authority)).rows).toEqual([{ value: "fixture within resource budget" }]);
  expect(budgets).toHaveLength(1);
  expect(budgets[0]!.sqliteHeapBytes).toBe(32 * 1024 * 1024);
  expect(budgets[0]!.javascriptHeapBytes).toBeLessThan(128 * 1024 * 1024);
});

it("rolls back a prepared DDL and ownership row when authority is revoked before commit", async () => {
  let live = true;
  let requestedCommit = false;
  const pids: number[] = [];
  const store = createOpenBotDataStore(path, {
    onEngineStart: pid => pids.push(pid),
    onCommitReady() { requestedCommit = true; live = false; },
  });
  await expect(store.execute(owner, { sql: "CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)" }, {
    assertActive() { if (!live) throw new Error("fixture authority expired before commit"); },
  })).rejects.toThrow(/authority expired/);
  expect(requestedCommit).toBe(true);
  expect(() => process.kill(pids[0]!, 0)).toThrow();
  const clean = createOpenBotDataStore(path);
  expect((await clean.listTables(owner, authority)).tables.map(table => table.name)).toEqual(["numbers", "values_data"]);
  withRaw(db => expect(db.prepare("SELECT * FROM openbot_metadata WHERE table_name = ?").all("should_rollback")).toEqual([]));
});

it("cancels a long write after revocation, releases its lock and preserves its prior rows", async () => {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const store = createOpenBotDataStore(path, { onEngineStart() { timer = setTimeout(() => { live = false; }, 150); } });
  try {
    await expect(store.execute(owner, { sql: "INSERT INTO values_data SELECT a.n + b.n + c.n + d.n FROM numbers a CROSS JOIN numbers b CROSS JOIN numbers c CROSS JOIN numbers d" }, {
      assertActive() { if (!live) throw new Error("fixture authority revoked during write"); },
    })).rejects.toThrow(/authority revoked/);
  } finally { if (timer) clearTimeout(timer); }
  const clean = createOpenBotDataStore(path);
  expect((await clean.query(owner, { sql: "SELECT COUNT(*) AS n FROM values_data" }, authority)).rows).toEqual([{ n: 0 }]);
  await clean.execute(owner, { sql: "INSERT INTO values_data(value) VALUES (?)", params: [42] }, authority);
  expect((await clean.query(owner, { sql: "SELECT value FROM values_data" }, authority)).rows).toEqual([{ value: 42 }]);
});

it("does not deliver a read result after its authority has expired", async () => {
  let live = true;
  let resultReady = false;
  const store = createOpenBotDataStore(path, { onResultReady() { resultReady = true; live = false; } });
  await expect(store.query(owner, { sql: "SELECT n FROM numbers LIMIT 1" }, { assertActive() { if (!live) throw new Error("fixture read authority expired"); } })).rejects.toThrow(/read authority expired/);
  expect(resultReady).toBe(true);
});

it("accepts a write only after commit authorization and preserves shared row permissions", async () => {
  let commits = 0;
  const store = createOpenBotDataStore(path, { onCommitReady() { commits++; } });
  await store.execute("fixture-peer", { sql: "INSERT INTO values_data(value) VALUES (?)", params: [7] }, authority);
  expect(commits).toBe(1);
  expect((await store.query(owner, { sql: "SELECT value FROM values_data" }, authority)).rows).toEqual([{ value: 7 }]);
  await expect(store.deleteTable("fixture-peer", "values_data", authority)).rejects.toMatchObject({ code: "forbidden" });
});

it("reports a committed write as committed even when authority ends after the commit vote", async () => {
  let live = true;
  const store = createOpenBotDataStore(path, { onResultReady() { live = false; } });
  const result = await store.execute(owner, { sql: "INSERT INTO values_data(value) VALUES (?)", params: [9] }, {
    assertActive() { if (!live) throw new Error("fixture authority ended after commit"); },
  });
  expect(result).toBeTruthy();
  expect((await createOpenBotDataStore(path).query(owner, { sql: "SELECT value FROM values_data" }, authority)).rows).toEqual([{ value: 9 }]);
});

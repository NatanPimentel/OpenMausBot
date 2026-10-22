import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { createOpenBotDataEngine, type PreparedDataWrite } from "./engine.ts";
import { OpenBotDataError, OPENBOT_DATA_LIMITS } from "./sql.ts";
import { DATA_PROCESS_LIMITS, dataProcessEnvironment, type DataChildMessage, type DataControl, type DataReply, type DataRun } from "./protocol.ts";

const failure = (code: OpenBotDataError["code"], message: string): DataReply => ({ type: "result", ok: false, error: { code, message } });
const exitWith = (reply: DataReply) => {
  if (!process.connected || !process.send) return process.exit(0);
  process.send(reply, () => { process.disconnect?.(); process.exit(0); });
};

function engine() {
  let prepared: PreparedDataWrite | undefined;
  let used = false;
  process.on("message", (message: DataRun | DataControl) => {
    if (message?.type === "commit" && prepared) {
      try {
        if (!message.allowed) throw new OpenBotDataError("cancelled", "The data request was cancelled before commit.");
        const value = prepared.commit();
        prepared = undefined;
        return exitWith({ type: "result", ok: true, value });
      } catch (error) {
        prepared?.rollback();
        return exitWith(error instanceof OpenBotDataError ? failure(error.code, error.message) : failure("query_failed", "The SQLite transaction did not commit."));
      }
    }
    if (message?.type !== "run" || used) return;
    used = true;
    try {
      const budget = new DatabaseSync(":memory:");
      try {
        const applied = budget.prepare(`PRAGMA hard_heap_limit = ${DATA_PROCESS_LIMITS.sqliteHeapBytes}`).get();
        const bytes = Number(applied?.hard_heap_limit);
        if (!Number.isFinite(bytes) || bytes <= 0 || bytes > DATA_PROCESS_LIMITS.sqliteHeapBytes) throw new OpenBotDataError("unavailable", "The SQLite memory budget could not be applied.");
        process.send?.({ type: "budget_applied", budget: { sqliteHeapBytes: bytes, javascriptHeapBytes: getHeapStatistics().heap_size_limit } });
      } finally { budget.close(); }
      const store = createOpenBotDataEngine(message.databasePath);
      const request = message.operation;
      if (request.name === "execute_data" || request.name === "delete_table") {
        prepared = request.name === "execute_data" ? store.prepareExecute(message.botId, request.arguments) : store.prepareDeleteTable(message.botId, request.arguments.table_name);
        process.send?.({ type: "commit_ready" });
        return;
      }
      const value = request.name === "list_tables" ? store.listTables(message.botId) : store.query(message.botId, request.arguments);
      if (Buffer.byteLength(JSON.stringify(value)) > OPENBOT_DATA_LIMITS.resultBytes + 10_000) throw new OpenBotDataError("limit_exceeded", "The data result exceeds its response budget.");
      exitWith({ type: "result", ok: true, value });
    } catch (error) {
      prepared?.rollback();
      exitWith(error instanceof OpenBotDataError ? failure(error.code, error.message) : failure("query_failed", "The isolated SQLite operation failed."));
    }
  });
  process.once("disconnect", () => { prepared?.rollback(); process.exit(0); });
  process.once("SIGTERM", () => { prepared?.rollback(); process.exit(0); });
}

function supervise() {
  let worker: ChildProcess | undefined;
  let reply: DataReply | undefined;
  let stopping: DataReply | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let used = false;
  let commitSent = false;
  const stop = (reason: DataReply) => {
    if (stopping) return;
    stopping = reason;
    if (!worker) return exitWith(reason);
    worker.kill("SIGTERM");
    killTimer = setTimeout(() => worker?.kill("SIGKILL"), DATA_PROCESS_LIMITS.terminationGraceMs);
  };
  process.on("message", (message: DataRun | DataControl) => {
    if (message?.type === "cancel") return stop(failure("cancelled", "The data request was cancelled."));
    if (message?.type === "commit") {
      if (!stopping && worker?.connected) { commitSent = message.allowed === true; worker.send(message, () => {}); }
      return;
    }
    if (message?.type !== "run" || used) return;
    used = true;
    const remaining = Math.min(DATA_PROCESS_LIMITS.timeoutMs, message.deadline - Date.now());
    if (remaining <= 0) return stop(failure("timeout", "The data request exceeded its execution deadline."));
    worker = spawn(process.execPath, [`--max-old-space-size=${DATA_PROCESS_LIMITS.engineHeapMb}`, `--max-semi-space-size=${DATA_PROCESS_LIMITS.semiSpaceMb}`, fileURLToPath(import.meta.url), "--sqlite-engine"], {
      env: dataProcessEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    timer = setTimeout(() => stop(failure("timeout", "The data request exceeded its execution deadline.")), remaining);
    if (worker.pid) process.send?.({ type: "engine_started", pid: worker.pid });
    worker.on("message", (response: DataChildMessage) => {
      if (response?.type === "result") reply = response;
      else if ((response?.type === "commit_ready" || response?.type === "budget_applied") && !stopping && process.connected) process.send?.(response);
    });
    worker.once("error", () => stop(failure("unavailable", "The isolated SQLite process could not start.")));
    worker.once("close", () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      exitWith(reply ?? (commitSent ? failure("commit_uncertain", "The write was authorized to commit but its outcome could not be confirmed. Check the data before retrying.") : stopping) ?? failure("limit_exceeded", "The isolated SQLite process stopped before completing within its resource budget."));
    });
    worker.send(message, error => { if (error) stop(failure("unavailable", "The isolated SQLite process could not receive the request.")); });
  });
  process.once("disconnect", () => stop(failure("cancelled", "The data request was cancelled.")));
  process.once("SIGTERM", () => stop(failure("cancelled", "The data request was cancelled.")));
  process.once("SIGINT", () => stop(failure("cancelled", "The data request was cancelled.")));
}

if (process.argv[2] === "--sqlite-engine") engine();
else supervise();

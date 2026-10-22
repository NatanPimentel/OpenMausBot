import { spawn } from "node:child_process";
import { resolveProxy } from "../proxy-paths.ts";
import { OpenBotDataError, type DataQueryInput, type DataSqlInput } from "./sql.ts";
import { DATA_PROCESS_LIMITS, dataProcessEnvironment, type DataChildMessage, type DataOperation, type DataReply, type DataResourceBudget, type DataResult, type DataRun } from "./protocol.ts";
import type { ExecuteResult, QueryResult, SharedTable } from "./engine.ts";

export { OpenBotDataError, OPENBOT_DATA_LIMITS } from "./sql.ts";
export type { DataQueryInput, DataSqlInput } from "./sql.ts";

export interface DataExecutionAuthority { assertActive(): void; signal?: AbortSignal }
export interface DataStoreOptions {
  /** Trusted callers may shorten the fixed process deadline, never extend it. */
  timeoutMs?: number;
  onEngineStart?(pid: number): void;
  onCommitReady?(): void;
  onResourceBudget?(budget: DataResourceBudget): void;
  onResultReady?(): void;
}

let activeProcesses = 0;
const CHILD = resolveProxy("openbot-data/child");

/** Every request has a separate supervisor and SQLite process; no SQLite step runs on the server event loop. */
export function createOpenBotDataStore(databasePath: string, options: DataStoreOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DATA_PROCESS_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DATA_PROCESS_LIMITS.timeoutMs) throw new OpenBotDataError("invalid_input", "The host data deadline must be between 100 and 5,000 milliseconds.");
  const run = (botId: string, operation: DataOperation, authority: DataExecutionAuthority): Promise<DataResult> => {
    const authorize = () => {
      if (authority.signal?.aborted) throw new OpenBotDataError("cancelled", "The data request was cancelled.");
      authority.assertActive();
    };
    try {
      authorize();
      if (activeProcesses >= DATA_PROCESS_LIMITS.maxConcurrent) throw new OpenBotDataError("unavailable", "Shared data is busy. Retry after the current requests finish.");
      if (!botId || typeof botId !== "string" || botId.length > 255) throw new OpenBotDataError("forbidden", "An authenticated bot identity is required.");
    } catch (error) { return Promise.reject(error); }
    const request: DataRun = { type: "run", databasePath, botId, operation, deadline: Date.now() + timeoutMs };
    if (Buffer.byteLength(JSON.stringify(request)) > DATA_PROCESS_LIMITS.wireBytes) return Promise.reject(new OpenBotDataError("limit_exceeded", "The data request exceeds its transport budget."));
    activeProcesses++;
    return new Promise<DataResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, [`--max-old-space-size=${DATA_PROCESS_LIMITS.supervisorHeapMb}`, `--max-semi-space-size=${DATA_PROCESS_LIMITS.semiSpaceMb}`, CHILD], {
          env: dataProcessEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
        });
      } catch {
        activeProcesses--;
        return reject(new OpenBotDataError("unavailable", "The isolated data process could not start."));
      }
      let enginePid: number | undefined;
      let reply: DataReply | undefined;
      let failure: unknown;
      let settled = false;
      let committed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killEngine = () => { if (enginePid) { try { process.kill(enginePid, "SIGKILL"); } catch {} } };
      const cancel = (reason: unknown) => {
        if (settled || failure) return;
        if (committed) {
          // The supervisor enforces the deadline on the commit itself; only a hung supervisor is killed here.
          if (!killTimer && reason instanceof OpenBotDataError && reason.code === "timeout") {
            killTimer = setTimeout(() => { killEngine(); child.kill("SIGKILL"); }, DATA_PROCESS_LIMITS.parentGraceMs);
          }
          return;
        }
        failure = reason;
        if (child.connected) child.send({ type: "cancel" }, () => {});
        killTimer = setTimeout(() => {
          killEngine();
          child.kill("SIGKILL");
        }, DATA_PROCESS_LIMITS.parentGraceMs);
      };
      const cancelled = () => cancel(new OpenBotDataError("cancelled", "The data request was cancelled."));
      const timer = setTimeout(() => cancel(new OpenBotDataError("timeout", "The data request exceeded its execution deadline.")), timeoutMs);
      const authorityTimer = setInterval(() => { try { authorize(); } catch (error) { cancel(error); } }, DATA_PROCESS_LIMITS.authorityIntervalMs);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(authorityTimer);
        if (killTimer) clearTimeout(killTimer);
        authority.signal?.removeEventListener("abort", cancelled);
        activeProcesses--;
        if (committed) {
          if (!reply) return reject(new OpenBotDataError("commit_uncertain", "The write was authorized to commit but its outcome could not be confirmed. Check the data before retrying."));
          return reply.ok ? resolve(reply.value) : reject(new OpenBotDataError(reply.error.code, reply.error.message));
        }
        if (failure) return reject(failure);
        try { authorize(); } catch (error) { return reject(error); }
        if (!reply) return reject(new OpenBotDataError("unavailable", "The isolated data process stopped before returning a result."));
        return reply.ok ? resolve(reply.value) : reject(new OpenBotDataError(reply.error.code, reply.error.message));
      };
      authority.signal?.addEventListener("abort", cancelled, { once: true });
      child.on("message", (message: DataChildMessage) => {
        if (!message || typeof message !== "object") return cancel(new OpenBotDataError("unavailable", "The isolated data process returned an invalid reply."));
        if (message.type === "engine_started") {
          if (!Number.isSafeInteger(message.pid) || message.pid <= 0) return cancel(new OpenBotDataError("unavailable", "The isolated data process returned an invalid process identity."));
          enginePid = message.pid;
          if (failure) return killEngine();
          try { options.onEngineStart?.(message.pid); } catch (error) { cancel(error); }
        } else if (message.type === "commit_ready") {
          if (failure) return;
          try {
            options.onCommitReady?.();
            authorize();
            if (Date.now() >= request.deadline) throw new OpenBotDataError("timeout", "The data request exceeded its execution deadline.");
            committed = true;
            child.send({ type: "commit", allowed: true }, () => {});
          } catch (error) { cancel(error); }
        } else if (message.type === "budget_applied") {
          try { options.onResourceBudget?.(message.budget); } catch (error) { cancel(error); }
        } else if (message.type === "result") {
          try { options.onResultReady?.(); reply = message; } catch (error) { cancel(error); }
        }
      });
      child.once("error", () => cancel(new OpenBotDataError("unavailable", "The isolated data process could not start.")));
      child.once("close", finish);
      if (child.connected) child.send(request, error => { if (error) cancel(new OpenBotDataError("unavailable", "The isolated data process could not receive the request.")); });
      else cancel(new OpenBotDataError("unavailable", "The isolated data process could not start."));
    });
  };
  return {
    listTables: (botId: string, authority: DataExecutionAuthority) => run(botId, { name: "list_tables", arguments: {} }, authority) as Promise<{ tables: SharedTable[] }>,
    query: (botId: string, input: DataQueryInput, authority: DataExecutionAuthority) => run(botId, { name: "query_data", arguments: input }, authority) as Promise<QueryResult>,
    execute: (botId: string, input: DataSqlInput, authority: DataExecutionAuthority) => run(botId, { name: "execute_data", arguments: input }, authority) as Promise<ExecuteResult>,
    deleteTable: (botId: string, tableName: string, authority: DataExecutionAuthority) => run(botId, { name: "delete_table", arguments: { table_name: tableName } }, authority) as Promise<ExecuteResult>,
  };
}

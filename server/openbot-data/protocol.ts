import type { ExecuteResult, QueryResult, SharedTable } from "./engine.ts";
import type { DataErrorCode, DataQueryInput, DataSqlInput } from "./sql.ts";

export const DATA_PROCESS_LIMITS = Object.freeze({ timeoutMs: 5_000, terminationGraceMs: 100, parentGraceMs: 1_000, authorityIntervalMs: 25, maxConcurrent: 2, engineHeapMb: 64, supervisorHeapMb: 32, semiSpaceMb: 4, sqliteHeapBytes: 32 * 1024 * 1024, wireBytes: 3_000_000 });
export type DataOperation = { name: "list_tables"; arguments: Record<string, never> }
  | { name: "query_data"; arguments: DataQueryInput }
  | { name: "execute_data"; arguments: DataSqlInput }
  | { name: "delete_table"; arguments: { table_name: string } };
export type DataResult = { tables: SharedTable[] } | QueryResult | ExecuteResult;
export type DataReply = { type: "result"; ok: true; value: DataResult } | { type: "result"; ok: false; error: { code: DataErrorCode; message: string } };
export type DataRun = { type: "run"; databasePath: string; botId: string; operation: DataOperation; deadline: number };
export type DataControl = { type: "cancel" } | { type: "commit"; allowed: boolean };
export interface DataResourceBudget { sqliteHeapBytes: number; javascriptHeapBytes: number }
export type DataChildMessage = DataReply | { type: "commit_ready" } | { type: "engine_started"; pid: number } | { type: "budget_applied"; budget: DataResourceBudget };

/** Absolute runtime paths and the Node flag work both for a normal Node binary and packaged Electron. No account environment crosses. */
export function dataProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" };
  for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

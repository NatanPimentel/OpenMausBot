import { z } from "zod";
import { createOpenBotDataStore, OpenBotDataError, type DataStoreOptions } from "./store.ts";

const params = z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(1_000).optional();
const sql = z.string().min(1).max(64_000);
const sqlArgs = z.object({ sql, params }).strict();
const requestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("list_tables"), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal("query_data"), arguments: z.object({ sql, params, limit: z.number().int().min(1).max(500).optional() }).strict() }).strict(),
  z.object({ name: z.literal("execute_data"), arguments: sqlArgs }).strict(),
  z.object({ name: z.literal("delete_table"), arguments: z.object({ table_name: z.string().min(1).max(255) }).strict() }).strict(),
]);

export interface OpenBotDataCallContext {
  /** Derived from the active agents capability by the server, never from request arguments. */
  botId: string;
  allowSharedData: boolean;
  assertActive(): void;
  signal?: AbortSignal;
}

export function openBotDataErrorStatus(error: OpenBotDataError): number {
  if (error.code === "forbidden") return 403;
  if (error.code === "unavailable") return 503;
  if (error.code === "invalid_input") return 400;
  if (error.code === "limit_exceeded") return 413;
  if (error.code === "timeout") return 408;
  if (error.code === "cancelled") return 409;
  if (error.code === "commit_uncertain") return 500;
  return 422;
}

/** The host must authenticate an active agents capability before calling handle; request data cannot select a bot or database. */
export function createOpenBotDataHost(databasePath: string | undefined, options: DataStoreOptions = {}) {
  const store = databasePath ? createOpenBotDataStore(databasePath, options) : undefined;
  return {
    async handle(body: unknown, context: OpenBotDataCallContext) {
      context.assertActive();
      if (context.allowSharedData !== true) throw new OpenBotDataError("forbidden", "This turn cannot access the global shared database.");
      if (!context.botId || typeof context.botId !== "string") throw new OpenBotDataError("forbidden", "An authenticated bot identity is required.");
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) throw new OpenBotDataError("invalid_input", "Use list_tables {}, query_data {sql, params?, limit?}, execute_data {sql, params?} or delete_table {table_name}. Extra fields, bot identities and database paths are not accepted.");
      if (!store) throw new OpenBotDataError("unavailable", "The shared OpenBot database is not configured on this host.");
      context.assertActive();
      const request = parsed.data;
      let result;
      switch (request.name) {
        case "list_tables": result = await store.listTables(context.botId, context); break;
        case "query_data": result = await store.query(context.botId, request.arguments, context); break;
        case "execute_data": result = await store.execute(context.botId, request.arguments, context); break;
        case "delete_table": result = await store.deleteTable(context.botId, request.arguments.table_name, context); break;
      }
      if (request.name === "list_tables" || request.name === "query_data") context.assertActive();
      return result;
    },
  };
}

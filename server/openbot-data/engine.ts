import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { constants as S, DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { OPENBOT_DATA_LIMITS, OpenBotDataError, parseSql, protectedTable, quoteIdentifier, readName, tokenWord, type DataQueryInput, type DataSqlInput, type ParsedSql } from "./sql.ts";

export { OpenBotDataError, OPENBOT_DATA_LIMITS } from "./sql.ts";
export type { DataQueryInput, DataSqlInput } from "./sql.ts";

interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }
interface OwnerRow { table_name: string; owner_agent_id: string; created_at: string }
interface Catalog { schema: SchemaRow[]; tables: Map<string, SchemaRow>; owners: Map<string, OwnerRow> }
interface Ddl { kind: "create_table" | "alter_table" | "drop_table" | "create_index" | "drop_index"; table: string; index?: string; renamed?: string; existing: boolean; autoincrement: boolean }
export interface SharedTable { name: string; schema: string | null; row_count: number; owner_agent_id: string | null; created_at: string | null }
export interface QueryResult { rows: Record<string, unknown>[]; columns: string[]; row_count: number; truncated: boolean }
export interface ExecuteResult { changes: number; last_insert_rowid: number | string; table?: string }
export interface PreparedDataWrite { result: ExecuteResult; commit(): ExecuteResult; rollback(): void }

const lower = (name: string) => name.replace(/[A-Z]/g, char => char.toLowerCase());
const SAFE_FUNCTIONS = new Set(("abs acos acosh asin asinh atan atan2 atanh avg ceil ceiling changes char coalesce concat concat_ws cos cosh count cume_dist date datetime degrees dense_rank exp first_value floor format glob group_concat hex if ifnull iif instr json json_array json_array_length json_error_position json_extract json_insert json_object json_patch json_pretty json_quote json_remove json_replace json_set json_type json_valid jsonb jsonb_array jsonb_extract jsonb_insert jsonb_object jsonb_patch jsonb_remove jsonb_replace jsonb_set json_group_array json_group_object jsonb_group_array jsonb_group_object julianday lag last_insert_rowid last_value lead length like likelihood likely ln log log10 log2 lower ltrim max min mod nth_value ntile nullif octet_length percent_rank pi pow power printf quote radians random rank replace round row_number rtrim sign sin sinh soundex sqrt strftime string_agg substr substring sum tan tanh timediff time total trim trunc typeof unhex unicode unixepoch unlikely upper -> ->>").split(" "));
const SCHEMA_TABLES = new Set(["sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"]);
const ALTER_FUNCTIONS = new Set(["sqlite_rename_table", "sqlite_rename_column", "sqlite_rename_test", "sqlite_rename_quotefix", "sqlite_drop_column"]);
const SQLITE_AUTH_ERROR = 23;

function scalar(value: SQLOutputValue): unknown {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  return value;
}

function authorize(db: DatabaseSync, mode: "query" | "rows" | "ddl" | "metadata", catalog: Catalog, ddl?: Ddl): void {
  const storedSources = new Set(catalog.schema.filter(row => row.type === "trigger" || row.type === "view").map(row => lower(row.name)));
  db.setAuthorizer((action, first, second, database, source) => {
    // SQLite 3.53's ALTER_TABLE callback puts the database in first; database can contain the dropped column.
    if (action === S.SQLITE_ALTER_TABLE) return !source && mode === "ddl" && ddl!.kind === "alter_table" && first === "main" && lower(second ?? "") === lower(ddl!.table) ? S.SQLITE_OK : S.SQLITE_DENY;
    if ((source && (mode === "metadata" || storedSources.has(lower(source)))) || (database !== null && database !== "main" && !(mode === "ddl" && database === "temp"))) return S.SQLITE_DENY;
    const table = lower(first ?? "");
    const isSchema = SCHEMA_TABLES.has(table);
    if (action === S.SQLITE_SELECT || (action === S.SQLITE_RECURSIVE && mode !== "metadata")) return S.SQLITE_OK;
    if (action === S.SQLITE_FUNCTION) {
      const name = lower(second ?? first ?? "");
      return SAFE_FUNCTIONS.has(name) || (mode === "ddl" && ALTER_FUNCTIONS.has(name)) ? S.SQLITE_OK : S.SQLITE_DENY;
    }
    if (mode === "metadata") {
      return table === "openbot_metadata" && [S.SQLITE_READ, S.SQLITE_INSERT, S.SQLITE_UPDATE, S.SQLITE_DELETE].includes(action) ? S.SQLITE_OK : S.SQLITE_DENY;
    }
    if (action === S.SQLITE_READ) {
      if (mode === "ddl" && isSchema) return S.SQLITE_OK;
      if (protectedTable(table)) return S.SQLITE_DENY;
      return catalog.tables.has(table) || (mode === "ddl" && (table === lower(ddl!.table) || table === lower(ddl!.renamed ?? ""))) ? S.SQLITE_OK : S.SQLITE_DENY;
    }
    if ([S.SQLITE_INSERT, S.SQLITE_UPDATE, S.SQLITE_DELETE].includes(action)) {
      if (mode === "ddl" && isSchema) return S.SQLITE_OK;
      if (protectedTable(table)) return S.SQLITE_DENY;
      if (mode === "rows") return catalog.tables.has(table) ? S.SQLITE_OK : S.SQLITE_DENY;
      return mode === "ddl" && table === lower(ddl!.table) ? S.SQLITE_OK : S.SQLITE_DENY;
    }
    if (mode !== "ddl") return S.SQLITE_DENY;
    if (action === S.SQLITE_CREATE_TABLE) return ddl!.kind === "create_table" && (table === lower(ddl!.table) || (ddl!.autoincrement && table === "sqlite_sequence")) ? S.SQLITE_OK : S.SQLITE_DENY;
    if (action === S.SQLITE_DROP_TABLE) return ddl!.kind === "drop_table" && table === lower(ddl!.table) ? S.SQLITE_OK : S.SQLITE_DENY;
    if (action === S.SQLITE_CREATE_INDEX) return ((ddl!.kind === "create_index" && table === lower(ddl!.index!)) || (ddl!.kind === "create_table" && table.startsWith("sqlite_autoindex_"))) && lower(second ?? "") === lower(ddl!.table) ? S.SQLITE_OK : S.SQLITE_DENY;
    if (action === S.SQLITE_DROP_INDEX) return (ddl!.kind === "drop_index" && table === lower(ddl!.index!)) || ((ddl!.kind === "drop_table" || ddl!.kind === "alter_table") && lower(second ?? "") === lower(ddl!.table)) ? S.SQLITE_OK : S.SQLITE_DENY;
    if (action === S.SQLITE_REINDEX) return ddl!.kind === "create_index" && table === lower(ddl!.index!) ? S.SQLITE_OK : S.SQLITE_DENY;
    return S.SQLITE_DENY;
  });
}

function readCatalog(db: DatabaseSync): Catalog {
  db.setAuthorizer(null);
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name").all() as unknown as SchemaRow[];
  if (!schema.some(row => row.name === "openbot_metadata" && row.type === "table")) throw new OpenBotDataError("unavailable", "The shared database has no canonical ownership metadata. No tables were adopted or changed.");
  const metadataColumns = db.prepare('PRAGMA main.table_info("openbot_metadata")').all();
  if (!["table_name", "owner_agent_id", "created_at"].every(column => metadataColumns.some(row => row.name === column))) throw new OpenBotDataError("unavailable", "The shared database ownership metadata has an unsupported schema.");
  const rows = db.prepare("SELECT table_name, owner_agent_id, created_at FROM main.openbot_metadata").all() as unknown as OwnerRow[];
  const owners = new Map<string, OwnerRow>();
  for (const row of rows) {
    if (typeof row.table_name !== "string" || typeof row.owner_agent_id !== "string" || !row.owner_agent_id || typeof row.created_at !== "string" || owners.has(lower(row.table_name))) throw new OpenBotDataError("unavailable", "The shared database ownership metadata is inconsistent. No tables were changed.");
    owners.set(lower(row.table_name), row);
  }
  return { schema, owners, tables: new Map(schema.filter(row => row.type === "table" && !protectedTable(row.name)).map(row => [lower(row.name), row])) };
}

function requireOwner(catalog: Catalog, table: string, botId: string): void {
  if (catalog.owners.get(lower(table))?.owner_agent_id !== botId) throw new OpenBotDataError("forbidden", "Another bot owns this table, or it has no recorded owner. Only its creator can alter or remove it.");
}

function parseDdl(parsed: ParsedSql, catalog: Catalog, botId: string): Ddl {
  const tokens = parsed.tokens;
  let offset = 1;
  let kind: Ddl["kind"];
  let index: string | undefined;
  let table: string;
  let renamed: string | undefined;
  if (parsed.command === "CREATE") {
    if (tokenWord(tokens[offset], "UNIQUE")) offset++;
    if (tokenWord(tokens[offset], "TABLE")) kind = "create_table";
    else if (tokenWord(tokens[offset], "INDEX")) kind = "create_index";
    else throw new OpenBotDataError("forbidden", "Only ordinary shared tables and their indexes can be created. Temporary tables, views, triggers and virtual tables are unavailable.");
    offset++;
    if (tokenWord(tokens[offset], "IF") && tokenWord(tokens[offset + 1], "NOT") && tokenWord(tokens[offset + 2], "EXISTS")) offset += 3;
    const name = readName(tokens, offset);
    offset = name.next;
    if (kind === "create_table") table = name.name;
    else {
      index = name.name;
      if (!tokenWord(tokens[offset], "ON")) throw new OpenBotDataError("invalid_input", "CREATE INDEX needs ON and an owned table.");
      table = readName(tokens, offset + 1).name;
    }
  } else if (parsed.command === "ALTER" && tokenWord(tokens[offset], "TABLE")) {
    kind = "alter_table";
    const name = readName(tokens, offset + 1);
    table = name.name;
    offset = name.next;
    if (tokenWord(tokens[offset], "RENAME") && tokenWord(tokens[offset + 1], "TO")) renamed = readName(tokens, offset + 2).name;
    else if (!["ADD", "DROP", "RENAME"].some(word => tokenWord(tokens[offset], word))) throw new OpenBotDataError("forbidden", "Only ADD, DROP and RENAME changes to an owned table are available.");
  } else if (parsed.command === "DROP") {
    if (tokenWord(tokens[offset], "TABLE")) kind = "drop_table";
    else if (tokenWord(tokens[offset], "INDEX")) kind = "drop_index";
    else throw new OpenBotDataError("forbidden", "Only owned tables and their indexes can be removed.");
    offset++;
    if (tokenWord(tokens[offset], "IF") && tokenWord(tokens[offset + 1], "EXISTS")) offset += 2;
    const name = readName(tokens, offset);
    if (kind === "drop_table") table = name.name;
    else {
      index = name.name;
      const existingIndex = catalog.schema.find(row => row.type === "index" && lower(row.name) === lower(index!));
      if (!existingIndex) throw new OpenBotDataError("invalid_input", "That shared index does not exist.");
      table = existingIndex.tbl_name;
    }
  } else throw new OpenBotDataError("forbidden", "Only ordinary owned-table DDL is available.");
  const existing = catalog.tables.has(lower(table));
  if (kind !== "create_table" || existing) requireOwner(catalog, table, botId);
  if (renamed && (catalog.tables.has(lower(renamed)) || catalog.owners.has(lower(renamed)))) throw new OpenBotDataError("forbidden", "The new table name already exists or already has an owner.");
  if (kind === "create_table" && !existing && catalog.owners.has(lower(table))) throw new OpenBotDataError("forbidden", "That table name already has an ownership record.");
  return { kind, table, index, renamed, existing, autoincrement: kind === "create_table" && tokens.some(token => tokenWord(token, "AUTOINCREMENT")) };
}

function validateSchemaChange(before: Catalog, after: Catalog, ddl: Ddl): void {
  const keys = (schema: SchemaRow[]) => new Map(schema.map(row => [`${row.type}:${row.name}`, row]));
  const oldRows = keys(before.schema);
  const newRows = keys(after.schema);
  for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
    const previous = oldRows.get(key);
    const next = newRows.get(key);
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    if (ddl.autoincrement && !previous && next?.type === "table" && next.name === "sqlite_sequence") continue;
    for (const row of [previous, next]) {
      if (!row) continue;
      const target = lower(row.tbl_name) === lower(ddl.table) || (ddl.renamed !== undefined && lower(row.tbl_name) === lower(ddl.renamed));
      if (!target || (row.type !== "table" && row.type !== "index")) throw new OpenBotDataError("forbidden", "This schema change would also alter another table, view or trigger. It was rolled back.");
      if ((ddl.kind === "create_index" || ddl.kind === "drop_index") && (row.type !== "index" || lower(row.name) !== lower(ddl.index!))) throw new OpenBotDataError("forbidden", "An index change cannot alter a table schema. It was rolled back.");
    }
  }
}

function databaseSize(db: DatabaseSync): number {
  db.setAuthorizer(null);
  return Number(db.prepare("PRAGMA main.page_count").get()!.page_count) * Number(db.prepare("PRAGMA main.page_size").get()!.page_size);
}

/** Synchronous SQLite belongs only to the isolated engine process, never the server event loop. */
export function createOpenBotDataEngine(databasePath: string) {
  const connect = (readOnly: boolean) => {
    if (!isAbsolute(databasePath)) throw new OpenBotDataError("unavailable", "The shared database path must be configured by the host.");
    try {
      if (!statSync(databasePath).isFile()) throw new Error("not a regular file");
      const db = new DatabaseSync(databasePath, { allowExtension: false, enableDoubleQuotedStringLiterals: false, enableForeignKeyConstraints: true, timeout: 1_000 });
      // A killed writer can leave a hot journal; SQLite must recover it before a read-only query begins.
      db.prepare("SELECT name FROM main.sqlite_schema LIMIT 0").all();
      if (readOnly) db.exec("PRAGMA query_only = ON");
      db.enableDefensive(true);
      db.exec("PRAGMA trusted_schema = OFF");
      db.exec("PRAGMA temp_store = MEMORY");
      db.exec("PRAGMA mmap_size = 0");
      db.exec("PRAGMA cache_size = -4096");
      if (!readOnly) {
        const pageSize = Number(db.prepare("PRAGMA main.page_size").get()!.page_size);
        db.exec(`PRAGMA main.max_page_count = ${Math.floor(OPENBOT_DATA_LIMITS.databaseBytes / pageSize)}`);
      }
      return db;
    } catch { throw new OpenBotDataError("unavailable", "The configured shared database is unavailable. No replacement was created."); }
  };
  const withDatabase = <T>(botId: string, readOnly: boolean, work: (db: DatabaseSync) => T): T => {
    if (typeof botId !== "string" || !botId.trim() || botId.length > 255) throw new OpenBotDataError("forbidden", "An authenticated bot identity is required.");
    const db = connect(readOnly);
    try { return work(db); }
    catch (error) {
      if (error instanceof OpenBotDataError) throw error;
      if ((error as { errcode?: number }).errcode === 7) throw new OpenBotDataError("limit_exceeded", "The SQLite memory budget was exhausted.");
      if ((error as { errcode?: number }).errcode === SQLITE_AUTH_ERROR || /authoriz|unsafe use/i.test(String((error as Error).message))) throw new OpenBotDataError("forbidden", "SQLite refused access to a protected table, schema operation, trigger or function.");
      throw new OpenBotDataError("query_failed", `SQLite rejected the statement: ${String((error as Error).message).slice(0, 400)}`);
    } finally { db.close(); }
  };
  const prepareExecute = (botId: string, input: DataSqlInput): PreparedDataWrite => {
    const parsed = parseSql(input, true);
    if (typeof botId !== "string" || !botId.trim() || botId.length > 255) throw new OpenBotDataError("forbidden", "An authenticated bot identity is required.");
    const db = connect(false);
    let pending = false;
    const rollback = () => {
      if (!db.isOpen) return;
      try { db.setAuthorizer(null); if (pending) db.exec("ROLLBACK"); }
      finally { pending = false; db.close(); }
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      pending = true;
        const catalog = readCatalog(db);
        const ddl = ["CREATE", "ALTER", "DROP"].includes(parsed.command) ? parseDdl(parsed, catalog, botId) : undefined;
        authorize(db, ddl ? "ddl" : "rows", catalog, ddl);
        const statement = db.prepare(parsed.sql);
        statement.setReadBigInts(true);
        const result = statement.run(...parsed.params);
        if (ddl) {
          const after = readCatalog(db);
          validateSchemaChange(catalog, after, ddl);
          authorize(db, "metadata", after);
          if (ddl.kind === "create_table" && !ddl.existing) db.prepare("INSERT INTO main.openbot_metadata (table_name, owner_agent_id, created_at) VALUES (?, ?, ?)").run(after.tables.get(lower(ddl.table))!.name, botId, new Date().toISOString());
          if (ddl.kind === "drop_table") db.prepare("DELETE FROM main.openbot_metadata WHERE table_name = ?").run(catalog.owners.get(lower(ddl.table))!.table_name);
          if (ddl.renamed) db.prepare("UPDATE main.openbot_metadata SET table_name = ? WHERE table_name = ?").run(after.tables.get(lower(ddl.renamed))!.name, catalog.owners.get(lower(ddl.table))!.table_name);
        }
        if (databaseSize(db) > OPENBOT_DATA_LIMITS.databaseBytes) throw new OpenBotDataError("limit_exceeded", "The shared database would exceed 256 MB. The write was rolled back.");
        const value = { changes: Number(result.changes), last_insert_rowid: scalar(result.lastInsertRowid) as number | string, ...(ddl ? { table: ddl.renamed ?? ddl.table } : {}) };
        return { result: value, rollback, commit() {
          if (!pending) throw new OpenBotDataError("query_failed", "This transaction is no longer open.");
          try { db.exec("COMMIT"); pending = false; db.close(); return value; }
          catch (error) { rollback(); throw error; }
        } };
    } catch (error) {
      rollback();
      if (error instanceof OpenBotDataError) throw error;
      if ((error as { errcode?: number }).errcode === 7) throw new OpenBotDataError("limit_exceeded", "The SQLite memory budget was exhausted.");
      if ((error as { errcode?: number }).errcode === SQLITE_AUTH_ERROR || /authoriz|unsafe use/i.test(String((error as Error).message))) throw new OpenBotDataError("forbidden", "SQLite refused access to a protected table, schema operation, trigger or function.");
      throw new OpenBotDataError("query_failed", "SQLite rejected the write.");
    }
  };
  const execute = (botId: string, input: DataSqlInput) => prepareExecute(botId, input).commit();
  const prepareDeleteTable = (botId: string, tableName: string) => {
    if (typeof tableName !== "string" || protectedTable(tableName)) throw new OpenBotDataError("forbidden", "Only an ordinary table created by this bot can be removed.");
    return prepareExecute(botId, { sql: `DROP TABLE ${quoteIdentifier(tableName)}` });
  };
  return {
    listTables(botId: string): { tables: SharedTable[] } {
      return withDatabase(botId, true, db => {
        const catalog = readCatalog(db);
        authorize(db, "query", catalog);
        return { tables: [...catalog.tables.values()].map(table => {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM main.${quoteIdentifier(table.name)}`).get()!;
          const owner = catalog.owners.get(lower(table.name));
          return { name: table.name, schema: table.sql, row_count: Number(row.n), owner_agent_id: owner?.owner_agent_id ?? null, created_at: owner?.created_at ?? null };
        }) };
      });
    },
    query(botId: string, input: DataQueryInput): QueryResult {
      const parsed = parseSql(input, false);
      const limit = input.limit ?? OPENBOT_DATA_LIMITS.rows;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPENBOT_DATA_LIMITS.rows) throw new OpenBotDataError("invalid_input", "The row limit must be between 1 and 500.");
      return withDatabase(botId, true, db => {
        const catalog = readCatalog(db);
        authorize(db, "query", catalog);
        const statement = db.prepare(parsed.sql);
        statement.setReadBigInts(true);
        const rows: Record<string, unknown>[] = [];
        let bytes = 0;
        let truncated = false;
        for (const raw of statement.iterate(...parsed.params as SQLInputValue[])) {
          const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, scalar(value)]));
          const rowBytes = Buffer.byteLength(JSON.stringify(row));
          if (rows.length === limit || bytes + rowBytes > OPENBOT_DATA_LIMITS.resultBytes) { truncated = true; break; }
          rows.push(row);
          bytes += rowBytes;
        }
        return { rows, columns: statement.columns().map(column => column.name), row_count: rows.length, truncated };
      });
    },
    execute,
    prepareExecute,
    prepareDeleteTable,
    deleteTable(botId: string, tableName: string): ExecuteResult {
      return prepareDeleteTable(botId, tableName).commit();
    },
  };
}

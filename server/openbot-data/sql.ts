export const OPENBOT_DATA_LIMITS = Object.freeze({ rows: 500, sqlBytes: 64_000, params: 1_000, paramBytes: 2_000_000, resultBytes: 2_000_000, databaseBytes: 256 * 1024 * 1024 });

export type DataErrorCode = "invalid_input" | "forbidden" | "unavailable" | "limit_exceeded" | "query_failed" | "timeout" | "cancelled" | "commit_uncertain";

export class OpenBotDataError extends Error {
  readonly code: DataErrorCode;
  constructor(code: DataErrorCode, message: string) {
    super(message);
    this.name = "OpenBotDataError";
    this.code = code;
  }
}

export type DataParam = string | number | boolean | null;
export interface DataSqlInput { sql: string; params?: DataParam[] }
export interface DataQueryInput extends DataSqlInput { limit?: number }
export interface SqlToken { kind: "word" | "identifier" | "literal" | "number" | "parameter" | "punctuation"; value: string }
export interface ParsedSql { sql: string; tokens: SqlToken[]; params: Array<string | number | null>; command: string }

const SECRET_TABLE = /(?:^|_)(?:secrets?|credentials?|passwords?|auth_tokens?|access_tokens?|refresh_tokens?|api_keys?|private_keys?)(?:_|$)/i;

export function protectedTable(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "openbot_metadata" || lower.startsWith("sqlite_") || lower.startsWith("pragma_") || SECRET_TABLE.test(lower);
}

export function quoteIdentifier(name: string): string {
  if (!name || name.length > 255 || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new OpenBotDataError("invalid_input", "Use a valid table or index name of at most 255 characters.");
  return `"${name.replaceAll('"', '""')}"`;
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let offset = 0;
  let ended = false;
  const push = (kind: SqlToken["kind"], value: string) => {
    if (ended) throw new OpenBotDataError("invalid_input", "Only one SQL statement is allowed per call.");
    tokens.push({ kind, value });
  };
  while (offset < sql.length) {
    const char = sql[offset]!;
    if (/\s/.test(char)) { offset++; continue; }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) throw new OpenBotDataError("invalid_input", "The SQL contains an unfinished comment.");
      offset = end + 2;
      continue;
    }
    if (char === ";") {
      if (ended) throw new OpenBotDataError("invalid_input", "Only one SQL statement is allowed per call.");
      ended = true;
      offset++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      offset++;
      while (offset < sql.length) {
        if (sql[offset] === closing) {
          if (closing !== "]" && sql[offset + 1] === closing) { value += closing; offset += 2; continue; }
          offset++;
          closed = true;
          break;
        }
        value += sql[offset++];
      }
      if (!closed) throw new OpenBotDataError("invalid_input", "The SQL contains an unfinished quoted value or name.");
      push(char === "'" ? "literal" : "identifier", value);
      continue;
    }
    if (char === "?") {
      if (/\d/.test(sql[offset + 1] ?? "")) throw new OpenBotDataError("invalid_input", "Use plain ? placeholders and an ordered params array.");
      push("parameter", char);
      offset++;
      continue;
    }
    if (char === ":" || char === "@" || char === "$") throw new OpenBotDataError("invalid_input", "Use plain ? placeholders and an ordered params array.");
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(offset));
    if (word) { push("word", word[0]); offset += word[0].length; continue; }
    const number = /^(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(offset));
    if (number) { push("number", number[0]); offset += number[0].length; continue; }
    if ("(),.*+-/%<>=!|&~".includes(char)) { push("punctuation", char); offset++; continue; }
    throw new OpenBotDataError("invalid_input", "The SQL contains an unsupported character.");
  }
  return tokens;
}

export function tokenWord(token: SqlToken | undefined, word: string): boolean { return token?.kind === "word" && token.value.toUpperCase() === word; }

function rootCommand(tokens: SqlToken[]): string {
  if (tokens[0]?.kind !== "word") throw new OpenBotDataError("invalid_input", "Start with a supported SQL statement.");
  const first = tokens[0].value.toUpperCase();
  if (first !== "WITH") return first;
  let depth = 0;
  for (const token of tokens.slice(1)) {
    if (token.value === "(") depth++;
    else if (token.value === ")") depth--;
    else if (depth === 0 && token.kind === "word" && ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"].includes(token.value.toUpperCase())) return token.value.toUpperCase();
  }
  throw new OpenBotDataError("invalid_input", "The WITH statement needs a supported final operation.");
}

export function parseSql(input: DataSqlInput, writing: boolean): ParsedSql {
  if (typeof input.sql !== "string" || !input.sql.trim() || Buffer.byteLength(input.sql) > OPENBOT_DATA_LIMITS.sqlBytes || input.sql.includes("\0")) throw new OpenBotDataError("invalid_input", "Give one SQL statement of at most 64,000 bytes.");
  const tokens = tokenize(input.sql);
  const command = rootCommand(tokens);
  const params = input.params ?? [];
  if (!Array.isArray(params) || params.length > OPENBOT_DATA_LIMITS.params || params.some(value => value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) throw new OpenBotDataError("invalid_input", "params must be an array of up to 1,000 text, number, boolean or null values.");
  if (params.some(value => typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) throw new OpenBotDataError("invalid_input", "Number parameters must be finite and integer parameters must be safe JavaScript integers. Pass larger integers as text.");
  if (Buffer.byteLength(JSON.stringify(params)) > OPENBOT_DATA_LIMITS.paramBytes) throw new OpenBotDataError("limit_exceeded", "The parameters exceed the 2 MB limit.");
  if (tokens.filter(token => token.kind === "parameter").length !== params.length) throw new OpenBotDataError("invalid_input", "Every ? placeholder needs exactly one value in params.");
  const ddl = ["CREATE", "ALTER", "DROP"].includes(command);
  if (tokens.some(token => (token.kind === "word" || token.kind === "identifier" || (ddl && token.kind === "literal")) && (token.value.toLowerCase() === "openbot_metadata" || token.value.toLowerCase().startsWith("sqlite_") || token.value.toLowerCase().startsWith("pragma_")))) throw new OpenBotDataError("forbidden", "System metadata is unavailable. Use list_tables to inspect shared tables.");
  if (writing && !ddl && tokens.some(token => token.kind === "literal" || token.kind === "number" || tokenWord(token, "TRUE") || tokenWord(token, "FALSE") || tokenWord(token, "NULL"))) throw new OpenBotDataError("invalid_input", "Pass every row value in params using ? placeholders.");
  if (!writing && command !== "SELECT") throw new OpenBotDataError("forbidden", "query_data only accepts a read-only SELECT or WITH ... SELECT.");
  if (writing && !ddl && !["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(command)) throw new OpenBotDataError("forbidden", "execute_data accepts row writes and owned-table DDL only.");
  return { sql: input.sql, tokens, params: params.map(value => typeof value === "boolean" ? Number(value) : value), command };
}

export function readName(tokens: SqlToken[], offset: number): { name: string; next: number } {
  let token = tokens[offset];
  if (!token || (token.kind !== "word" && token.kind !== "identifier")) throw new OpenBotDataError("invalid_input", "Give a table or index name.");
  if (tokens[offset + 1]?.value === ".") {
    if (token.value.toLowerCase() !== "main") throw new OpenBotDataError("forbidden", "Only the configured shared database is available.");
    token = tokens[offset + 2];
    if (!token || (token.kind !== "word" && token.kind !== "identifier")) throw new OpenBotDataError("invalid_input", "Give a table or index name.");
    offset += 2;
  }
  quoteIdentifier(token.value);
  if (protectedTable(token.value)) throw new OpenBotDataError("forbidden", "System and credential tables are unavailable.");
  return { name: token.value, next: offset + 1 };
}

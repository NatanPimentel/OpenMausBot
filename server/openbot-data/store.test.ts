import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenBotDataEngine as createOpenBotDataStore, OpenBotDataError } from "./engine.ts";

let directory: string;
let path: string;
let store: ReturnType<typeof createOpenBotDataStore>;
const alice = "agent-fixture-alice";
const bob = "agent-fixture-bob";
const raw = (work: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(path);
  try { work(database); } finally { database.close(); }
};
const create = (name = "people", by = alice) => store.execute(by, { sql: `CREATE TABLE "${name}" (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT)` });
const insert = (name = "people", by = alice, id = 1) => store.execute(by, { sql: `INSERT INTO "${name}" (id, email, name) VALUES (?, ?, ?)`, params: [id, `person-${id}@example.test`, "Fixture person"] });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-openbot-data-fixture-"));
  path = join(directory, "shared.db");
  raw(database => database.exec("CREATE TABLE openbot_metadata (table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL)"));
  store = createOpenBotDataStore(path);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("canonical OpenBot shared data", () => {
  it("shares reads and row writes, persists ownership and lists schema, owner and row count", () => {
    create();
    insert("people", bob);
    store.execute(bob, { sql: "INSERT INTO people (id, email, name) VALUES (?, ?, ?), (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name", params: [2, "second@example.test", "Second", 3, "third@example.test", "Third"] });
    store.execute(bob, { sql: "UPDATE people SET name = ? WHERE id = ?", params: ["Updated by another bot", 1] });
    expect(store.query(alice, { sql: "SELECT id, name FROM people WHERE id = ? LIMIT 10", params: [1] })).toMatchObject({ rows: [{ id: 1, name: "Updated by another bot" }], columns: ["id", "name"], row_count: 1, truncated: false });
    const recreated = createOpenBotDataStore(path);
    expect(recreated.listTables(bob).tables).toEqual([{ name: "people", schema: expect.stringContaining("CREATE TABLE"), row_count: 3, owner_agent_id: alice, created_at: expect.stringMatching(/^\d{4}-/) }]);
    store.execute(bob, { sql: "DELETE FROM people WHERE id = ?", params: [3] });
    expect(store.listTables(alice).tables[0]!.row_count).toBe(2);
  });

  it("lets only the owner alter, index, rename and remove a table", () => {
    create();
    insert();
    for (const sql of ["ALTER TABLE people ADD COLUMN city TEXT", 'ALTER TABLE main."PEOPLE" RENAME TO mine', "DROP TABLE people", "CREATE INDEX people_name ON people (name)", "CREATE TABLE IF NOT EXISTS people (stolen TEXT)"]) expect(() => store.execute(bob, { sql }), sql).toThrow(OpenBotDataError);
    expect(() => store.deleteTable(bob, "PEOPLE")).toThrow(/creator/);
    store.execute(alice, { sql: "ALTER TABLE people ADD COLUMN city TEXT" });
    store.execute(alice, { sql: "CREATE INDEX people_name ON people (name)" });
    expect(() => store.execute(bob, { sql: "DROP INDEX people_name" })).toThrow(/creator/);
    store.execute(alice, { sql: "DROP INDEX people_name" });
    store.execute(alice, { sql: "ALTER TABLE people RENAME COLUMN city TO town" });
    store.execute(alice, { sql: "ALTER TABLE people DROP COLUMN town" });
    store.execute(alice, { sql: "ALTER TABLE people RENAME TO contacts" });
    expect(store.listTables(bob).tables[0]).toMatchObject({ name: "contacts", owner_agent_id: alice, row_count: 1 });
    expect(() => store.deleteTable(bob, "contacts")).toThrow(/creator/);
    store.deleteTable(alice, "contacts");
    expect(store.listTables(bob).tables).toEqual([]);
    raw(database => expect(database.prepare("SELECT * FROM openbot_metadata").all()).toEqual([]));
  });

  it("does not adopt unowned or inconsistent existing tables", () => {
    raw(database => database.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY)"));
    expect(store.listTables(alice).tables[0]).toMatchObject({ name: "legacy", owner_agent_id: null });
    store.execute(bob, { sql: "INSERT INTO legacy (id) VALUES (?)", params: [1] });
    expect(() => store.execute(alice, { sql: "ALTER TABLE legacy ADD COLUMN value TEXT" })).toThrow(/no recorded owner/);
    expect(() => store.execute(alice, { sql: "CREATE TABLE IF NOT EXISTS legacy (id INTEGER)" })).toThrow(/no recorded owner/);
    raw(database => database.exec("INSERT INTO openbot_metadata VALUES ('legacy', 'agent-fixture-alice', 'fixture'), ('LEGACY', 'agent-fixture-bob', 'fixture')"));
    expect(() => store.listTables(alice)).toThrow(/inconsistent/);
  });

  it("caps read results at 500 even with an absent or larger SQL LIMIT", () => {
    raw(database => database.exec("CREATE TABLE counts (id INTEGER PRIMARY KEY); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 550) INSERT INTO counts SELECT x FROM n"));
    for (const sql of ["SELECT * FROM counts", "SELECT * FROM counts LIMIT 10000"]) expect(store.query(alice, { sql })).toMatchObject({ row_count: 500, truncated: true });
    expect(store.query(alice, { sql: "SELECT * FROM counts", limit: 7 })).toMatchObject({ row_count: 7, truncated: true });
    expect(() => store.query(alice, { sql: "SELECT * FROM counts", limit: 501 })).toThrow(/between 1 and 500/);
    expect(store.query(alice, { sql: "SELECT 9223372036854775807 AS large, x'0102' AS blob" }).rows).toEqual([{ large: "9223372036854775807", blob: { base64: "AQI=" } }]);
    expect(store.query(alice, { sql: "SELECT ? AS large", params: ["x".repeat(2_000_000 - 10)] })).toMatchObject({ row_count: 0, truncated: true });
  });

  it("supports AUTOINCREMENT without exposing or assigning ownership to sqlite_sequence", () => {
    store.execute(alice, { sql: "CREATE TABLE sequence_people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)" });
    store.execute(bob, { sql: "INSERT INTO sequence_people (name) VALUES (?)", params: ["Fixture"] });
    expect(store.query(alice, { sql: "SELECT id FROM sequence_people" }).rows).toEqual([{ id: 1 }]);
    expect(store.listTables(bob).tables.map(table => table.name)).toEqual(["sequence_people"]);
    expect(() => store.query(bob, { sql: "SELECT * FROM sqlite_sequence" })).toThrow(/metadata/);
  });

  it("supports read and write CTEs while preserving protected-table authorizations", () => {
    create();
    store.execute(bob, { sql: "WITH p(id, email, name) AS (VALUES (?, ?, ?)) INSERT INTO people SELECT * FROM p", params: [1, "cte@example.test", "CTE fixture"] });
    expect(store.query(alice, { sql: "WITH p AS (SELECT * FROM people WHERE id = ?) SELECT name FROM p", params: [1] }).rows).toEqual([{ name: "CTE fixture" }]);
    expect(store.query(alice, { sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 3) SELECT n FROM numbers" }).rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    raw(database => database.exec("CREATE TABLE access_tokens (value TEXT); INSERT INTO access_tokens VALUES ('synthetic-only')"));
    expect(() => store.query(alice, { sql: "WITH p AS (SELECT * FROM access_tokens) SELECT * FROM p" })).toThrow(/SQLite refused/);
  });

  it("uses SQLite's ASCII identifier folding without conflating Unicode table owners", () => {
    create("Å", alice);
    create("å", bob);
    expect(store.listTables(alice).tables).toEqual([
      expect.objectContaining({ name: "Å", owner_agent_id: alice }),
      expect.objectContaining({ name: "å", owner_agent_id: bob }),
    ]);
    expect(() => store.deleteTable(alice, "å")).toThrow(/creator/);
    expect(() => store.deleteTable(bob, "Å")).toThrow(/creator/);
    store.deleteTable(alice, "Å");
    expect(store.listTables(bob).tables).toEqual([expect.objectContaining({ name: "å", owner_agent_id: bob })]);
  });

  it("parses comments and quoted semicolons but refuses every extra statement", () => {
    create();
    expect(store.query(alice, { sql: "/* fixture */ SELECT 'safe; -- data' AS value; -- final comment" }).rows).toEqual([{ value: "safe; -- data" }]);
    store.execute(alice, { sql: "-- fixture\nINSERT INTO people (id, name) VALUES (?, ?); /* done */", params: [1, "O'Reilly; DROP TABLE people"] });
    for (const sql of ["SELECT * FROM people; DELETE FROM people", "SELECT 1; /*hidden*/ SELECT 2", "SELECT 1;;", "SELECT 1\0; DROP TABLE people", "SELECT 1 /* incomplete"]) expect(() => store.query(alice, { sql }), sql).toThrow(OpenBotDataError);
    expect(() => store.execute(alice, { sql: "INSERT INTO people (id) VALUES (?); DROP TABLE people", params: [2] })).toThrow(/one SQL/);
    expect(store.listTables(bob).tables[0]!.row_count).toBe(1);
  });

  it("requires parameterized row values and exact positional bindings", () => {
    create();
    for (const input of [{ sql: "INSERT INTO people (id, name) VALUES (1, 'literal')" }, { sql: "INSERT INTO people (id) VALUES (?)" }, { sql: "INSERT INTO people (id) VALUES (?1)", params: [1] }, { sql: "INSERT INTO people (name) VALUES (:name)", params: ["fixture"] }, { sql: "INSERT INTO people (id) VALUES (?)", params: [1, 2] }, { sql: "INSERT INTO people (id) VALUES (?)", params: [Number.NaN] }, { sql: "INSERT INTO people (id) VALUES (?)", params: [Number.MAX_SAFE_INTEGER + 1] }]) expect(() => store.execute(alice, input), JSON.stringify(input)).toThrow(OpenBotDataError);
    expect(() => store.query(alice, { sql: "SELECT ?" })).toThrow(/exactly one/);
    store.execute(alice, { sql: "INSERT INTO people (id, name) VALUES (?, ?)", params: [true, null] });
    expect(store.query(bob, { sql: "SELECT id, name FROM people" }).rows).toEqual([{ id: 1, name: null }]);
  });
});

describe("shared data security boundaries", () => {
  beforeEach(() => { create(); insert(); });

  it("denies metadata, schema tables, credential tables, file access and extensions", () => {
    raw(database => database.exec("CREATE TABLE auth_tokens (id INTEGER PRIMARY KEY, token TEXT); INSERT INTO auth_tokens VALUES (1, 'synthetic-not-a-secret')"));
    for (const sql of ["SELECT * FROM openbot_metadata", 'SELECT * FROM main."OPENBOT_METADATA"', "SELECT * FROM sqlite_master", "SELECT * FROM sqlite_schema", "SELECT * FROM pragma_table_info(?)", "SELECT * FROM auth_tokens", "SELECT load_extension(?)", "SELECT readfile(?)", "SELECT writefile(?, ?)", "SELECT eval(?)", "SELECT getenv(?)"]) {
      const count = (sql.match(/\?/g) ?? []).length;
      expect(() => store.query(alice, { sql, params: Array(count).fill("synthetic-value") }), sql).toThrow(OpenBotDataError);
    }
    expect(store.listTables(alice).tables.map(table => table.name)).toEqual(["people"]);
    for (const sql of ["DELETE FROM openbot_metadata", "UPDATE openbot_metadata SET owner_agent_id = ?", "DROP TABLE openbot_metadata", "CREATE TABLE secrets (id INTEGER)"]) expect(() => store.execute(alice, { sql, params: sql.includes("?") ? [bob] : [] }), sql).toThrow(OpenBotDataError);
    expect(store.listTables(bob).tables[0]!.owner_agent_id).toBe(alice);
  });

  it("rejects transactions, attached databases, PRAGMAs and non-table DDL", () => {
    for (const sql of ["ATTACH DATABASE ? AS stolen", "DETACH DATABASE main", "PRAGMA writable_schema = ON", "VACUUM", "VACUUM INTO ?", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT bypass", "CREATE TEMP TABLE temp_table (id INTEGER)", "CREATE VIRTUAL TABLE virtual_table USING fts5(value)", "CREATE VIEW view_data AS SELECT * FROM people", "CREATE TRIGGER a AFTER INSERT ON people BEGIN DELETE FROM people; END"]) {
      expect(() => store.execute(bob, { sql, params: sql.includes("?") ? [join(directory, "forbidden.db")] : [] }), sql).toThrow(OpenBotDataError);
    }
    for (const sql of ["DELETE FROM people", "WITH p AS (SELECT * FROM people) DELETE FROM people"]) expect(() => store.query(bob, { sql }), sql).toThrow(OpenBotDataError);
    expect(store.listTables(alice).tables[0]!.row_count).toBe(1);
  });

  it("cannot use SQLite's single-quoted table names to copy hidden schema through CREATE AS SELECT", () => {
    for (const source of ["'sqlite_schema'", "main.'sqlite_master'", "'SQLite_Schema'"]) expect(() => store.execute(bob, { sql: `CREATE TABLE stolen_schema AS SELECT * FROM ${source}` }), source).toThrow(OpenBotDataError);
    expect(store.listTables(alice).tables.map(table => table.name)).toEqual(["people"]);
  });

  it("rejects metadata writes reached through existing triggers and views", () => {
    raw(database => database.exec("CREATE TRIGGER steal_owner AFTER INSERT ON people BEGIN UPDATE openbot_metadata SET owner_agent_id = 'agent-fixture-bob'; END; CREATE VIEW disguised AS SELECT * FROM openbot_metadata"));
    expect(() => insert("people", bob, 2)).toThrow(/SQLite refused/);
    expect(() => store.query(bob, { sql: "SELECT * FROM disguised" })).toThrow(/SQLite refused/);
    expect(store.listTables(alice).tables[0]).toMatchObject({ row_count: 1, owner_agent_id: alice });
  });

  it("rolls back a table creation if an existing metadata trigger tries another side effect", () => {
    raw(database => database.exec("CREATE TRIGGER tainted_metadata AFTER INSERT ON openbot_metadata BEGIN DELETE FROM people; END"));
    expect(() => create("rollback_me", bob)).toThrow(/SQLite refused/);
    expect(store.listTables(alice).tables).toEqual([expect.objectContaining({ name: "people", row_count: 1, owner_agent_id: alice })]);
    raw(database => expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'rollback_me'").all()).toEqual([]));
  });

  it("cannot use foreign keys or a rename to change another table's metadata or schema", () => {
    create("elsewhere", bob);
    expect(() => store.execute(alice, { sql: "ALTER TABLE people RENAME TO elsewhere" })).toThrow(/already exists/);
    store.execute(bob, { sql: "CREATE TABLE foreign_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES people(id))" });
    expect(() => store.execute(alice, { sql: "ALTER TABLE people RENAME TO renamed_parent" })).toThrow(/another table/);
    expect(store.listTables(alice).tables.map(table => table.name)).toEqual(["elsewhere", "foreign_child", "people"]);
    expect(() => store.execute(alice, { sql: "CREATE TABLE sneaky (id INTEGER REFERENCES openbot_metadata(table_name) ON DELETE CASCADE)" })).toThrow(/metadata/);
    raw(database => {
      database.exec("CREATE TABLE indirect (id INTEGER PRIMARY KEY REFERENCES openbot_metadata(table_name) ON UPDATE CASCADE)");
      database.prepare("INSERT INTO openbot_metadata VALUES (?, ?, ?)").run("indirect", bob, "fixture");
    });
    expect(() => store.execute(bob, { sql: "INSERT INTO indirect (id) VALUES (?)", params: [1] })).toThrow(/SQLite refused/);
    expect(store.listTables(alice).tables.find(table => table.name === "people")!.owner_agent_id).toBe(alice);
  });

  it("does not create a missing database or accept a missing authenticated identity", () => {
    expect(() => createOpenBotDataStore(join(directory, "missing.db")).listTables(alice)).toThrow(/No replacement/);
    expect(() => createOpenBotDataStore("relative.db").listTables(alice)).toThrow(/configured by the host/);
    expect(() => store.deleteTable("", "people")).toThrow(/authenticated/);
    raw(database => database.exec("DROP TABLE openbot_metadata"));
    expect(() => store.listTables(alice)).toThrow(/No tables were adopted/);
  });
});

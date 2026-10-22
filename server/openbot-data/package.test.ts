import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { dataProcessEnvironment } from "./protocol.ts";

it("runs the bundled helper without TypeScript or node_modules beside the packaged client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-data-packaged-fixture-"));
  try {
    const path = join(directory, "synthetic.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE openbot_metadata(table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.close();
    const packaged = join(directory, "packaged");
    mkdirSync(packaged);
    writeFileSync(join(packaged, "package.json"), '{"type":"module"}');
    const client = join(packaged, "client.mjs");
    const child = join(packaged, "openbot-data", "child.js");
    await build({ stdin: { contents: `export { createOpenBotDataStore } from ${JSON.stringify(fileURLToPath(new URL("./store.ts", import.meta.url)))};`, loader: "ts", resolveDir: fileURLToPath(new URL("./", import.meta.url)) }, outfile: client, bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
    await build({ entryPoints: [fileURLToPath(new URL("./child.ts", import.meta.url))], outfile: child, bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
    const module = await import(pathToFileURL(client).href) as typeof import("./store.ts");
    const store = module.createOpenBotDataStore(path);
    const authority = { assertActive() {} };
    await store.execute("fixture-packaged-owner", { sql: "CREATE TABLE packaged_records (id INTEGER PRIMARY KEY, value TEXT)" }, authority);
    await store.execute("fixture-packaged-owner", { sql: "INSERT INTO packaged_records VALUES (?, ?)", params: [1, "fixture value"] }, authority);
    expect((await store.query("fixture-packaged-peer", { sql: "SELECT value FROM packaged_records" }, authority)).rows).toEqual([{ value: "fixture value" }]);
    expect((await store.listTables("fixture-packaged-owner", authority)).tables[0]!.owner_agent_id).toBe("fixture-packaged-owner");
    expect(readFileSync(new URL("../../scripts/bundle-server.mjs", import.meta.url), "utf8")).toContain('"openbot-data/child.ts"');
    expect(dataProcessEnvironment()).toHaveProperty("ELECTRON_RUN_AS_NODE", "1");
    expect(dataProcessEnvironment()).not.toHaveProperty("NODE_OPTIONS");
    expect(dataProcessEnvironment()).not.toHaveProperty("HOME");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

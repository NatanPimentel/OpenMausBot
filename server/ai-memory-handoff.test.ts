import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { accountHandoffSummary, roundtripAccountHandoff } from "./ai-memory-handoff.ts";

const directories: string[] = [];
const input = {
  schemaVersion: 1 as const, source: "openmausbot" as const, conversationId: "bot:thread",
  boundaryId: "request:backup", cwd: tmpdir(), summary: "Completed: sent receipt A. Pending: corrected port 9001.",
};
function bridge(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-memory-handoff-"));
  directories.push(directory);
  const path = join(directory, "bridge.py");
  writeFileSync(path, `import json, sys\nrequest = json.load(sys.stdin)\nresponse = dict(request, workspace="default", project="bot", handoffId="checkpoint-1", text=request["summary"])\n${body}\n`);
  return path;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("roundtrips exact conversation identity and a bounded historical summary", async () => {
  expect(await roundtripAccountHandoff(input, { command: bridge("json.dump(response, sys.stdout)") })).toEqual({
    schemaVersion: 1, source: "openmausbot", conversationId: "bot:thread", boundaryId: "request:backup",
    workspace: "default", project: "bot", handoffId: "checkpoint-1", text: input.summary,
  });
});

it.each([
  'response["source"] = "orca"',
  'response["conversationId"] = "bot:sibling"',
  'response["boundaryId"] = "older-request:backup"',
  'response["schemaVersion"] = 2',
  'response["handoffId"] = ""',
  'response["workspace"] = ""',
  'response["project"] = ""',
  'response["text"] = "   "',
  'response["text"] = "é" * 4001',
])("rejects an unusable or mismatched checkpoint: %s", async change => {
  expect(await roundtripAccountHandoff(input, { command: bridge(`${change}\njson.dump(response, sys.stdout)`) })).toBeNull();
});

it("keeps the caller's original context when the service fails or produces oversized output", async () => {
  for (const body of ['sys.exit(1)', 'print("x" * 32769)', 'print("not JSON")']) {
    expect(await roundtripAccountHandoff(input, { command: bridge(body) })).toBeNull();
  }
  expect(await roundtripAccountHandoff(input, { command: "" })).toBeNull();
  expect(await roundtripAccountHandoff(input, { command: "relative.py" })).toBeNull();
});

it("cancels a pending bridge without accepting a late response", async () => {
  const command = bridge('import time\ntime.sleep(30)\njson.dump(response, sys.stdout)');
  expect(await roundtripAccountHandoff(input, { command, signal: AbortSignal.timeout(50) })).toBeNull();
});

it("preserves the complete predecessor checkpoint without quoting or shortening it again", () => {
  const predecessor = 'Completed work:\nreceipt-A already sent.\nKeep "port 9001".';
  const summary = accountHandoffSummary([
    { id: "prior", role: "assistant", text: "Old context wrapper" },
    { id: "new", role: "user", text: "NEW_CORRECTION use port 9002" },
  ], [], { id: "prior", summary: predecessor });
  expect(summary).toContain(predecessor);
  expect(summary).toContain("NEW_CORRECTION");
  expect(summary).not.toContain("Old context wrapper");
  expect(Buffer.byteLength(summary!)).toBeLessThanOrEqual(6_000);
});

it("declines a new fold when its full predecessor leaves insufficient checkpoint space", () => {
  expect(accountHandoffSummary([{ id: "new", role: "user", text: "new correction" }], [], {
    id: "prior", summary: "p".repeat(5_900),
  })).toBeNull();
});

it("preserves the complete folded user request including a constraint in its middle", () => {
  const request = `Beginning ${"a".repeat(1_550)} MIDDLE_CONSTRAINT never send receipt A twice ${"z".repeat(1_550)} End`;
  const summary = accountHandoffSummary([
    { id: "long-request", role: "user", text: request },
    { id: "reply", role: "assistant", text: "Reported progress; verify it before repeating work." },
  ], []);
  expect(summary).toContain(request);
  expect(summary).toContain("MIDDLE_CONSTRAINT");
  expect(Buffer.byteLength(summary!)).toBeLessThanOrEqual(6_000);
});

it("declines folding when complete user instructions exceed the checkpoint budget", () => {
  expect(accountHandoffSummary([
    { id: "too-long", role: "user", text: "u".repeat(6_001) },
  ], [])).toBeNull();
});

it("reserves room for the complete predecessor and every new folded user instruction", () => {
  expect(accountHandoffSummary([
    { id: "prior", role: "assistant", text: "Earlier context wrapper" },
    { id: "new-request", role: "user", text: "u".repeat(3_000) },
  ], [], { id: "prior", summary: "p".repeat(3_500) })).toBeNull();
});

it.each(["image", "file"])("declines folding a message with required %s evidence", kind => {
  expect(accountHandoffSummary([{ id: "old", role: "user", text: "See evidence" }], [{
    text: `See evidence\n<attached-${kind} path="/private/evidence"/>`,
  }])).toBeNull();
});

it("declines folding attachment-only evidence and resolved question-card answers", () => {
  const folded = [{ id: "old", role: "user" as const, text: "Remember the decision" }];
  expect(accountHandoffSummary(folded, [{ attachments: [{ kind: "image", path: "/private/evidence.png", mime: "image/png" }] }])).toBeNull();
  expect(accountHandoffSummary(folded, [{ card: {
    title: "Which port?", options: [], requestType: "question", answered: "answer", answeredText: "Use port 9001",
  } }])).toBeNull();
});

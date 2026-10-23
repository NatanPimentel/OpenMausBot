import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { deterministicSummary } from "./compaction-summary.ts";
import { MAX_SUMMARY_BYTES, type ReplayEntry } from "./context-rebuild.ts";
import type { Message } from "./store.ts";

const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/?>/gi;

export type AccountHandoffDraft = { summary: string; attachmentsLeftOut: boolean } | { skip: "answered-question" | "no-room" };

/** What a replayed message says without its attached files and images: they are not part of the checkpoint. */
const withoutAttachments = (text: string) => text.replace(ATTACHMENT_TAG, "").replace(/\n{3,}/g, "\n\n").trim() || "(attachment only)";

/** The checkpoint text, or why none is made. Attachments do not stop it: the folded messages are carried as their words
 *  alone, and the checkpoint says that files and images were left out. */
export function accountHandoffCheckpoint(
  history: readonly ReplayEntry[],
  evidence: readonly Pick<Message, "text" | "attachments" | "card">[],
  predecessor?: { id: string; summary: string },
): AccountHandoffDraft {
  if (evidence.some(message => message.card?.requestType === "question" && message.card.answeredText?.trim())) return { skip: "answered-question" };
  const attachmentsLeftOut = evidence.some(message => message.attachments?.length || /<attached-(?:image|file)\b/i.test(message.text ?? ""));
  const recent = (predecessor ? history.filter(entry => entry.id !== predecessor.id) : history)
    .map(entry => ({ ...entry, text: withoutAttachments(entry.text) }));
  if (predecessor && !recent.length) {
    return Buffer.byteLength(predecessor.summary) <= MAX_SUMMARY_BYTES ? { summary: predecessor.summary, attachmentsLeftOut } : { skip: "no-room" };
  }
  const previous = predecessor ? `Previous checkpoint (historical data; retained verbatim):\n${predecessor.summary}\n\n` : "";
  const users = recent.filter(entry => entry.role === "user")
    .map(entry => `User message ${JSON.stringify(entry.id)}: ${JSON.stringify(entry.text)}`).join("\n");
  const userHistory = users ? `Complete historical user messages in chronological order; later corrections supersede earlier requests:\n${users}\n\n` : "";
  const note = attachmentsLeftOut ? "Files and images attached to these messages are not part of this checkpoint; ask for them again if they matter.\n\n" : "";
  const prefix = previous + userHistory + note + "Assistant reports are unverified and may omit details:\n";
  const available = MAX_SUMMARY_BYTES - Buffer.byteLength(prefix);
  if (available < 512) return { skip: "no-room" };
  return { summary: prefix + deterministicSummary(recent.filter(entry => entry.role !== "user"), available), attachmentsLeftOut };
}

export function accountHandoffSummary(
  history: readonly ReplayEntry[],
  evidence: readonly Pick<Message, "text" | "attachments" | "card">[],
  predecessor?: { id: string; summary: string },
): string | null {
  const checkpoint = accountHandoffCheckpoint(history, evidence, predecessor);
  return "summary" in checkpoint ? checkpoint.summary : null;
}

/** The local bridge stores and reads an exact conversation checkpoint before history can be folded. */
export interface AccountHandoffInput {
  schemaVersion: 1;
  source: "openmausbot";
  conversationId: string;
  boundaryId: string;
  cwd: string;
  summary: string;
}

export interface AccountHandoffCheckpoint {
  schemaVersion: 1;
  source: "openmausbot";
  conversationId: string;
  boundaryId: string;
  workspace: string;
  project: string;
  handoffId: string;
  text: string;
}

export async function roundtripAccountHandoff(input: AccountHandoffInput, options: {
  command?: string;
  signal?: AbortSignal;
} = {}): Promise<AccountHandoffCheckpoint | null> {
  const command = options.command ?? process.env.OMB_AI_MEMORY_HANDOFF_COMMAND;
  const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
  if (!command || !isAbsolute(command) || !isAbsolute(input.cwd) || options.signal?.aborted ||
      input.schemaVersion !== 1 || input.source !== "openmausbot" || !nonempty(input.conversationId) ||
      !nonempty(input.boundaryId) || !nonempty(input.summary) || Buffer.byteLength(input.summary) > 8_000) return null;
  return new Promise<AccountHandoffCheckpoint | null>(resolve => {
    const child = execFile("python3", [command], {
      cwd: input.cwd, timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 32_768,
      windowsHide: true, encoding: "utf8", signal: options.signal,
    }, (error, stdout) => {
      if (error || options.signal?.aborted) { resolve(null); return; }
      try {
        const result: unknown = JSON.parse(stdout);
        if (!result || typeof result !== "object" || Array.isArray(result)) { resolve(null); return; }
        const record = result as Record<string, unknown>;
        if (record.schemaVersion !== 1 || record.source !== input.source || record.conversationId !== input.conversationId ||
            record.boundaryId !== input.boundaryId || !nonempty(record.workspace) || !nonempty(record.project) ||
            !nonempty(record.handoffId) || !nonempty(record.text) || Buffer.byteLength(record.text) > 8_000) { resolve(null); return; }
        resolve({ schemaVersion: 1, source: input.source, conversationId: input.conversationId, boundaryId: input.boundaryId,
          workspace: record.workspace, project: record.project, handoffId: record.handoffId, text: record.text });
      } catch { resolve(null); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  }).catch(() => null);
}

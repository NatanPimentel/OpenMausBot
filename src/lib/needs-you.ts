import { useEffect, useSyncExternalStore } from "react";
import type { NeedsYouDismissRequest, NeedsYouDismissResult, NeedsYouPage, NeedsYouSubject } from "../../shared/needs-you";
import { api } from "@/state/api";

const POLL_MS = 10_000;
/** How long "Undo" stays offered before an "Already answered" reaches the server. */
export const DISMISS_UNDO_MS = 5_000;
/** The page's illustrative icon: an Apple emoji, drawn by the system's emoji font. */
export const NEEDS_YOU_EMOJI = "🙋";
export const EMOJI_FONT = { fontFamily: '"Apple Color Emoji", "Noto Color Emoji", sans-serif' } as const;

interface Snapshot {
  page: NeedsYouPage | null;
  failed: boolean;
}

let fetched: Snapshot = { page: null, failed: false };
let snapshot: Snapshot = fetched;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
/** Rows marked "already answered" whose undo window is still open: hidden at once, sent when it closes. */
const pending = new Map<string, { subject: NeedsYouSubject; timer: ReturnType<typeof setTimeout>; done: (result: DismissOutcome) => void }>();

const publish = (next: Snapshot) => {
  fetched = next;
  const page = next.page && pending.size ? (() => {
    const subjects = next.page.subjects.filter((subject) => !pending.has(subject.id));
    return { ...next.page, subjects, count: subjects.length };
  })() : next.page;
  snapshot = { ...next, page };
  for (const listener of listeners) listener();
};

export function localMidnight(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function refreshNeedsYou(background = false): Promise<void> {
  inFlight ??= api<NeedsYouPage>(`/api/needs-you?since=${localMidnight()}`, { background })
    .then((page) => publish({ page, failed: false }))
    .catch(() => publish({ ...fetched, failed: true }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** What every reader sees now, with rows waiting out their undo already gone. */
export const needsYouSnapshot = (): Snapshot => snapshot;

/** One poll for every reader: the sidebar row, the page and the app icon show the same number. */
export function useNeedsYou(connected: boolean): Snapshot {
  const current = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => snapshot);
  useEffect(() => {
    if (!connected) return;
    void refreshNeedsYou(true);
    const timer = window.setInterval(() => void refreshNeedsYou(true), POLL_MS);
    const onFocus = () => void refreshNeedsYou(true);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [connected]);
  return current;
}

export type QuestionSubject = Extract<NeedsYouSubject, { kind: "question" }>;

/** Answers every card that asked the subject, the way each card's own buttons do, then any pedir-natan request without one. */
export async function answerSubject(subject: QuestionSubject, text: string): Promise<{ failed: number }> {
  let failed = 0;
  for (const card of subject.answer.cards) {
    try {
      await api(`/api/threads/${card.threadId}/respond`, {
        method: "POST",
        body: JSON.stringify({ requestId: card.requestId, behavior: "answer", message: text }),
      });
    } catch {
      failed += 1;
    }
  }
  if (subject.answer.pedidos.length) {
    try {
      await api("/api/needs-you/pedidos", { method: "POST", body: JSON.stringify({ ids: subject.answer.pedidos, text }) });
    } catch {
      failed += subject.answer.pedidos.length;
    }
  }
  await refreshNeedsYou();
  return { failed };
}

export type DismissOutcome = "dismissed" | "undone" | "failed";

/**
 * "Already answered": the row leaves the page and every count at once, with a few seconds to undo. Then every card on the
 * subject closes without an answer, its pedir-natan requests are resolved, and a row with no card is hidden.
 */
export function dismissSubject(subject: NeedsYouSubject, undoMs = DISMISS_UNDO_MS): Promise<DismissOutcome> {
  if (pending.has(subject.id)) return Promise.resolve("undone");
  return new Promise((resolve) => {
    const timer = setTimeout(() => void sendDismiss(subject.id), undoMs);
    pending.set(subject.id, { subject, timer, done: resolve });
    publish(fetched);
  });
}

export function undoDismiss(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  publish(fetched);
  entry.done("undone");
}

async function sendDismiss(id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  const { subject } = entry;
  const body: NeedsYouDismissRequest = {
    ids: [subject.id],
    cards: subject.kind === "question" ? subject.answer.cards : [],
    pedidos: subject.kind === "question" ? subject.answer.everyPedido : [],
  };
  let outcome: DismissOutcome = "dismissed";
  try {
    const result = await api<NeedsYouDismissResult>("/api/needs-you/dismiss", { method: "POST", body: JSON.stringify(body) });
    if (result.failed.length) outcome = "failed";
  } catch {
    outcome = "failed";
  }
  // Hidden until the page read after the dismissal arrives, so the row cannot flash back in between.
  await refreshNeedsYou();
  pending.delete(id);
  publish(fetched);
  entry.done(outcome);
}

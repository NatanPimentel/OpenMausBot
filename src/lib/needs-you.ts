import { useEffect, useSyncExternalStore } from "react";
import type { NeedsYouPage, NeedsYouSubject } from "../../shared/needs-you";
import { api } from "@/state/api";

const POLL_MS = 10_000;
/** The page's illustrative icon: an Apple emoji, drawn by the system's emoji font. */
export const NEEDS_YOU_EMOJI = "🙋";
export const EMOJI_FONT = { fontFamily: '"Apple Color Emoji", "Noto Color Emoji", sans-serif' } as const;

interface Snapshot {
  page: NeedsYouPage | null;
  failed: boolean;
}

let snapshot: Snapshot = { page: null, failed: false };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

export function localMidnight(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function refreshNeedsYou(background = false): Promise<void> {
  inFlight ??= api<NeedsYouPage>(`/api/needs-you?since=${localMidnight()}`, { background })
    .then((page) => publish({ page, failed: false }))
    .catch(() => publish({ ...snapshot, failed: true }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

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

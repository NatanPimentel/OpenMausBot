// The Needs you page's wire shape: one row per subject waiting on the person,
// across every bot, and what was settled since the viewer's midnight.
import type { NeedsYouItem } from "./today.ts";

/** A bot that asked, and the conversation where it asked. */
export interface NeedsYouAsker {
  botId?: string;
  name: string;
  threadId?: string;
}

/** Where one answer goes: every open card on the subject, and each pedir-natan request that has no card yet. */
export interface NeedsYouAnswerTargets {
  cards: Array<{ threadId: string; requestId: string }>;
  pedidos: string[];
  /** Every pedir-natan request on the subject, with a card or not: "Already answered" resolves each, so no bot keeps waiting. */
  everyPedido: string[];
}

export type NeedsYouSubject = {
  /** Stable while the subject stays open: its oldest card's request id, or `pedido:<id>`. */
  id: string;
  /** First asked. */
  since: number;
  askers: NeedsYouAsker[];
  /** The conversation "open" goes to: the oldest card's. */
  open?: { botId?: string; threadId: string };
} & (
  /** `options[0]` is the one the bot recommends. */
  | { kind: "question"; text: string; options: string[]; answer: NeedsYouAnswerTargets }
  /** An approval card: answered in its conversation, where its details are. */
  | { kind: "approval"; text: string; title: string }
  /** Work parked on a question that has no card. */
  | { kind: "waiting"; text: string }
  /** Something only the person can fix in settings: a sign-in, a plan, a connection or a place. */
  | { kind: "setup"; item: Exclude<NeedsYouItem, { kind: "question" }> }
);

export interface NeedsYouSettled {
  id: string;
  at: number;
  askers: NeedsYouAsker[];
  text: string;
  /** The answer, or the bot's own "resolved by <bot>: <how>" line. */
  how: string;
  resolvedByBot: boolean;
  /** "dismissed": the person said they already answered it elsewhere; "conversation": they wrote in its conversation after it was asked. */
  via?: "dismissed" | "conversation";
  open?: { botId?: string; threadId: string };
}

export interface NeedsYouPage {
  /** Open subjects: the number the sidebar, the app icon and the desktop reminder show. */
  count: number;
  subjects: NeedsYouSubject[];
  /** Newest first. */
  settled: NeedsYouSettled[];
}

export interface NeedsYouAnswerResult {
  /** Cards and pedir-natan requests the answer reached, and the ones it could not. */
  delivered: number;
  failed: Array<{ target: string; error: string }>;
}

/** "Already answered": closes every target without an answer, and hides the other rows by their subject id. */
export interface NeedsYouDismissRequest {
  ids: string[];
  cards: Array<{ threadId: string; requestId: string }>;
  pedidos: string[];
}

export interface NeedsYouDismissResult {
  dismissed: number;
  failed: Array<{ target: string; error: string }>;
}

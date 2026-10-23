// The Needs you page: every open question card and approval across the bots,
// one row per subject however many bots asked it.
import { isPersistentQuestionCard } from "../shared/ask-question.ts";
import type { NeedsYouAsker, NeedsYouPage, NeedsYouSettled, NeedsYouSubject } from "../shared/needs-you.ts";
import type { NeedsYouItem } from "../shared/today.ts";
import { SAME_ASKER_SUBJECT, SAME_SUBJECT, subjectCorpus, subjectSimilarity, subjectWeights, type SubjectCorpus, type SubjectWeights } from "./question-subjects.ts";

export interface NeedsYouCardRow {
  threadId: string;
  id: string;
  at: number;
  fromBotId: string | null;
  card: string;
}

type Card = Parameters<typeof isPersistentQuestionCard>[0] & {
  title?: string; subtitle?: string; options?: unknown; requestId?: string; answered?: string; answeredText?: string;
  dismissed?: boolean; expired?: boolean; autoApplied?: boolean; outboundRequest?: unknown; quotaSwitch?: unknown; teamMemoryRequest?: unknown;
  answeredBy?: { kind?: string; name?: string; at?: number };
  questionRequest?: { questions?: Array<{ question?: string }> };
};

export interface NeedsYouSources {
  cards: readonly NeedsYouCardRow[];
  bots: ReadonlyArray<{ id: string; name: string }>;
  /** The bot whose conversation a thread is, when it is one. */
  ownerOf(threadId: string): string | undefined;
  visible(threadId: string): boolean;
  /** Today's Needs you items: sign-ins, plans, connections, places and parked work. */
  others: readonly NeedsYouItem[];
}

interface Unit {
  key: string;
  at: number;
  text: string;
  options: string[];
  weights: SubjectWeights;
  asker: NeedsYouAsker;
  card?: { threadId: string; requestId: string; botId?: string };
  settled?: { at: number; how: string };
}

const KIND_ORDER: Record<NeedsYouSubject["kind"], number> = { setup: 0, question: 1, waiting: 1, approval: 1 };
const shortName = (name: string) => name.split(" ·")[0]!.trim();

export function needsYouPage(sources: NeedsYouSources, since: number): NeedsYouPage {
  const botName = new Map(sources.bots.map((bot) => [bot.id, bot.name]));
  const askerFor = (botId: string | undefined, threadId?: string): NeedsYouAsker =>
    ({ ...(botId ? { botId } : {}), name: shortName(botId ? botName.get(botId) ?? "Bot" : "Bot"), ...(threadId ? { threadId } : {}) });

  const units: Unit[] = [];
  const approvals: NeedsYouSubject[] = [];
  const cardIds = new Set<string>();
  const asked: SubjectWeights[] = [];
  for (const row of sources.cards) {
    const card = parse<Card>(row.card);
    if (!card) continue;
    const question = isPersistentQuestionCard(card) ? (card.subtitle || card.questionRequest?.questions?.[0]?.question || card.title || "").trim() : "";
    const options = Array.isArray(card.options) ? card.options.map(String) : [];
    const weights = question ? subjectWeights(question, options) : {};
    if (question) asked.push(weights);
    if (!sources.visible(row.threadId)) continue;
    const open = !card.answered && !card.dismissed && !card.expired;
    const owner = row.fromBotId ?? sources.ownerOf(row.threadId);
    if (!isPersistentQuestionCard(card)) {
      if (open && !card.autoApplied) {
        cardIds.add(row.id);
        approvals.push({ kind: "approval", id: card.requestId ?? row.id, since: row.at, askers: [askerFor(owner, row.threadId)],
          title: oneLine(card.title ?? ""), text: (card.subtitle ?? "").trim(), open: { ...(owner ? { botId: owner } : {}), threadId: row.threadId } });
      }
      continue;
    }
    if (card.outboundRequest || card.quotaSwitch || card.teamMemoryRequest || card.autoApplied || !card.requestId) continue;
    const answeredAt = card.answeredBy?.at;
    const settled: Unit["settled"] = !open && card.answered === "answer" && answeredAt !== undefined && answeredAt >= since
      ? { at: answeredAt, how: (card.answeredText ?? "").trim() }
      : undefined;
    if (!open && !settled) continue;
    if (open) cardIds.add(row.id);
    units.push({
      key: card.requestId, at: row.at, text: question, options, weights, asker: askerFor(owner, row.threadId),
      card: { threadId: row.threadId, requestId: card.requestId, ...(owner ? { botId: owner } : {}) },
      ...(settled ? { settled } : {}),
    });
  }

  // Every question ever asked: a word rare across them is a strong sign of one subject.
  const corpus = subjectCorpus(asked);

  const subjects: NeedsYouSubject[] = [...approvals];
  const settled: NeedsYouSettled[] = [];
  for (const group of sameSubjects(units, corpus)) {
    const first = group[0]!;
    const askers = uniqueAskers(group.map((unit) => unit.asker));
    const open = group.find((unit) => unit.card)?.card;
    const opening = open ? { open: { ...(open.botId ? { botId: open.botId } : {}), threadId: open.threadId } } : {};
    const waiting = group.filter((unit) => !unit.settled);
    if (waiting.length) {
      const lead = waiting[0]!;
      subjects.push({ kind: "question", id: lead.key, since: first.at, askers, text: lead.text, options: lead.options, ...opening,
        answer: { cards: waiting.flatMap((unit) => unit.card ? [{ threadId: unit.card.threadId, requestId: unit.card.requestId }] : []) } });
      continue;
    }
    const told = [...group].sort((a, b) => b.settled!.at - a.settled!.at)[0]!;
    settled.push({ id: first.key, at: told.settled!.at, askers, text: first.text, how: told.settled!.how, ...opening });
  }

  for (const item of sources.others) {
    if (item.kind === "question") {
      if (cardIds.has(item.id)) continue;
      subjects.push({ kind: "waiting", id: item.id, since: item.at, askers: [askerFor(item.botId, item.threadId)], text: item.text,
        open: { botId: item.botId, threadId: item.threadId } });
      continue;
    }
    subjects.push({ kind: "setup", id: item.id, since: item.at, askers: item.botIds.map((botId) => askerFor(botId)), item,
      ...(item.threadId ? { open: { ...(item.botIds[0] ? { botId: item.botIds[0] } : {}), threadId: item.threadId } } : {}) });
  }

  subjects.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since);
  settled.sort((a, b) => b.at - a.at);
  return { count: subjects.length, subjects, settled };
}

/** Questions are one subject when they read alike, or read nearly alike from the same bot. */
export function sameSubjects<T extends { at: number; weights: SubjectWeights; asker: NeedsYouAsker }>(units: readonly T[], corpus: SubjectCorpus): T[][] {
  const sorted = [...units].sort((a, b) => a.at - b.at);
  const root = sorted.map((_, index) => index);
  const find = (index: number): number => root[index] === index ? index : (root[index] = find(root[index]!));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!, b = sorted[j]!;
      const similarity = subjectSimilarity(a.weights, b.weights, corpus);
      if (similarity >= SAME_SUBJECT || (similarity >= SAME_ASKER_SUBJECT && a.asker.botId !== undefined && a.asker.botId === b.asker.botId)) root[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  sorted.forEach((unit, index) => {
    const group = groups.get(find(index)) ?? [];
    group.push(unit);
    groups.set(find(index), group);
  });
  return [...groups.values()];
}

function uniqueAskers(askers: readonly NeedsYouAsker[]): NeedsYouAsker[] {
  const seen = new Map<string, NeedsYouAsker>();
  for (const asker of askers) if (!seen.has(asker.botId ?? asker.name)) seen.set(asker.botId ?? asker.name, asker);
  return [...seen.values()];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parse<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

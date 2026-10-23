// The Needs you page: every open question card, approval and pedir-natan
// request across the bots, one row per subject however many bots asked it.
import { isPersistentQuestionCard } from "../shared/ask-question.ts";
import type { NeedsYouAsker, NeedsYouPage, NeedsYouSettled, NeedsYouSubject } from "../shared/needs-you.ts";
import type { NeedsYouItem } from "../shared/today.ts";
import { pedidoOf, PEDIDO_FOOTER, type Pedido } from "./pedir-natan.ts";
import { SAME_ASKER_SUBJECT, SAME_SUBJECT, subjectCorpus, subjectSimilarity, subjectWeights, withoutAccents, type SubjectCorpus, type SubjectWeights } from "./question-subjects.ts";

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
  pedidos: readonly Pedido[];
  bots: ReadonlyArray<{ id: string; name: string }>;
  /** The bot whose conversation a thread is, when it is one. */
  ownerOf(threadId: string): string | undefined;
  visible(threadId: string): boolean;
  /** Today's Needs you items: sign-ins, plans, connections, places and parked work. */
  others: readonly NeedsYouItem[];
  /** pedir-natan requests an answer is on its way to. */
  answering: ReadonlySet<string>;
}

interface Unit {
  key: string;
  at: number;
  text: string;
  options: string[];
  weights: SubjectWeights;
  asker: NeedsYouAsker;
  pedido?: string;
  card?: { threadId: string; requestId: string; botId?: string };
  settled?: { at: number; how: string; byPerson: boolean; byBot: boolean };
}

/** pergunta-registro's words when it closes a duplicate card: the subject stays open on the card it points to. */
const DUPLICATE_CLOSE = /^(?:Duplicad[oa]|Respondido pelo Natan em)/u;
const KIND_ORDER: Record<NeedsYouSubject["kind"], number> = { setup: 0, question: 1, waiting: 1, approval: 1 };
const shortName = (name: string) => name.split(" ·")[0]!.trim();

export function needsYouPage(sources: NeedsYouSources, since: number): NeedsYouPage {
  const pedidos = new Map(sources.pedidos.map((pedido) => [pedido.id, pedido]));
  const botName = new Map(sources.bots.map((bot) => [bot.id, bot.name]));
  const askerFor = (botId: string | undefined, threadId?: string): NeedsYouAsker =>
    ({ ...(botId ? { botId } : {}), name: shortName(botId ? botName.get(botId) ?? "Bot" : "Bot"), ...(threadId ? { threadId } : {}) });
  const botNamed = (origin: string) => {
    const words = new Set(withoutAccents(origin.toLowerCase()).split(/[^\p{L}\p{N}]+/u));
    return sources.bots.find((bot) => words.has(withoutAccents(shortName(bot.name).toLowerCase())))?.id;
  };

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
    const footer = pedidoOf(question);
    const pedido = footer ? pedidos.get(footer.id) : undefined;
    const answeredAt = card.answeredBy?.at;
    let settled: Unit["settled"];
    if (open && pedido && !pedido.open) settled = settledPedido(pedido);
    else if (!open && card.answered === "answer" && answeredAt !== undefined) {
      settled = settledCard(card.answeredText ?? "", answeredAt, (card.answeredBy?.name ?? "").endsWith("(CLI)"));
    }
    if (open && footer && sources.answering.has(footer.id)) continue;
    if (!open && !settled) continue;
    if (settled && settled.at < since) continue;
    if (open) cardIds.add(row.id);
    const asker = footer ? (botNamed(footer.origin) ? askerFor(botNamed(footer.origin), row.threadId) : { name: footer.origin, threadId: row.threadId }) : askerFor(owner, row.threadId);
    units.push({
      key: card.requestId, at: row.at, text: question.replace(PEDIDO_FOOTER, "").trim(), options, weights, asker,
      ...(footer ? { pedido: footer.id } : {}), card: { threadId: row.threadId, requestId: card.requestId, ...(owner ? { botId: owner } : {}) },
      ...(settled ? { settled } : {}),
    });
  }

  // Every question ever asked: a word rare across them is a strong sign of one subject.
  const corpus = subjectCorpus(asked);
  const carded = new Set(units.flatMap((unit) => unit.pedido ? [unit.pedido] : []));
  for (const pedido of sources.pedidos) {
    if (carded.has(pedido.id) || sources.answering.has(pedido.id)) continue;
    const settled = pedido.open ? undefined : settledPedido(pedido);
    if (!pedido.open && (!settled || settled.at < since)) continue;
    const text = pedido.title + (pedido.text ? `\n\n${pedido.text}` : "");
    const options = recommendedFirst(pedido.options, pedido.recommended);
    const botId = botNamed(pedido.origin);
    units.push({ key: `pedido:${pedido.id}`, at: pedido.createdAt, text, options, weights: subjectWeights(text, options),
      asker: botId ? askerFor(botId) : { name: pedido.origin || "pedir-natan" }, pedido: pedido.id, ...(settled ? { settled } : {}) });
  }

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
        answer: {
          cards: waiting.flatMap((unit) => unit.card ? [{ threadId: unit.card.threadId, requestId: unit.card.requestId }] : []),
          pedidos: waiting.flatMap((unit) => !unit.card && unit.pedido ? [unit.pedido] : []),
        } });
      continue;
    }
    const answered = group.filter((unit) => unit.settled!.at >= since);
    const told = answered.filter((unit) => unit.settled!.byPerson || unit.settled!.byBot).sort((a, b) => b.settled!.at - a.settled!.at)[0];
    if (!told) continue;
    settled.push({ id: first.key, at: told.settled!.at, askers, text: first.text, how: told.settled!.how, resolvedByBot: told.settled!.byBot, ...opening });
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

/** Questions are one subject when they settle the same pedido, read alike, or read nearly alike from the same bot. */
export function sameSubjects<T extends { at: number; weights: SubjectWeights; pedido?: string; asker: NeedsYouAsker }>(units: readonly T[], corpus: SubjectCorpus): T[][] {
  const sorted = [...units].sort((a, b) => a.at - b.at);
  const root = sorted.map((_, index) => index);
  const find = (index: number): number => root[index] === index ? index : (root[index] = find(root[index]!));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!, b = sorted[j]!;
      const same = (a.pedido !== undefined && a.pedido === b.pedido) || (() => {
        const similarity = subjectSimilarity(a.weights, b.weights, corpus);
        return similarity >= SAME_SUBJECT || (similarity >= SAME_ASKER_SUBJECT && a.asker.botId !== undefined && a.asker.botId === b.asker.botId);
      })();
      if (same) root[find(j)] = find(i);
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

/** A tool closing a card is a bot settling it, unless it closed a copy of a subject still asked elsewhere. */
function settledCard(answer: string, at: number, byTool: boolean): Unit["settled"] {
  const copy = byTool && DUPLICATE_CLOSE.test(answer);
  return { at, how: answer.trim(), byPerson: !byTool, byBot: byTool && !copy };
}

function settledPedido(pedido: Pedido): Unit["settled"] {
  if (pedido.open || pedido.answeredAt === undefined) return undefined;
  return { at: pedido.answeredAt, how: pedido.answer ?? "", byPerson: !pedido.resolved && !DUPLICATE_CLOSE.test(pedido.answer ?? ""), byBot: pedido.resolved === true };
}

function recommendedFirst(options: readonly string[], recommended: number): string[] {
  if (recommended < 0 || recommended >= options.length) return [...options];
  return [options[recommended]!, ...options.filter((_, index) => index !== recommended)];
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

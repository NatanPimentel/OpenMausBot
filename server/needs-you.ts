// The Needs you page: every open question card, approval and pedir-natan
// request across the bots, one row per subject however many bots asked it.
import { existsSync, readFileSync } from "node:fs";
import { isPersistentQuestionCard } from "../shared/ask-question.ts";
import type { NeedsYouAsker, NeedsYouPage, NeedsYouSettled, NeedsYouSubject } from "../shared/needs-you.ts";
import type { NeedsYouItem } from "../shared/today.ts";
import { writeFileAtomic } from "./atomic.ts";
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
  answeredBy?: { kind?: string; name?: string; at?: number; dismissed?: boolean };
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
  /** When the person last wrote in a conversation themselves (not a routine, a trigger, a tool or another bot). */
  personSaidAt?(threadId: string): number | undefined;
  /** Rows the person marked "already answered" that have no card to close, by `hiddenKey`. */
  hidden?: ReadonlyMap<string, NeedsYouHidden>;
}

/** What a hidden row showed, for "Settled today". */
export interface NeedsYouHidden {
  at: number;
  text: string;
  askers: NeedsYouAsker[];
  open?: { botId?: string; threadId: string };
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
  settled?: Settlement;
}

interface Settlement { at: number; how: string; byPerson: boolean; byBot: boolean; via?: NeedsYouSettled["via"] }

/** pergunta-registro's words when it closes a duplicate card: the subject stays open on the card it points to. */
const DUPLICATE_CLOSE = /^(?:Duplicad[oa]|Respondido pelo Natan em)/u;
const KIND_ORDER: Record<NeedsYouSubject["kind"], number> = { setup: 0, question: 1, waiting: 1, approval: 1 };
const shortName = (name: string) => name.split(" ·")[0]!.trim();
/** The line "Already answered" leaves on a pedir-natan request it resolves. */
export const DISMISSED_PEDIDO_BY = "Natan";
export const DISMISSED_PEDIDO_LINE = "já respondido (descartado em Precisa de você)";
const DISMISSED_PEDIDO = new RegExp(`^resolvid[oa] por ${DISMISSED_PEDIDO_BY}:`, "u");

/** One occurrence of a row without a card: the same sign-in failing again tomorrow is a new row. */
export const hiddenKey = (subject: Pick<NeedsYouSubject, "kind" | "id" | "since">) => `${subject.kind}:${subject.id}:${subject.since}`;

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
    // A pedir-natan copy waits on its request, which an aside in the same conversation does not settle.
    const saidAt = open && !footer ? sources.personSaidAt?.(row.threadId) : undefined;
    let settled: Unit["settled"];
    if (open && pedido && !pedido.open) settled = settledPedido(pedido);
    else if (open && saidAt !== undefined && saidAt > row.at) settled = { at: saidAt, how: "", byPerson: true, byBot: false, via: "conversation" };
    else if (!open && card.answeredBy?.dismissed && answeredAt !== undefined) settled = { at: answeredAt, how: "", byPerson: true, byBot: false, via: "dismissed" };
    else if (!open && card.answered === "answer" && answeredAt !== undefined) {
      settled = settledCard(card.answeredText ?? "", answeredAt, (card.answeredBy?.name ?? "").endsWith("(CLI)"));
    }
    if (open) cardIds.add(row.id);
    if (open && footer && sources.answering.has(footer.id)) continue;
    if (!open && !settled) continue;
    if (settled && settled.at < since) continue;
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
          everyPedido: [...new Set(waiting.flatMap((unit) => unit.pedido ? [unit.pedido] : []))],
        } });
      continue;
    }
    const answered = group.filter((unit) => unit.settled!.at >= since);
    const told = answered.filter((unit) => unit.settled!.byPerson || unit.settled!.byBot).sort((a, b) => b.settled!.at - a.settled!.at)[0];
    if (!told) continue;
    const via = told.settled!.via;
    settled.push({ id: first.key, at: told.settled!.at, askers, text: first.text, how: told.settled!.how, resolvedByBot: told.settled!.byBot, ...(via ? { via } : {}), ...opening });
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

  for (const [key, row] of sources.hidden ?? []) {
    if (row.at >= since) settled.push({ id: key, at: row.at, askers: row.askers, text: row.text, how: "", resolvedByBot: false, via: "dismissed", ...(row.open ? { open: row.open } : {}) });
  }
  const shown = sources.hidden?.size ? subjects.filter((subject) => subject.kind === "question" || !sources.hidden!.has(hiddenKey(subject))) : subjects;
  shown.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since);
  settled.sort((a, b) => b.at - a.at);
  return { count: shown.length, subjects: shown, settled };
}

const HIDDEN_KEPT_MS = 30 * 24 * 60 * 60_000;

/** Rows marked "already answered" that have no card to close, in a small file beside the data; a month later they are forgotten. */
export function createHiddenRows(file: string, now: () => number = Date.now): { all(): ReadonlyMap<string, NeedsYouHidden>; add(key: string, row: NeedsYouHidden): void } {
  const rows = new Map<string, NeedsYouHidden>();
  try {
    if (existsSync(file)) for (const [key, row] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, NeedsYouHidden>)) rows.set(key, row);
  } catch { /* An unreadable file only brings the rows back. */ }
  return {
    all: () => rows,
    add(key, row) {
      rows.set(key, row);
      for (const [old, kept] of rows) if (now() - kept.at > HIDDEN_KEPT_MS) rows.delete(old);
      writeFileAtomic(file, `${JSON.stringify(Object.fromEntries(rows))}\n`, { mode: 0o600 });
    },
  };
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
  if (pedido.resolved && DISMISSED_PEDIDO.test(pedido.answer ?? "")) return { at: pedido.answeredAt, how: "", byPerson: true, byBot: false, via: "dismissed" };
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

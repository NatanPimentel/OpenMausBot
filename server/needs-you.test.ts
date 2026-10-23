import { describe, expect, it } from "vitest";
import type { NeedsYouItem } from "../shared/today.ts";
import { FUNNEL_DUPLICATES, MEETING_QUESTIONS, OTHER_QUESTIONS, STALLED_PROPOSAL, type FixtureQuestion } from "./needs-you.fixtures.ts";
import { needsYouPage, type NeedsYouCardRow, type NeedsYouSources } from "./needs-you.ts";
import type { Pedido } from "./pedir-natan.ts";

const BOTS = [
  { id: "b-funil", name: "Brunson · Funil" },
  { id: "b-drucker", name: "Drucker · Reuniões" },
  { id: "b-chefe", name: "Sandberg · Chefe de Operação" },
  { id: "b-social", name: "GaryVee · Social" },
  { id: "b-financeiro", name: "Buffett · Financeiro" },
  { id: "b-suporte", name: "Hsieh · Suporte" },
];
const MIDNIGHT = Date.UTC(2026, 9, 23, 3);
const ALL = [...FUNNEL_DUPLICATES, ...STALLED_PROPOSAL, ...MEETING_QUESTIONS, ...OTHER_QUESTIONS];

type CardState = { answered?: string; answeredText?: string; answeredBy?: { kind: string; name?: string; at?: number } };

function cardRow(question: FixtureQuestion, at: number, state: CardState = {}): NeedsYouCardRow {
  return {
    threadId: question.thread, id: `m-${question.key}`, at, fromBotId: null,
    card: JSON.stringify({ title: "Your bot has a question", subtitle: question.text, options: question.options, requestId: `r-${question.key}`, requestType: "question", ...state }),
  };
}

function sources(cards: NeedsYouCardRow[], extra: Partial<NeedsYouSources> = {}): NeedsYouSources {
  return {
    cards, pedidos: [], bots: BOTS, others: [], answering: new Set(), visible: () => true,
    ownerOf: (threadId) => `b-${threadId.split("-")[0]}`,
    ...extra,
  };
}

const openCards = (questions = ALL) => questions.map((question, index) => cardRow(question, MIDNIGHT + 9 * 3600_000 + index * 60_000));
const answeredBy = (at: number) => ({ answered: "answer", answeredBy: { kind: "loopback", at } });
const keysOf = (questions: FixtureQuestion[]) => questions.map((question) => `r-${question.key}`);

describe("needsYouPage", () => {
  it("shows each of today's subjects once, however many bots and copies asked it", () => {
    const page = needsYouPage(sources(openCards()), MIDNIGHT);
    const questions = page.subjects.filter((subject) => subject.kind === "question");

    const funnel = questions.filter((subject) => subject.answer.cards.some((card) => keysOf(FUNNEL_DUPLICATES).includes(card.requestId)));
    expect(funnel).toHaveLength(1);
    expect(funnel[0]!.answer.cards.map((card) => card.requestId).sort()).toEqual(keysOf(FUNNEL_DUPLICATES).sort());
    expect(funnel[0]!.askers.map((asker) => asker.name)).toEqual(["Brunson"]);

    const proposal = questions.filter((subject) => subject.answer.cards.some((card) => keysOf(STALLED_PROPOSAL).includes(card.requestId)));
    expect(proposal).toHaveLength(1);
    expect(proposal[0]!.answer.cards).toHaveLength(2);

    const meeting = questions.filter((subject) => subject.answer.cards.some((card) => keysOf(MEETING_QUESTIONS).includes(card.requestId)));
    expect(meeting.map((subject) => subject.answer.cards.map((card) => card.requestId).sort())).toEqual([
      ["r-desconto", "r-desconto-pedido"], ["r-promessas", "r-promessas-pedido"], ["r-cadastro", "r-cadastro-pedido"], ["r-prazo"],
    ]);
    expect(meeting.every((subject) => subject.askers.length === 1 && subject.askers[0]!.name === "Drucker")).toBe(true);
    expect(meeting[0]).toMatchObject({ options: MEETING_QUESTIONS[0]!.options, open: { botId: "b-drucker", threadId: "drucker-call" } });

    expect(questions).toHaveLength(1 + 1 + 4 + OTHER_QUESTIONS.length);
    expect(page.count).toBe(page.subjects.length);
  });

  it("drops a subject from the page once one answer settled every card that asked it", () => {
    const at = MIDNIGHT + 12 * 3600_000;
    const cards = openCards().map((row) => FUNNEL_DUPLICATES.some((question) => row.id === `m-${question.key}`)
      ? cardRow(ALL.find((question) => row.id === `m-${question.key}`)!, row.at, { ...answeredBy(at), answeredText: "Mesclar os 4 pares" })
      : row);
    const page = needsYouPage(sources(cards), MIDNIGHT);

    expect(page.subjects.some((subject) => subject.kind === "question" && subject.answer.cards.some((card) => keysOf(FUNNEL_DUPLICATES).includes(card.requestId)))).toBe(false);
    expect(page.count).toBe(1 + 4 + OTHER_QUESTIONS.length);
    expect(page.settled).toEqual([expect.objectContaining({ id: "r-funil-a", at, how: "Mesclar os 4 pares", resolvedByBot: false })]);
    expect(needsYouPage(sources(cards), at + 1).settled).toEqual([]);
  });

  it("keeps a subject open while a copy closed as a duplicate points at the card still waiting", () => {
    const at = MIDNIGHT + 12 * 3600_000;
    const [own, copy] = [MEETING_QUESTIONS[2]!, MEETING_QUESTIONS[6]!];
    const page = needsYouPage(sources([
      cardRow(own, MIDNIGHT + 1000),
      cardRow(copy, MIDNIGHT + 2000, { answered: "answer", answeredText: "Duplicado: este assunto segue aberto na thread drucker (cartão r-cadastro).", answeredBy: { kind: "session", name: "Dr. Eggbot (CLI)", at } }),
    ]), MIDNIGHT);

    expect(page.subjects).toEqual([expect.objectContaining({ kind: "question", id: "r-cadastro", answer: { cards: [{ threadId: "drucker-call", requestId: "r-cadastro" }], pedidos: [] } })]);
    expect(page.settled).toEqual([]);
  });

  it("settles a card whose pedir-natan request the bot resolved, with the bot's line", () => {
    const at = MIDNIGHT + 13 * 3600_000;
    const copy = MEETING_QUESTIONS[4]!;
    const resolved: Pedido = { id: "64eff31e", createdAt: MIDNIGHT, origin: "Drucker", title: "Anselmo", text: "", options: ["a", "b"], recommended: 0,
      open: false, answer: "resolvido por Drucker: ele fechou sem desconto", resolved: true, answeredAt: at };
    const page = needsYouPage(sources([cardRow(copy, MIDNIGHT + 1000)], { pedidos: [resolved] }), MIDNIGHT);

    expect(page.subjects).toEqual([]);
    expect(page.settled).toEqual([expect.objectContaining({ how: "resolvido por Drucker: ele fechou sem desconto", resolvedByBot: true, askers: [expect.objectContaining({ name: "Drucker" })] })]);
  });

  it("lists a pedir-natan request with no card yet, recommended option first, and hides it while an answer is on its way", () => {
    const pedido: Pedido = { id: "47ac81ef", createdAt: MIDNIGHT + 5000, origin: "Faxina de cartões (Brunson)", title: "Confirmação da call das 11h",
      text: "Mando eu mesmo ou ligo a proteção de envio?", options: ["Ligo a proteção", "Mando eu mesmo"], recommended: 1, open: true };
    const page = needsYouPage(sources([], { pedidos: [pedido] }), MIDNIGHT);

    expect(page.subjects).toEqual([expect.objectContaining({
      kind: "question", id: "pedido:47ac81ef", options: ["Mando eu mesmo", "Ligo a proteção"], askers: [{ botId: "b-funil", name: "Brunson" }],
      answer: { cards: [], pedidos: ["47ac81ef"] },
    })]);
    expect(needsYouPage(sources([], { pedidos: [pedido], answering: new Set(["47ac81ef"]) }), MIDNIGHT).subjects).toEqual([]);
  });

  it("adds open approvals, parked work and settings problems, each opening its conversation", () => {
    const approval: NeedsYouCardRow = { threadId: "funil-main", id: "m-approval", at: MIDNIGHT + 10, fromBotId: "b-funil",
      card: JSON.stringify({ title: "Create a routine", subtitle: "Every day at 8h", options: ["Allow", "Deny"], requestId: "r-routine", routineRequest: { name: "x" } }) };
    const receipt: NeedsYouCardRow = { ...approval, id: "m-receipt", card: JSON.stringify({ title: "Changed", subtitle: "", options: [], requestId: "r-auto", autoApplied: true, routineRequest: {} }) };
    const others: NeedsYouItem[] = [
      { kind: "question", id: "m-desconto", at: 1, botId: "b-drucker", threadId: "drucker-call", text: "covered by its card" },
      { kind: "question", id: "parked-1", at: MIDNIGHT + 20, botId: "b-social", threadId: "social-main", text: "Which photo goes on the cover?" },
      { kind: "signed-out", id: "signed-out:claude", at: MIDNIGHT + 30, instanceId: "claude", botIds: ["b-funil"] },
    ];
    const page = needsYouPage(sources([approval, receipt, cardRow(MEETING_QUESTIONS[0]!, MIDNIGHT + 40)], { others }), MIDNIGHT);

    expect(page.subjects.map((subject) => [subject.kind, subject.id])).toEqual([
      ["setup", "signed-out:claude"], ["approval", "r-routine"], ["waiting", "parked-1"], ["question", "r-desconto"],
    ]);
    expect(page.subjects[1]).toMatchObject({ title: "Create a routine", open: { botId: "b-funil", threadId: "funil-main" } });
    expect(page.count).toBe(4);
  });

  it("shows only conversations the viewer may see", () => {
    const page = needsYouPage(sources(openCards(STALLED_PROPOSAL), { visible: (threadId) => threadId !== "funil-main" }), MIDNIGHT);
    expect(page.subjects).toEqual([expect.objectContaining({ answer: { cards: [{ threadId: "chefe-pedido-2", requestId: "r-proposta-b" }], pedidos: [] } })]);
  });
});

import { describe, expect, it } from "vitest";
import type { NeedsYouItem } from "../shared/today.ts";
import { DUPLICATE_CONTACTS, OTHER_QUESTIONS, STALLED_QUOTE, type FixtureQuestion } from "./needs-you.fixtures.ts";
import { needsYouPage, type NeedsYouCardRow, type NeedsYouSources } from "./needs-you.ts";

const BOTS = [
  { id: "b-ada", name: "Ada · Sales" },
  { id: "b-bruno", name: "Bruno · Operations" },
  { id: "b-cleo", name: "Cleo · Support" },
];
const MIDNIGHT = Date.UTC(2026, 9, 23, 3);

type CardState = { answered?: string; answeredText?: string; answeredBy?: { kind: string; name?: string; at?: number } };

/** `thread` is "<bot>-<where>": the sources map it back to the bot that owns the conversation. */
function cardRow(question: FixtureQuestion, thread: string, at: number, state: CardState = {}): NeedsYouCardRow {
  return {
    threadId: thread, id: `m-${question.key}`, at, fromBotId: null,
    card: JSON.stringify({ title: "Your bot has a question", subtitle: question.text, options: question.options, requestId: `r-${question.key}`, requestType: "question", ...state }),
  };
}

function sources(cards: NeedsYouCardRow[], extra: Partial<NeedsYouSources> = {}): NeedsYouSources {
  return { cards, bots: BOTS, others: [], visible: () => true, ownerOf: (threadId) => `b-${threadId.split("-")[0]}`, ...extra };
}

/** Both copies of the duplicate contacts question (from two bots), the stalled quote, and the unrelated ones. */
const openCards = () => [
  cardRow(DUPLICATE_CONTACTS[0]!, "ada-main", MIDNIGHT + 1000),
  cardRow(DUPLICATE_CONTACTS[1]!, "bruno-main", MIDNIGHT + 2000),
  cardRow(STALLED_QUOTE, "ada-main", MIDNIGHT + 3000),
  ...OTHER_QUESTIONS.map((question, index) => cardRow(question, "cleo-main", MIDNIGHT + 4000 + index)),
];

describe("needsYouPage", () => {
  it("shows each subject once, however many bots asked it", () => {
    const page = needsYouPage(sources(openCards()), MIDNIGHT);
    const questions = page.subjects.filter((subject) => subject.kind === "question");

    const contacts = questions.filter((subject) => subject.answer.cards.some((card) => card.requestId === "r-contacts-a"));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      id: "r-contacts-a", options: DUPLICATE_CONTACTS[0]!.options, open: { botId: "b-ada", threadId: "ada-main" },
      askers: [expect.objectContaining({ name: "Ada" }), expect.objectContaining({ name: "Bruno" })],
      answer: { cards: [{ threadId: "ada-main", requestId: "r-contacts-a" }, { threadId: "bruno-main", requestId: "r-contacts-b" }] },
    });
    expect(questions.find((subject) => subject.id === "r-quote")).toMatchObject({ answer: { cards: [{ requestId: "r-quote" }] } });
    expect(questions).toHaveLength(2 + OTHER_QUESTIONS.length);
    expect(page.count).toBe(page.subjects.length);
  });

  it("moves a subject to the settled list once every card that asked it is answered", () => {
    const at = MIDNIGHT + 12 * 3600_000;
    const answered = { answered: "answer", answeredText: "Merge both pairs", answeredBy: { kind: "session", at } };
    const cards = [
      cardRow(DUPLICATE_CONTACTS[0]!, "ada-main", MIDNIGHT + 1000, answered),
      cardRow(DUPLICATE_CONTACTS[1]!, "bruno-main", MIDNIGHT + 2000, answered),
      cardRow(STALLED_QUOTE, "ada-main", MIDNIGHT + 3000),
    ];
    const page = needsYouPage(sources(cards), MIDNIGHT);

    expect(page.subjects.map((subject) => subject.id)).toEqual(["r-quote"]);
    expect(page.settled).toEqual([expect.objectContaining({ id: "r-contacts-a", at, how: "Merge both pairs" })]);
    expect(needsYouPage(sources(cards), at + 1).settled).toEqual([]);
  });

  it("keeps a subject open while one of its cards still waits, and does not settle the answered copy", () => {
    const answered = { answered: "answer", answeredText: "Merge both pairs", answeredBy: { kind: "session", at: MIDNIGHT + 5000 } };
    const page = needsYouPage(sources([
      cardRow(DUPLICATE_CONTACTS[0]!, "ada-main", MIDNIGHT + 1000, answered),
      cardRow(DUPLICATE_CONTACTS[1]!, "bruno-main", MIDNIGHT + 2000),
    ]), MIDNIGHT);

    expect(page.subjects).toEqual([expect.objectContaining({ kind: "question", id: "r-contacts-b", answer: { cards: [{ threadId: "bruno-main", requestId: "r-contacts-b" }] } })]);
    expect(page.settled).toEqual([]);
  });

  it("never drops a question for being old, and skips an answer recorded without a time", () => {
    const page = needsYouPage(sources([
      cardRow(STALLED_QUOTE, "ada-main", 1),
      cardRow(OTHER_QUESTIONS[0]!, "cleo-main", 2, { answered: "answer", answeredText: "Text only", answeredBy: { kind: "session" } }),
    ]), MIDNIGHT);
    expect(page.subjects.map((subject) => subject.id)).toEqual(["r-quote"]);
    expect(page.settled).toEqual([]);
  });

  it("adds open approvals, parked work and settings problems, each opening its conversation", () => {
    const approval: NeedsYouCardRow = { threadId: "ada-main", id: "m-approval", at: MIDNIGHT + 10, fromBotId: "b-ada",
      card: JSON.stringify({ title: "Create a routine", subtitle: "Every day at 8h", options: ["Allow", "Deny"], requestId: "r-routine", routineRequest: { name: "x" } }) };
    const receipt: NeedsYouCardRow = { ...approval, id: "m-receipt", card: JSON.stringify({ title: "Changed", subtitle: "", options: [], requestId: "r-auto", autoApplied: true, routineRequest: {} }) };
    const others: NeedsYouItem[] = [
      { kind: "question", id: "m-quote", at: 1, botId: "b-ada", threadId: "ada-main", text: "covered by its card" },
      { kind: "question", id: "parked-1", at: MIDNIGHT + 20, botId: "b-cleo", threadId: "cleo-main", text: "Which photo goes on the cover?" },
      { kind: "signed-out", id: "signed-out:claude", at: MIDNIGHT + 30, instanceId: "claude", botIds: ["b-ada"] },
    ];
    const page = needsYouPage(sources([approval, receipt, cardRow(STALLED_QUOTE, "ada-main", MIDNIGHT + 40)], { others }), MIDNIGHT);

    expect(page.subjects.map((subject) => [subject.kind, subject.id])).toEqual([
      ["setup", "signed-out:claude"], ["approval", "r-routine"], ["waiting", "parked-1"], ["question", "r-quote"],
    ]);
    expect(page.subjects[1]).toMatchObject({ title: "Create a routine", open: { botId: "b-ada", threadId: "ada-main" } });
    expect(page.count).toBe(4);
  });

  it("shows only conversations the viewer may see", () => {
    const page = needsYouPage(sources(openCards().slice(0, 2), { visible: (threadId) => threadId !== "ada-main" }), MIDNIGHT);
    expect(page.subjects).toEqual([expect.objectContaining({ answer: { cards: [{ threadId: "bruno-main", requestId: "r-contacts-b" }] } })]);
  });
});

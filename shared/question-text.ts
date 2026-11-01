// Local mod (Imobiturbo, 29/10/2026): what a bot asks the person, in the bot's own words. "Your bot has a question"
// says nothing, so a conversation preview, Today and a notification show the question itself.

/** The stored title of a bot's question card; the question itself is the card's subtitle. */
export const QUESTION_CARD_TITLE = "Your bot has a question";

const NEEDS_INPUT = /^needs input:/i;
const NEEDS_INPUT_NONE = /^(?:nenhum|nenhuma|nada|none|nothing|n\/a|-+|—|–)(?=[\s.,;:!]|$)/i;

type AskCard = {
  title?: string;
  subtitle?: string;
  tool?: string;
  requestType?: string;
  questionRequest?: { questions?: readonly { question?: string }[] };
};

/** A question card's question, or undefined for an approval or any other card. */
export function questionCardText(card: AskCard | null | undefined): string | undefined {
  if (!card) return undefined;
  const asked = card.questionRequest?.questions?.[0]?.question?.trim();
  if (asked) return asked;
  if (card.tool) return undefined;
  const question = card.requestType === "question" || card.title === QUESTION_CARD_TITLE;
  return question ? card.subtitle?.trim() || undefined : undefined;
}

/** The question a reply ends with on a `NEEDS INPUT:` line, or the line before a closing `Default:` line (upstream
 * v0.1.136); undefined when it asks nothing. */
export function needsInputQuestion(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const filled = (from: number) => { let at = from; while (at >= 0 && lines[at]!.trim() === "") at -= 1; return at; };
  const last = filled(lines.length - 1);
  if (last < 0) return undefined;
  const at = /^default:/i.test(lines[last]!.trim()) ? filled(last - 1) : last;
  const line = at < 0 ? "" : lines[at]!.trim();
  if (!NEEDS_INPUT.test(line)) return undefined;
  const question = [line.slice("NEEDS INPUT:".length), ...lines.slice(at + 1)].join("\n").trim();
  // Local patch: "NEEDS INPUT: nenhum." is a bot saying it needs nothing, not a question.
  if (NEEDS_INPUT_NONE.test(question) && !question.includes("?")) return undefined;
  return question || undefined;
}

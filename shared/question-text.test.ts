import { describe, expect, it } from "vitest";
import { needsInputQuestion, QUESTION_CARD_TITLE, questionCardText } from "./question-text.ts";

describe("questionCardText (local mod)", () => {
  it("reads a bot's question from the card's subtitle, not its stored title", () => {
    const card = { title: QUESTION_CARD_TITLE, subtitle: "Natan, você libera o PR #1810 do OS?", requestType: "question" };
    expect(questionCardText(card)).toBe("Natan, você libera o PR #1810 do OS?");
    expect(questionCardText({ title: QUESTION_CARD_TITLE, subtitle: "  Which account?  " }), "a card stored before requestType").toBe("Which account?");
  });

  it("prefers a structured question's own words", () => {
    const card = { title: QUESTION_CARD_TITLE, subtitle: "Region · Size", requestType: "question", questionRequest: { questions: [{ question: "Which region?" }, { question: "Which size?" }] } };
    expect(questionCardText(card)).toBe("Which region?");
  });

  it("leaves approvals, other cards and empty questions alone", () => {
    expect(questionCardText({ title: "Approval needed", subtitle: "rm -rf build", tool: "Bash", requestType: "permission" })).toBeUndefined();
    expect(questionCardText({ title: "Published “Site”", subtitle: "https://example.com" })).toBeUndefined();
    expect(questionCardText({ title: "Which price?", subtitle: "", requestType: "question" })).toBeUndefined();
    expect(questionCardText(undefined)).toBeUndefined();
  });
});

describe("needsInputQuestion (shared with the coordinator)", () => {
  it("reads the question a reply ends with", () => {
    expect(needsInputQuestion("Feito o plano.\n\nNEEDS INPUT: Natan, você libera o PR #1810 do OS?\n")).toBe("Natan, você libera o PR #1810 do OS?");
    expect(needsInputQuestion("Done.\nNEEDS INPUT: nenhum.")).toBeUndefined();
    expect(needsInputQuestion("NEEDS INPUT: first line\nsecond line")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { DUPLICATE_CONTACTS, OTHER_QUESTIONS, STALLED_QUOTE } from "./needs-you.fixtures.ts";
import { SAME_ASKER_SUBJECT, SAME_SUBJECT, subjectCorpus, subjectSimilarity, subjectWeights } from "./question-subjects.ts";

const ALL = [...DUPLICATE_CONTACTS, STALLED_QUOTE, ...OTHER_QUESTIONS];
const weights = new Map(ALL.map((question) => [question.key, subjectWeights(question.text, question.options)]));
const corpus = subjectCorpus([...weights.values()]);
const similarity = (a: string, b: string) => subjectSimilarity(weights.get(a)!, weights.get(b)!, corpus);

describe("question subjects", () => {
  it("reads one decision asked in different words as the same subject", () => {
    expect(similarity("contacts-a", "contacts-b")).toBeGreaterThanOrEqual(SAME_SUBJECT);
  });

  it("keeps a look-alike that is a different decision apart", () => {
    expect(similarity("contacts-a", "quote")).toBeLessThan(SAME_ASKER_SUBJECT);
    for (const other of OTHER_QUESTIONS) expect(similarity("contacts-a", other.key), other.key).toBeLessThan(SAME_ASKER_SUBJECT);
  });

  it("weighs an id, a name and a value above a topic word, and the options add topic words only", () => {
    expect(weights.get("contacts-a")).toMatchObject({ "id:5a1b2c3d": 3, "name:alice": 2, "name:moreno": 2 });
    expect(weights.get("quote")).toMatchObject({ "val:4000": 2.5, "id:5c0d71a9": 3 });
    expect(Object.keys(subjectWeights("Open the door?", ["Rename Zelda"]))).toEqual(expect.arrayContaining(["rename", "zelda"]));
    expect(Object.keys(subjectWeights("Open the door?", ["Rename Zelda"]))).not.toContain("name:zelda");
  });

  it("scores a question with nothing to compare as unrelated", () => {
    expect(subjectSimilarity({}, weights.get("quote")!, corpus)).toBe(0);
  });
});

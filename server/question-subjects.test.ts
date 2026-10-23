import { describe, expect, it } from "vitest";
import { FUNNEL_DUPLICATES, MEETING_QUESTIONS, OTHER_QUESTIONS, STALLED_PROPOSAL } from "./needs-you.fixtures.ts";
import { subjectCorpus, subjectSimilarity, subjectWeights } from "./question-subjects.ts";

const ALL = [...FUNNEL_DUPLICATES, ...STALLED_PROPOSAL, ...MEETING_QUESTIONS, ...OTHER_QUESTIONS];

describe("question subjects", () => {
  it("weighs and compares questions exactly as pergunta-registro does", () => {
    const weights = new Map(ALL.map((question) => [question.key, subjectWeights(question.text, question.options)]));
    const corpus = subjectCorpus([...weights.values()]);
    // Values from pergunta_registro.py (pesos, carregar_idf, similaridade) over the same questions.
    const python: Array<[string, string, number]> = [
      ["funil-a", "funil-b", 0.85], ["funil-a", "funil-c", 0.3168], ["funil-b", "funil-c", 0.5], ["proposta-a", "proposta-b", 0.7233],
      ["desconto", "desconto-pedido", 0.5], ["promessas", "promessas-pedido", 0.45], ["cadastro", "cadastro-pedido", 0.778],
      ["cadastro", "prazo", 0.2016], ["desconto", "promessas", 0.1275], ["funil-a", "proposta-a", 0],
    ];
    for (const [a, b, expected] of python) {
      expect(subjectSimilarity(weights.get(a)!, weights.get(b)!, corpus), `${a} / ${b}`).toBeCloseTo(expected, 4);
    }
    expect(Object.entries(weights.get("proposta-a")!).sort().slice(0, 12)).toEqual([
      ["cobranc", 1], ["contato", 1], ["deixar", 1], ["downsel", 1], ["entao", 1], ["enviado", 1], ["henriqu", 1], ["id:5c0d71a9", 3],
      ["julho", 1], ["mensage", 1], ["negocio", 1], ["nome:henrique", 2],
    ]);
  });

  it("ignores the pedir-natan footer and inbox provenance when weighing a question", () => {
    expect(subjectWeights("Mesclar os pares?\n\n— de Funil (Brunson), caixa_natan id 6 (x) · 14:18 · pedido c27da3f1"))
      .toEqual(subjectWeights("Mesclar os pares?"));
  });
});

// Which open questions to the person are the same subject. Entities a question
// names (an 8-hex id, a PR, a money value, a number, a proper name) weigh more
// than its topic words, and a word rare across every question weighs more than
// a common one.

export type SubjectWeights = Record<string, number>;

/** Two questions at least this alike are one subject. */
export const SAME_SUBJECT = 0.45;
/** Two questions from the same bot are one subject at this lower bar: a bot rewords its own question less than another bot would. */
export const SAME_ASKER_SUBJECT = 0.35;

/** Words that open or pad a question without saying what it is about. */
const STOP = new Set(`
that this with have from your what which when where will would should could about into than then them they their there
here also just only more most much very some such each other another please need needs want wants like make made
option options answer question recommend recommended recommendation context source decide decision confirm
para como esta este isso essa esse mais mas por uma uns umas dos das nos nas quando onde qual quais ainda sobre entre
depois antes sem tambem muito pouco hoje ontem amanha agora aqui voce voces preciso precisa decisao opcao resposta
pergunta recomendo recomendada recomendado confirma contexto fonte
`.split(/\s+/).filter(Boolean));

// Word boundaries that treat letters and digits of any script as word characters.
const START = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";
const HEX_ID = new RegExp(`${START}[0-9a-f]{8}${END}`, "gu");
const PR = new RegExp(`(?:PR|pull request)\\s*#?\\s*(\\d{2,5})|#(\\d{2,5})${END}`, "giu");
const MONEY = /(?:R\$|[$€£])\s?(\d[\d.,]*)/gu;
const NUMBER = new RegExp(`${START}(\\d{1,2}h\\d{0,2}|\\d{4,6})${END}`, "gu");
const PROPER_NAME = new RegExp(`(?<![.!?]\\s)(?<!^)${START}(\\p{Lu}\\p{Ll}{2,})${END}`, "gu");
const WORD = /\p{L}{4,}/gu;

function withoutAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function tokens(text: string): SubjectWeights {
  const t = Array.from(text).slice(0, 1800).join("");
  const out: SubjectWeights = {};
  const add = (key: string, weight: number) => { if (weight > (out[key] ?? 0)) out[key] = weight; };
  for (const [id] of t.matchAll(HEX_ID)) if (/\d/.test(id) && /[a-f]/.test(id)) add(`id:${id}`, 3);
  for (const match of t.matchAll(PR)) add(`pr:${match[1] ?? match[2]}`, 3);
  for (const match of t.matchAll(MONEY)) add(`val:${match[1].replace(/[.,]/gu, "")}`, 2.5);
  for (const match of t.matchAll(NUMBER)) add(`num:${match[1]}`, 2);
  for (const match of t.matchAll(PROPER_NAME)) {
    const word = withoutAccents(match[1].toLowerCase());
    if (!STOP.has(word)) add(`name:${word}`, 2);
  }
  for (const [raw] of t.toLowerCase().matchAll(WORD)) {
    const word = withoutAccents(raw);
    if (STOP.has(word)) continue;
    add(word.slice(0, 7), 1);
  }
  return out;
}

/** The question and its options; a name, id or value counts only in the question, the options add topic words. */
export function subjectWeights(question: string, options: readonly string[] = []): SubjectWeights {
  const out = tokens(question);
  for (const key of Object.keys(tokens(options.join(" ")))) {
    const word = key.slice(key.indexOf(":") + 1).slice(0, 7);
    if (!(word in out)) out[word] = 1;
  }
  return out;
}

export interface SubjectCorpus {
  idf: Map<string, number>;
  size: number;
}

export function subjectCorpus(all: readonly SubjectWeights[]): SubjectCorpus {
  const df = new Map<string, number>();
  for (const weights of all) for (const key of Object.keys(weights)) df.set(key, (df.get(key) ?? 0) + 1);
  const n = all.length;
  const idf = new Map<string, number>();
  for (const [key, d] of df) idf.set(key, Math.max(0.25, Math.log((n + 1) / (d + 0.5)) / 2));
  return { idf, size: n };
}

export function subjectSimilarity(a: SubjectWeights, b: SubjectWeights, corpus: SubjectCorpus): number {
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (!keysA.length || !keysB.length) return 0;
  const final = (weights: SubjectWeights) => new Map(Object.entries(weights).map(([key, weight]) => [key, weight * (corpus.idf.get(key) ?? 1)]));
  const fa = final(a), fb = final(b);
  const common = keysA.filter((key) => fb.has(key));
  const inter = common.reduce((sum, key) => sum + Math.min(fa.get(key)!, fb.get(key)!), 0);
  let union = 0;
  for (const key of new Set([...keysA, ...keysB])) union += Math.max(fa.get(key) ?? 0, fb.get(key) ?? 0);
  const total = (weights: Map<string, number>) => [...weights.values()].reduce((sum, value) => sum + value, 0);
  const smaller = Math.min(total(fa), total(fb));
  if (!union || !smaller) return 0;
  // A small corpus (a test, a new install) cannot yet tell a rare word from a common one.
  const floor = corpus.size >= 30 ? 1 : 0.2;
  if (common.filter((key) => fa.get(key)! >= floor && fb.get(key)! >= floor).length < 2) return 0;
  let base = 0.45 * inter / union + 0.55 * inter / smaller;
  const typed = common.filter((key) => ["id", "pr", "val", "name"].includes(key.split(":")[0]));
  if (typed.length >= 4) base = Math.max(base, Math.min(0.85, 0.3 + 0.05 * typed.length));
  return Math.min(1, base);
}

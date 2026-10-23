import type { VisibleSet } from "../bot-visibility.ts";
import { DISMISSED_PEDIDO_BY, DISMISSED_PEDIDO_LINE, hiddenKey, needsYouPage, type NeedsYouHidden, type NeedsYouSources } from "../needs-you.ts";
import type { PedirNatan } from "../pedir-natan.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface NeedsYouRouteDeps {
  sources: (auth: RequestAuth) => Omit<NeedsYouSources, "visible" | "answering" | "pedidos" | "hidden">;
  pedirNatan: PedirNatan;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  /** Closes a question card as already answered: no answer reaches the bot and no turn starts. */
  dismissCard: (auth: RequestAuth, threadId: string, requestId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Rows marked "already answered" that have no card, kept across restarts. */
  hidden: { all(): ReadonlyMap<string, NeedsYouHidden>; add(key: string, row: NeedsYouHidden): void };
  log?: (line: string) => void;
}

const MAX_ANSWER_CHARS = 4000;
const MAX_TARGETS = 200;

/**
 * GET /api/needs-you?since=<epoch ms>: open subjects, and those settled since `since` (the viewer's local midnight).
 * POST /api/needs-you/pedidos { ids, text }: answers pedir-natan requests that have no card yet; a card is answered
 * through /api/threads/:id/respond like any other.
 * POST /api/needs-you/dismiss { ids, cards, pedidos }: "already answered": closes the cards without an answer, resolves
 * the requests through `pedir-natan resolver`, and hides the other rows by their subject id.
 */
export function createNeedsYouRoutes(deps: NeedsYouRouteDeps): RouteHandler {
  const answering = new Set<string>();
  const pedidos = (auth: RequestAuth) => {
    if (!auth.scopes.includes("admin")) return [];
    try { return deps.pedirNatan.pedidos(); } catch (error) {
      deps.log?.(`[needs-you] pedir-natan unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };
  const page = (auth: RequestAuth, since: number) => {
    const visible = deps.visibleFor(auth);
    return needsYouPage({ ...deps.sources(auth), pedidos: pedidos(auth), answering, hidden: deps.hidden.all(), visible: (threadId) => visible.thread(threadId) }, since);
  };
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string").slice(0, MAX_TARGETS) : [];
  return async ({ res, path, method, url, auth, json, readBody, req }) => {
    if (path === "/api/needs-you") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const since = Number(url.searchParams.get("since") ?? Number.NaN);
      if (!Number.isFinite(since)) return json(res, 400, { error: "since must be a time in milliseconds" });
      return json(res, 200, page(auth, since));
    }
    if (path === "/api/needs-you/dismiss") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body = await readBody(req);
      const ids = new Set(strings(body?.ids));
      const cards = Array.isArray(body?.cards) ? (body.cards as unknown[]).flatMap((card) => {
        const { threadId, requestId } = (card ?? {}) as Record<string, unknown>;
        return typeof threadId === "string" && typeof requestId === "string" ? [{ threadId, requestId }] : [];
      }).slice(0, MAX_TARGETS) : [];
      const asked = new Set(strings(body?.pedidos));
      // The subject as the server sees it now: a copy that arrived since the page loaded is closed with the rest.
      const current = page(auth, 0).subjects.filter((subject) => ids.has(subject.id));
      for (const subject of current) {
        if (subject.kind === "question") {
          for (const card of subject.answer.cards) if (!cards.some((known) => known.threadId === card.threadId && known.requestId === card.requestId)) cards.push(card);
          for (const id of subject.answer.everyPedido) asked.add(id);
        } else {
          deps.hidden.add(hiddenKey(subject), { at: Date.now(), text: subject.kind === "setup" ? setupLine(subject.item) : [("title" in subject ? subject.title : ""), subject.text].filter(Boolean).join(" · "),
            askers: subject.askers, ...(subject.open ? { open: subject.open } : {}) });
        }
      }
      let dismissed = current.filter((subject) => subject.kind !== "question").length;
      const failed: Array<{ target: string; error: string }> = [];
      const visible = deps.visibleFor(auth);
      for (const card of cards) {
        if (!visible.thread(card.threadId)) { failed.push({ target: `${card.threadId}:${card.requestId}`, error: "not found" }); continue; }
        const result = await deps.dismissCard(auth, card.threadId, card.requestId);
        if (result.ok) dismissed += 1;
        else failed.push({ target: `${card.threadId}:${card.requestId}`, error: result.error });
      }
      if (asked.size) {
        if (!auth.scopes.includes("admin")) failed.push(...[...asked].map((id) => ({ target: `pedido:${id}`, error: "only an admin resolves pedir-natan requests" })));
        else {
          const open = new Set(pedidos(auth).filter((pedido) => pedido.open).map((pedido) => pedido.id));
          // `resolver` only writes the queue, so it is awaited: a request it could not resolve is reported, not silently back.
          await Promise.all([...asked].filter((id) => open.has(id) && !answering.has(id)).map(async (id) => {
            answering.add(id);
            try {
              await deps.pedirNatan.resolve(id, DISMISSED_PEDIDO_BY, DISMISSED_PEDIDO_LINE);
              dismissed += 1;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              deps.log?.(`[needs-you] pedir-natan resolver ${id} failed: ${message}`);
              failed.push({ target: `pedido:${id}`, error: message });
            } finally {
              answering.delete(id);
            }
          }));
        }
      }
      return json(res, failed.length && !dismissed ? 409 : 200, { dismissed, failed });
    }
    if (path !== "/api/needs-you/pedidos") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "only an admin answers pedir-natan requests" });
    const body = await readBody(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
    if (!text || text.length > MAX_ANSWER_CHARS) return json(res, 400, { error: `text must be 1 to ${MAX_ANSWER_CHARS} characters` });
    const open = new Set(pedidos(auth).filter((pedido) => pedido.open).map((pedido) => pedido.id));
    const unknown = ids.filter((id: string) => !open.has(id) || answering.has(id));
    if (!ids.length || unknown.length) return json(res, 409, { error: "these requests are not waiting on an answer", ids: unknown });
    for (const id of ids) {
      answering.add(id);
      deps.pedirNatan.answer(id, text)
        .catch((error) => deps.log?.(`[needs-you] pedir-natan responder ${id} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => answering.delete(id));
    }
    return json(res, 202, { accepted: ids });
  };
}

/** "Settled today" keeps a line for a hidden settings row; one with nothing to quote shows the row's kind. */
function setupLine(item: Extract<NeedsYouSources["others"][number], { kind: Exclude<NeedsYouSources["others"][number]["kind"], "question"> }>): string {
  return item.kind === "signed-out" ? item.instanceId : "text" in item ? item.text : "";
}

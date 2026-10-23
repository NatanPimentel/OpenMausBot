import type { VisibleSet } from "../bot-visibility.ts";
import { needsYouPage, type NeedsYouSources } from "../needs-you.ts";
import type { PedirNatan } from "../pedir-natan.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface NeedsYouRouteDeps {
  sources: (auth: RequestAuth) => Omit<NeedsYouSources, "visible" | "answering" | "pedidos">;
  pedirNatan: PedirNatan;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  log?: (line: string) => void;
}

const MAX_ANSWER_CHARS = 4000;

/**
 * GET /api/needs-you?since=<epoch ms>: open subjects, and those settled since `since` (the viewer's local midnight).
 * POST /api/needs-you/pedidos { ids, text }: answers pedir-natan requests that have no card yet; a card is answered
 * through /api/threads/:id/respond like any other.
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
  return async ({ res, path, method, url, auth, json, readBody, req }) => {
    if (path === "/api/needs-you") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const since = Number(url.searchParams.get("since") ?? Number.NaN);
      if (!Number.isFinite(since)) return json(res, 400, { error: "since must be a time in milliseconds" });
      const visible = deps.visibleFor(auth);
      return json(res, 200, needsYouPage({ ...deps.sources(auth), pedidos: pedidos(auth), answering, visible: (threadId) => visible.thread(threadId) }, since));
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

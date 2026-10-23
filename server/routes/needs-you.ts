import { needsYouPage, type NeedsYouCardRow } from "../needs-you.ts";
import { needsYouNow } from "../today.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { todayViewer, type TodayRouteDeps } from "./today.ts";

export interface NeedsYouRouteDeps {
  /** The same sources and visibility as Today: what is parked, signed out or disconnected comes from there. */
  today: TodayRouteDeps;
  store: { bots: ReadonlyArray<{ id: string; name: string }>; botByThread(threadId: string): { id: string } | undefined };
  cards: () => NeedsYouCardRow[];
}

/**
 * GET /api/needs-you?since=<epoch ms>: open subjects, and those settled since `since` (the viewer's local midnight).
 * Without `since` the same path is Today's list of what needs this person now (routes/today.ts).
 * A subject's cards are answered through /api/threads/:id/respond like any other.
 */
export function createNeedsYouRoutes(deps: NeedsYouRouteDeps): RouteHandler {
  return async ({ res, path, method, url, auth, json }) => {
    if (path !== "/api/needs-you" || !url.searchParams.has("since")) return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const since = Number(url.searchParams.get("since"));
    if (!Number.isFinite(since)) return json(res, 400, { error: "since must be a time in milliseconds" });
    const viewer = todayViewer(deps.today, auth);
    return json(res, 200, needsYouPage({
      cards: deps.cards(), bots: deps.store.bots.map((bot) => ({ id: bot.id, name: bot.name })), visible: viewer.thread,
      ownerOf: (threadId) => deps.store.botByThread(threadId)?.id, others: needsYouNow(deps.today.sources(), viewer, deps.today.now?.() ?? Date.now()),
    }, since));
  };
}

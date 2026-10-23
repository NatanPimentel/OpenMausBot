import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { EMOJI_FONT, NEEDS_YOU_EMOJI, useNeedsYou } from "@/lib/needs-you";
import { useStore } from "@/state/store";

/** Pinned above the teams: the one place that lists everything waiting on the person. */
export function NeedsYouNavItem({ iconsOnly, rail = false }: { iconsOnly: boolean; rail?: boolean }) {
  const { state, dispatch } = useStore();
  const count = useNeedsYou(state.connected).page?.count ?? 0;
  const active = state.activeView === "needs-you";
  const label = t("needsYou.navAria", { count });
  return <button
    type="button"
    data-sidebar-nav="needs-you"
    onClick={() => dispatch({ type: "showNeedsYou" })}
    aria-label={label}
    title={iconsOnly ? label : undefined}
    aria-current={active ? "page" : undefined}
    className={cn(
      "relative flex items-center rounded-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      rail ? "mx-auto size-9 shrink-0 justify-center" : iconsOnly ? "mx-auto size-[46px] shrink-0 justify-center" : "w-full min-h-9 gap-3 px-3 py-1.5 text-left",
      active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
    )}
  >
    <span aria-hidden="true" className={cn("leading-none", iconsOnly && !rail ? "text-[20px]" : "text-[17px]")} style={EMOJI_FONT}>{NEEDS_YOU_EMOJI}</span>
    {!iconsOnly && <span className="flex-1 truncate text-[14px] font-medium leading-5">{t("needsYou.title")}</span>}
    {count > 0 && <span
      aria-hidden="true"
      data-needs-you-count=""
      className={cn(
        "flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11.5px] font-semibold leading-5 tabular-nums text-accent-ink",
        iconsOnly && "absolute -right-0.5 -top-0.5 min-w-4 px-1 text-[9.5px] leading-4",
      )}
    >{count > 99 ? "99+" : count}</span>}
  </button>;
}

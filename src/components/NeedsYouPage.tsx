import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight } from "lucide-react";
import type { NeedsYouAsker, NeedsYouSettled, NeedsYouSubject } from "../../shared/needs-you";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { answerSubject, dismissSubject, EMOJI_FONT, NEEDS_YOU_EMOJI, undoDismiss, useNeedsYou, type QuestionSubject } from "@/lib/needs-you";
import { openNotificationTarget, useStore } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON } from "./AskCard";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ExpandableText } from "./ExpandableText";

const RECOMMENDED_MARK = /\s*\((?:recomendad[oa]|recommended)[^)]*\)\s*$/iu;
const STATUS_MS = 6000;
/** pedir-natan's `resolver` line already says who resolved it: "resolvido por <bot>: <como>". */
const BOT_LINE = /^resolvid[oa] por/iu;

type OpenTarget = { botId?: string; threadId: string };
/** "Already answered": quieter than Answer, and it never sends the bot anything. */
const DISMISS_BUTTON = `${ASK_CHIP} ${ASK_CHIP_IDLE} text-ink-secondary hover:text-ink`;

export function NeedsYouPage() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { dragProps } = useCaptionChrome();
  const { page, failed } = useNeedsYou(state.connected);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<string | null>(null);
  const dismiss = (subject: NeedsYouSubject) => {
    setUndoable(subject.id);
    void dismissSubject(subject).then((outcome) => {
      setUndoable((current) => current === subject.id ? null : current);
      if (outcome === "failed") setProblem(t("needsYou.dismissFailed"));
    });
  };
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    if (!problem) return;
    const timer = window.setTimeout(() => setProblem(null), STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [problem]);
  const open = (target: OpenTarget) => {
    const botId = target.botId ?? state.bots.find((bot) => bot.threadId === target.threadId || bot.tasks?.some((task) => task.threadId === target.threadId))?.id;
    if (botId || state.groups.some((group) => group.threadId === target.threadId)) openNotificationTarget(dispatch, { botId: botId ?? "", threadId: target.threadId }, state, showThreads);
  };

  return <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
    <header {...dragProps} className="flex shrink-0 items-center gap-2.5 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
      <span aria-hidden="true" className="text-[18px] leading-none" style={EMOJI_FONT}>{NEEDS_YOU_EMOJI}</span>
      <h1 className="text-[17px] font-semibold">{t("needsYou.title")}</h1>
      {page && page.count > 0 && <span className="rounded-full bg-accent px-2 text-[12px] font-semibold leading-5 tabular-nums text-accent-ink">{page.count}</span>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-4 pb-16 pt-5 md:px-6">
        {page && page.count > 0 && <p className="text-[13px] leading-relaxed text-ink-secondary">{t("needsYou.intro")}</p>}
        <p role="status" aria-live="polite" className={cn("text-[13px] text-success", !status && "sr-only")}>{status}</p>
        {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
        {!page && !failed && <Skeleton />}
        {!page && failed && <p role="alert" className="text-[13px] text-ink-secondary">{t("needsYou.loadFailed")}</p>}
        {page && page.count === 0 && <Empty />}
        {page?.subjects.map((subject) => subject.kind === "question"
          ? <QuestionRow key={subject.id} subject={subject} onOpen={open} onSent={setStatus} onDismiss={dismiss} />
          : <CompactRow key={subject.id} subject={subject} onOpen={open} onDismiss={dismiss} />)}
        {page && page.settled.length > 0 && <Settled rows={page.settled} onOpen={open} />}
      </div>
    </div>
    {undoable && <UndoToast onUndo={() => { undoDismiss(undoable); setUndoable(null); }} />}
  </main>;
}

function UndoToast({ onUndo }: { onUndo: () => void }) {
  const undo = useRef<HTMLButtonElement>(null);
  // The row that held focus is gone: Undo is where a keyboard user can act next.
  useEffect(() => { undo.current?.focus({ preventScroll: true }); }, []);
  return <div role="status" aria-live="polite"
    className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4 motion-safe:animate-[msg-in_160ms_ease-out]">
    <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-composer py-1 pe-1 ps-4 text-[13px] text-ink shadow-lg ring-1 ring-composer-ring">
      <Check size={14} aria-hidden="true" className="me-1 shrink-0 text-success/80" />
      <span>{t("needsYou.dismissedToast")}</span>
      <button ref={undo} type="button" onClick={onUndo} className={cn(ASK_QUIET_BUTTON, "my-0 ms-1 font-semibold text-accent-text hover:text-accent-text")}>
        {t("needsYou.undo")}
      </button>
    </div>
  </div>;
}

function QuestionRow({ subject, onOpen, onSent, onDismiss }: { subject: QuestionSubject; onOpen: (target: OpenTarget) => void; onSent: (line: string) => void; onDismiss: (subject: NeedsYouSubject) => void }) {
  const [picked, setPicked] = useState(0);
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<number | null>(null);
  const reach = subject.answer.cards.length + subject.answer.pedidos.length;
  const answer = custom.trim() || subject.options[picked] || "";
  const send = async () => {
    if (!answer || sending) return;
    setSending(true);
    setFailed(null);
    const result = await answerSubject(subject, answer);
    setSending(false);
    if (result.failed) setFailed(result.failed);
    else onSent(reach > 1 ? t("needsYou.sent", { count: reach }) : t("needsYou.sentOne"));
  };
  const radioName = useId();

  return <article aria-label={subject.text.slice(0, 80)} className="rounded-3xl bg-composer px-4 pb-3.5 pt-3 ring-1 ring-composer-ring">
    <RowHead askers={subject.askers} since={subject.since} open={subject.open} onOpen={onOpen} />
    <ExpandableText text={subject.text} className="mt-2 text-[14.5px] leading-relaxed text-ink [unicode-bidi:plaintext]" />
    {subject.options.length > 0 && <div role="radiogroup" aria-label={t("needsYou.answer")} className="mt-3 divide-y divide-ink/[0.12] overflow-hidden rounded-2xl border border-ink/[0.12]">
      {subject.options.map((option, index) => {
        const chosen = !custom.trim() && picked === index;
        return <label key={`${index}-${option}`} className={cn(
          "flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-start transition-colors focus-within:bg-ink/[0.06]",
          chosen ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]",
        )}>
          <input type="radio" name={radioName} checked={chosen} onChange={() => { setPicked(index); setCustom(""); }} className="peer sr-only" />
          <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
            chosen ? "border-accent bg-accent" : "border-ink/30")}>
            {chosen && <span className="size-1.5 rounded-full bg-accent-ink" />}
          </span>
          <span className="min-w-0 flex-1 break-words text-[14.5px] leading-6 text-ink [unicode-bidi:plaintext]">{option.replace(RECOMMENDED_MARK, "")}</span>
          {index === 0 && <span className="shrink-0 text-[11.5px] font-medium text-accent-text">{t("needsYou.recommended")}</span>}
        </label>;
      })}
    </div>}
    <textarea
      dir="auto"
      rows={1}
      value={custom}
      maxLength={4000}
      aria-label={t("needsYou.other")}
      placeholder={t("needsYou.other")}
      onChange={(event) => setCustom(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void send();
      }}
      className="mt-2.5 block max-h-40 min-h-11 w-full resize-none rounded-xl border border-ink/[0.12] bg-inset px-3 py-2.5 text-[14.5px] leading-6 text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70 [field-sizing:content]"
    />
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {failed !== null && <span role="alert" className="me-auto text-[12.5px] text-danger">{t("needsYou.failed", { count: failed })}</span>}
      <button type="button" disabled={sending} onClick={() => onDismiss(subject)} title={t("needsYou.dismissHint")} className={DISMISS_BUTTON}>
        {t("needsYou.dismiss")}
      </button>
      <button type="button" disabled={!answer || sending} onClick={() => void send()} className={ASK_PRIMARY_BUTTON}>
        {sending ? t("needsYou.answering") : reach > 1 ? t("needsYou.answerAll", { count: reach }) : t("needsYou.answer")}
      </button>
    </div>
  </article>;
}

function CompactRow({ subject, onOpen, onDismiss }: { subject: Exclude<NeedsYouSubject, { kind: "question" }>; onOpen: (target: OpenTarget) => void; onDismiss: (subject: NeedsYouSubject) => void }) {
  const { title, text } = compactCopy(subject);
  return <article className="rounded-2xl bg-card px-4 py-3">
    <RowHead askers={subject.askers} since={subject.since} open={subject.open} onOpen={onOpen}
      kind={t(subject.kind === "approval" ? "needsYou.kind.approval" : subject.kind === "waiting" ? "needsYou.kind.waiting" : "needsYou.kind.setup")} />
    {title && <p className="mt-1.5 break-words text-[14px] font-medium leading-snug text-ink">{title}</p>}
    {text && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-secondary">{text}</p>}
    {/* A settings problem leaves on its own once fixed; hiding it would only hide that it is still broken. */}
    {subject.kind !== "setup" && <div className="mt-2.5 flex justify-end">
      <button type="button" onClick={() => onDismiss(subject)} title={t("needsYou.dismissHint")} className={DISMISS_BUTTON}>{t("needsYou.dismiss")}</button>
    </div>}
  </article>;
}

function compactCopy(subject: Exclude<NeedsYouSubject, { kind: "question" }>): { title: string; text: string } {
  if (subject.kind !== "setup") return { title: subject.kind === "approval" ? subject.title : "", text: subject.text };
  const item = subject.item;
  switch (item.kind) {
    case "signed-out": return { title: t("needsYou.setup.signedOut"), text: item.instanceId };
    case "usage-limit": return { title: t("needsYou.setup.usageLimit"), text: item.text };
    case "out-of-credit": return { title: t("needsYou.setup.outOfCredit"), text: "" };
    case "connection": return { title: t("needsYou.setup.connection", { app: item.app }), text: item.text };
    case "place": return { title: t("needsYou.setup.place"), text: "" };
  }
}

function RowHead({ askers, since, open, onOpen, kind }: { askers: NeedsYouAsker[]; since: number; open?: OpenTarget; onOpen: (target: OpenTarget) => void; kind?: string }) {
  return <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
    <span className="min-w-0 truncate">
      {kind && <span className="text-ink-secondary">{kind} · </span>}
      <span className="font-semibold text-ink">{names(askers)}</span>
      <span className="text-ink-tertiary"> · <time dateTime={new Date(since).toISOString()} title={new Date(since).toLocaleString(activeLocale())}>
        {t("needsYou.since", { when: when(since) })}</time> · {ago(since)}</span>
    </span>
    {open && <button type="button" onClick={() => onOpen(open)} className={cn(ASK_QUIET_BUTTON, "ms-auto -me-2 text-ink-secondary")}>
      {t("needsYou.open")}<ArrowUpRight size={14} aria-hidden="true" />
    </button>}
  </div>;
}

function Settled({ rows, onOpen }: { rows: NeedsYouSettled[]; onOpen: (target: OpenTarget) => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <section className="mt-4 border-t border-hairline/40 pt-3">
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}
      className="-mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-ink-secondary hover:bg-ink/[0.05] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      <ChevronRight size={15} aria-hidden="true" className={cn("transition-transform duration-150", expanded && "rotate-90")} />
      {t("needsYou.settled")}
      <span className="tabular-nums text-ink-tertiary">{rows.length}</span>
    </button>
    {expanded && <ul id={id} className="mt-1.5 flex flex-col">
      {rows.map((row) => <li key={row.id} className="flex items-start gap-2.5 border-b border-hairline/30 py-2.5 last:border-b-0">
        <Check size={14} aria-hidden="true" className={cn("mt-[3px] shrink-0", row.via === "dismissed" ? "text-ink-tertiary" : "text-success/80")} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-ink">{row.text.split("\n")[0] || t("needsYou.kind.setup")}</p>
          <p className="mt-0.5 break-words text-[13px] leading-snug text-ink-secondary">
            {row.via ? t(row.via === "dismissed" ? "needsYou.viaDismissed" : "needsYou.viaConversation")
            : row.resolvedByBot && BOT_LINE.test(row.how)
              ? row.how.replace(BOT_LINE, (word) => word[0]!.toUpperCase() + word.slice(1))
              : <><span className="text-ink-tertiary">{t(row.resolvedByBot ? "needsYou.byBot" : "needsYou.byYou")}: </span>{row.how}</>}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-tertiary">{names(row.askers)} · {clock(row.at)}</p>
        </div>
        {row.open && <button type="button" onClick={() => onOpen(row.open!)} aria-label={t("needsYou.open")} title={t("needsYou.open")}
          className="ui-icon-button shrink-0 hover:bg-control hover:text-ink"><ArrowUpRight size={15} /></button>}
      </li>)}
    </ul>}
  </section>;
}

function Empty() {
  return <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
    <span aria-hidden="true" className="text-[34px] leading-none" style={EMOJI_FONT}>🌤️</span>
    <h2 className="mt-2 text-[15px] font-medium text-ink">{t("needsYou.empty.title")}</h2>
    <p className="max-w-[46ch] text-[13px] leading-relaxed text-ink-secondary">{t("needsYou.empty.body")}</p>
  </div>;
}

function Skeleton() {
  return <div aria-hidden="true" className="flex flex-col gap-3">
    {[0, 1, 2].map((index) => <div key={index} className="h-40 animate-pulse rounded-3xl bg-composer/60" />)}
  </div>;
}

function names(askers: readonly NeedsYouAsker[]): string {
  return new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(askers.map((asker) => asker.name));
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
}

function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clock(at);
  return date.toLocaleString(activeLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  const format = new Intl.RelativeTimeFormat(activeLocale(), { numeric: "auto", style: "short" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 48 * 60) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / 1440), "day");
}

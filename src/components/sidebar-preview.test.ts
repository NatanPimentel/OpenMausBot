import { describe, expect, it } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { botPreview, groupPreview, lastLine, lastPreviewable, waitingPreview } from "./sidebar-preview";
import { t } from "@/lib/i18n";

let at = 0;
const message = (fields: Partial<Message>): Message => ({ id: `m${++at}`, at, role: "bot", kind: "text", ...fields }) as Message;
const screen = () => message({ kind: "screen", png: "frame", mime: "image/jpeg" });
const bot = { id: "ada", name: "Ada", messages: [], busy: false } as unknown as Bot;

describe("sidebar previews", () => {
  it("shows a bot's reply, not the screen frame its computer turn ended with", () => {
    const visible = [message({ role: "user", text: "Paint a sunset" }), message({ text: "I painted a sunset in JS Paint." }), screen()];
    expect(botPreview(bot, visible, [], false)).toBe("I painted a sunset in JS Paint.");
    expect(botPreview(bot, [...visible, message({ kind: "digest", text: "[digest]" }), screen()], [], false)).toBe("I painted a sunset in JS Paint.");
  });

  it("shows nothing for a conversation that holds only screen frames", () => {
    expect(botPreview(bot, [screen(), screen()], [], false)).toBe("");
    expect(lastPreviewable([screen(), message({ kind: "compaction" })])).toBeUndefined();
  });

  const step = (name: string) => message({ kind: "activity", tool: { name, ok: true } } as Partial<Message>);

  it("quotes the bot in Simple mode when its newest line is a step that went fine, and keeps the step in Advanced", () => {
    const visible = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "Archived 31 newsletters." }), step("Bash")];
    expect(botPreview(bot, visible, [], false)).toBe("Archived 31 newsletters.");
    expect(botPreview(bot, visible, [], true)).toBe("Bash");
    expect(botPreview(bot, [message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [], false)).not.toBe("Tidy my inbox");
    expect(botPreview(bot, [message({ text: "Earlier reply" }), message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [], false)).not.toBe("Earlier reply");
  });

  it("keeps a failed step's error line and a recovery or notice line as they are", () => {
    const failed = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), message({ kind: "activity", tool: { name: "error: Gmail is not connected", ok: false } } as Partial<Message>)];
    expect(botPreview(bot, failed, [], false)).toContain("Gmail is not connected");
    const notice = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), step("notice: Switched to a backup model")];
    expect(botPreview(bot, notice, [], false)).toBe("Switched to a backup model");
  });

  it("says a helper's intro card by its first line in the reader's language instead of its stored English title", () => {
    const intro = message({ kind: "options", helperIntro: true, card: { title: "Hi! I'm Ada, your Chief of Staff.", options: [] } } as unknown as Partial<Message>);
    expect(botPreview({ ...bot, chiefOfStaff: true } as Bot, [intro], [], false)).toBe("Hey! I'm Ada. I'm new here.");
    expect(botPreview(bot, [intro], [], false)).toBe("Hi! I'm Ada, your helper for everything here.");
    expect(botPreview({ ...bot, chiefOfStaff: true } as Bot, [intro], [], true), "Advanced mode's one-bubble intro").toBe("Hi, I'm Ada, your helper for everything here.");
  });

  it("quotes the bot in a Simple group chat too", () => {
    const from = { botId: "ada", name: "Ada", color: "green" } as Message["from"];
    const group = { id: "g", name: "Room", messages: [message({ role: "user", text: "Plan the launch" }), message({ text: "Here is the plan.", from }), message({ kind: "activity", tool: { name: "Read", ok: true }, from } as Partial<Message>)] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Here is the plan.");
    expect(groupPreview(group, [bot], [], true)).toBe("Ada: Read");
  });

  it("skips screen frames in a group chat's preview too", () => {
    const group = { id: "g", name: "Room", messages: [message({ text: "Done.", from: { botId: "ada", name: "Ada", color: "green" } }), screen()] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Done.");
  });
});

// Local mod (Imobiturbo, 29/10/2026): a question for the person reads as the question wherever the conversation is summed up.
describe("a bot's question in the preview", () => {
  const asks = (fields: Record<string, unknown> = {}) => message({ kind: "options", card: { title: "Your bot has a question", subtitle: "Natan, você libera o PR #1810 do OS?", options: [], requestId: "q1", requestType: "question", ...fields } } as unknown as Partial<Message>);

  it("shows the question a card asks, not \"Your bot has a question\"", () => {
    const visible = [message({ role: "user", text: "Fecha o #1810" }), asks()];
    expect(botPreview(bot, visible, [], false)).toBe("Natan, você libera o PR #1810 do OS?");
    expect(botPreview(bot, visible, [], true)).toBe("Natan, você libera o PR #1810 do OS?");
    expect(lastLine(bot, visible, [], false)).not.toContain("Your bot has a question");
  });

  it("shows what a waiting bot asks, and only says it waits when there is no open question to show", () => {
    const waiting = { ...bot, activity: "waiting-on-you" } as Bot;
    expect(botPreview(waiting, [asks()], [], false)).toBe("Natan, você libera o PR #1810 do OS?");
    expect(waitingPreview([asks()])).toBe("Natan, você libera o PR #1810 do OS?");
    expect(waitingPreview([asks({ answered: "Sim" })])).toBe(t("sidebar.preview.waiting"));
    expect(waitingPreview([])).toBe(t("sidebar.preview.waiting"));
  });

  it("shows the question a reply ends with on a NEEDS INPUT line, not the start of the reply", () => {
    const reply = message({ text: "1. Causa: as 140 chaves de IA copiadas nas orgs.\n2. Feito na VPS4.\n\nNEEDS INPUT: Natan, você libera o PR #1810 do OS?" });
    expect(botPreview(bot, [message({ role: "user", text: "Status?" }), reply], [], false)).toBe("Natan, você libera o PR #1810 do OS?");
    expect(botPreview(bot, [message({ text: "Feito.\nNEEDS INPUT: nenhum." })], [], false)).toMatch(/^Feito\./);
  });
});

import { t } from "@/lib/i18n";
import { widgetFieldOptions, type WidgetField, type WidgetSettled } from "../../../shared/widget";
import { widgetDaysCaption } from "./WidgetDayPicker";
import { widgetTimeLabel } from "./WidgetTimePicker";

function fieldAnswer(field: WidgetField, settled: WidgetSettled): string {
  const own = settled.other?.[field.name]?.trim();
  if (own) return own;
  const value = settled.values?.[field.name];
  if (field.type === "Checkbox") return value === true ? field.label : "";
  if (typeof value !== "string" || !value.trim()) return "";
  if (field.type === "Select" || field.type === "RadioGroup" || field.type === "ListView") {
    return widgetFieldOptions(field.node).find((option) => option.value === value)?.label ?? value;
  }
  if (field.type === "DayPicker") return widgetDaysCaption(value);
  if (field.type === "TimePicker") return widgetTimeLabel(value);
  if (field.type === "DatePicker") {
    const [year, month, day] = value.split("-").map(Number);
    return year && month && day ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(year, month - 1, day)) : value;
  }
  return value.replace(/\s+/g, " ").trim();
}

/** What the person sent, one part per filled field in the order the card draws them, after the pressed button's label
 * when it is `named` or no field went with it. */
export function widgetAnswerSummary(fields: Iterable<WidgetField>, settled: WidgetSettled, named = false): string[] {
  const parts = [...fields].map((field) => fieldAnswer(field, settled)).filter(Boolean);
  return named || !parts.length ? [settled.label, ...parts] : parts;
}

export function widgetAnsweredAt(at: number, now = Date.now()): string {
  const when = new Date(at);
  if (when.toDateString() === new Date(now).toDateString()) {
    return t("widget.answeredAt", { time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when) });
  }
  const year = when.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  return t("widget.answeredOn", { date: new Intl.DateTimeFormat(undefined, { ...year, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(when) });
}

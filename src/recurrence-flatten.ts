import { createHash } from "node:crypto";
import { calendarLocalDay, sameSafeYearlyRecurrenceRule } from "./recurrence-split.js";
import { hasCanonicalState, toTodoistTask } from "./sync.js";
import type { CalendarEvent, Profile, TodoistTask } from "./types.js";

export interface RecurrenceFlattenPlan {
  masterId: string; occurrenceId: string; taskId: string; standaloneId: string;
  originalRule: string; cappedRule?: string; start: string; end: string;
  mode: "cap-history" | "flatten-master"; timeZone: string;
}
export const flattenStandaloneId = (profile:Profile,taskId:string,masterId:string,occurrenceId:string) => createHash("sha256").update(`flatten-v1:${profile}:${taskId}:${masterId}:${occurrenceId}`).digest("hex").slice(0,32);
const stamp = (date: string) => {
  const n = Date.parse(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(n) || new Date(n).toISOString().slice(0,10) !== date) throw new Error("Flatten requires valid all-day dates");
  return n;
};
export function planRecurrenceFlatten(profile: Profile, task: TodoistTask, master: CalendarEvent, occurrence: CalendarEvent, timeZone: string, now = new Date()): RecurrenceFlattenPlan {
  if (task.is_deleted || task.is_completed || !task.due?.date || task.due.datetime || task.due.date.includes("T")) throw new Error("Flatten requires an active all-day Todoist task");
  if (master.status !== "confirmed" || !master.etag || master.recurringEventId || master.recurrence?.length !== 1 || master.extendedProperties?.shared?.syncHistoryOnly === "true") throw new Error("Flatten requires a confirmed live recurring master with an ETag");
  const rule = master.recurrence[0];
  if (!sameSafeYearlyRecurrenceRule(rule, rule) || /UNTIL=/.test(rule)) throw new Error("Flatten supports plain YEARLY rules with optional INTERVAL only; exceptions, COUNT and UNTIL require separate review");
  if (!master.start?.date || master.start.dateTime || !master.end?.date || master.end.dateTime || !occurrence.start?.date || occurrence.start.dateTime || !occurrence.end?.date || occurrence.end.dateTime) throw new Error("Flatten supports all-day Calendar occurrences only");
  if (!occurrence.id || !occurrence.etag || occurrence.status !== "confirmed" || occurrence.recurringEventId !== master.id || occurrence.originalStartTime?.date !== occurrence.start.date) throw new Error("Select the exact confirmed, unmodified Calendar occurrence to retain");
  const start = occurrence.start.date, end = occurrence.end.date;
  const duration = stamp(master.end.date) - stamp(master.start.date);
  if (duration <= 0 || stamp(end) - stamp(start) !== duration) throw new Error("Occurrence duration differs from the master");
  const interval = Number(/INTERVAL=(\d+)/.exec(rule)?.[1] || 1);
  const years = Number(start.slice(0,4)) - Number(master.start.date.slice(0,4));
  if (start.slice(4) !== master.start.date.slice(4) || years < 0 || years % interval !== 0 || start.slice(5) === "02-29") throw new Error("The selected occurrence is not an unambiguous generated yearly occurrence");
  const today = calendarLocalDay(now,timeZone);
  if (stamp(start) < stamp(today)) throw new Error("The retained occurrence must be current or future");
  const anchorYear = Number(master.start.date.slice(0,4));
  let nextYear = anchorYear + Math.max(0,Math.ceil((Number(today.slice(0,4))-anchorYear)/interval))*interval;
  let next = String(nextYear).padStart(4,"0") + master.start.date.slice(4);
  if (stamp(next) < stamp(today)) { nextYear += interval; next = String(nextYear).padStart(4,"0") + master.start.date.slice(4); }
  if (start !== next) throw new Error("Select the next active yearly occurrence; flatten cannot retain intermediate future recurrence dates");
  const oneOff = {...task,due:{date:task.due.date}};
  if (!hasCanonicalState(occurrence,oneOff)) throw new Error("Flatten requires matching task/occurrence fields and due date; align this exact pair before flattening");
  const mode = start === master.start.date ? "flatten-master" : "cap-history";
  const standaloneId = mode === "flatten-master" ? master.id : flattenStandaloneId(profile,task.id,master.id,occurrence.id);
  const cutoff = new Date(stamp(start) - 86400000).toISOString().slice(0,10).replace(/-/g,"");
  return {masterId:master.id,occurrenceId:occurrence.id,taskId:task.id,standaloneId,originalRule:rule,start,end,mode,timeZone,...(mode === "cap-history" ? {cappedRule:rule+`;UNTIL=${cutoff}`} : {})};
}
export function flattenStandalone(plan: RecurrenceFlattenPlan, occurrence: CalendarEvent): CalendarEvent {
  return {id:plan.standaloneId,summary:occurrence.summary,description:occurrence.description || "",start:{date:plan.start},end:{date:plan.end},
    extendedProperties:{shared:{taskId:plan.taskId,syncSource:"todoist-calendar-sync",syncFlattenMasterId:plan.masterId,syncFlattenOccurrenceId:plan.occurrenceId}}};
}
export function assertFlattenedMaster(plan: RecurrenceFlattenPlan, master: CalendarEvent): void {
  if (master.status !== "confirmed" || master.id !== plan.masterId) throw new Error("Flattened Calendar master disappeared or was cancelled");
  if (plan.mode === "cap-history") {
    const shared = master.extendedProperties?.shared;
    if (master.recurrence?.length !== 1 || !sameSafeYearlyRecurrenceRule(master.recurrence[0],plan.cappedRule)
      || shared?.syncHistoryOnly !== "true" || shared.syncHistorySuccessorId !== plan.standaloneId || shared.taskId) throw new Error("Flattened history cap or lineage changed");
  } else if (master.recurrence?.length || master.recurringEventId || master.start?.date !== plan.start || master.end?.date !== plan.end || master.extendedProperties?.shared?.taskId !== plan.taskId) throw new Error("Flattened standalone master changed");
}
export function assertFlattenInstances(master: CalendarEvent, instances: CalendarEvent[]): void {
  if (!instances.length) throw new Error("Cannot flatten a series without verified instances");
  for (const item of instances) {
    if (item.status !== "confirmed" || item.recurringEventId !== master.id || !item.originalStartTime?.date || item.originalStartTime.date !== item.start?.date
      || item.summary !== master.summary || (item.description || "") !== (master.description || "")
      || stamp(item.end?.date || "") - stamp(item.start?.date || "") !== stamp(master.end?.date || "") - stamp(master.start?.date || "")) throw new Error("Recurring exception requires a separate explicit disposition before flattening");
  }
}

export function flattenMasterProjection(plan:RecurrenceFlattenPlan, master:CalendarEvent, occurrence:CalendarEvent): CalendarEvent {
  const shared = {...master.extendedProperties?.shared};
  for (const name of Object.keys(shared)) if (["taskId","taskUrl","originalSummary","syncSource","syncRecurrenceOwner"].includes(name) || name.startsWith("todoist")) delete shared[name];
  if (plan.mode === "flatten-master") {
    const standalone = flattenStandalone(plan,occurrence);
    return {...master,...standalone,id:master.id,recurrence:[],extendedProperties:{...master.extendedProperties,shared:{...shared,...standalone.extendedProperties?.shared}}};
  }
  Object.assign(shared,{syncHistoryOnly:"true",syncHistoryTaskId:plan.taskId,syncHistorySuccessorId:plan.standaloneId,syncHistoryOriginalRule:plan.originalRule});
  return {...master,recurrence:[plan.cappedRule!],extendedProperties:{...master.extendedProperties,shared}};
}

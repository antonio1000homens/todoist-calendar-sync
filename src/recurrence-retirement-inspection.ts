/**
 * #351 – conservative, operator-scoped inspection of a recurrence diagnostic.
 *
 * This module is intentionally READ ONLY. A diagnostic is an observation, not
 * permission to erase a mapping. Do not expose an apply endpoint until the
 * durable exclusion, write-fence, idempotency and undo protocols are complete.
 */
import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { StateRepository, type ReconciliationDiagnostic } from "./repository.js";
import { ReviewStore, reviewHash } from "./review-store.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { terminalCompletionDecision, type VerifiedTerminalSeries } from "./completed-history-policy.js";
import type { CalendarEvent, CompletedCalendarProjection, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";

export type RetirementDiagnosticTarget = {
  profile: Profile; generation: string; taskId: string; eventId: string; seriesId: string;
};

export type CompletedTodoistEvidence = TodoistTask & { completed_at: string; is_deleted?: boolean };

export type RecurrenceRetirementInspection = {
  target: RetirementDiagnosticTarget;
  checkedAt: string;
  diagnostic: ReconciliationDiagnostic;
  task: { status: "active" | "completed_verified" | "unverified"; value?: TodoistTask | CompletedTodoistEvidence; source: string };
  calendar: { master?: CalendarEvent; occurrence?: CalendarEvent; instances: CalendarEvent[]; source: string };
  mapping?: Mapping;
  recurrenceLink?: RecurrenceLink;
  completionHistory: CompletedCalendarProjection[];
  terminalSeries?: VerifiedTerminalSeries;
  indexKeys: string[];
  historicalRowCounts: Record<string, number>;
  otherProfileReferences: Array<{ profile: string; key: string }>;
  blockers: string[];
  eligibleForFutureApproval: boolean;
  previewFingerprint: string;
  providerWrites: false;
};

type InventoryRow = Record<string, unknown> & {pk?: string; sk?: string};

const PROFILES: Profile[] = ["home", "antonio", "work"];
const idPattern = /^[A-Za-z0-9@_.:-]{1,1024}$/;
const diagPattern = /^[A-Za-z0-9._-]{1,200}$/;
function reject(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}
function isoTime(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}
function exactSameMapping(a?: Mapping, b?: Mapping): boolean {
  return !!a && !!b && a.profile === b.profile && a.taskId === b.taskId
    && a.eventId === b.eventId && a.seriesId === b.seriesId
    && a.recurrenceOwner === b.recurrenceOwner && a.masterEventId === b.masterEventId
    && a.activeInstanceId === b.activeInstanceId && a.updatedAt === b.updatedAt;
}
function rowReferences(row: InventoryRow, identities: Set<string>): boolean {
  // Historical evidence is displayed for review, never trusted as provider state.
  // Compare whole scalar values, not substring matches (IDs may be prefixes).
  const inspect = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") return identities.has(value);
    if (depth > 5 || !value || typeof value !== "object") return false;
    return Object.values(value).some(v => inspect(v, depth + 1));
  };
  return inspect(row, 0);
}

/** Complete strongly consistent inventory; a truncated scan is NOT negative evidence. */
async function strongInventory(): Promise<InventoryRow[]> {
  const table = process.env.STATE_TABLE_NAME;
  if (!table) reject("STATE_TABLE_NAME is not configured", 503);
  const result: InventoryRow[] = [];
  const cursors = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  const started = Date.now();
  for (let page = 0; page < 250; page += 1) {
    if (Date.now() - started > 75_000) reject("State inventory timed out; no retirement decision can be made", 503);
    const response = await documentClient.send(new ScanCommand({
      TableName: table, ConsistentRead: true, Limit: 200,
      ...(cursor ? {ExclusiveStartKey: cursor} : {}),
    }));
    result.push(...(response.Items || []) as InventoryRow[]);
    if (result.length > 30_000) reject("State inventory exceeds the safe inspection bound", 503);
    const next = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!next) return result;
    const nextKey = JSON.stringify(next);
    if (cursors.has(nextKey)) reject("State inventory repeated a cursor; incomplete inventory", 503);
    cursors.add(nextKey); cursor = next;
  }
  return reject("State inventory pagination is incomplete", 503);
}

async function recordedDiagnostic(state: StateRepository, target: RetirementDiagnosticTarget): Promise<ReconciliationDiagnostic> {
  let after: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const result = await state.listReconciliationDiagnostics(target.profile, target.generation, 50, after);
    const found = result.items.find(item =>
      item.action === "todoist_snapshot_reconcile_recurring_deferred"
      && item.reason === "recurrence_owned_mapping_deferred"
      && item.profile === target.profile && item.generation === target.generation
      && item.taskId === target.taskId && item.eventId === target.eventId
      && item.seriesId === target.seriesId
      && item.caseStatus !== "retired");
    if (found) return found;
    if (!result.next) return reject("This exact recorded recurring diagnostic is no longer available");
    if (cursors.has(result.next)) return reject("Diagnostic pagination repeated a cursor", 503);
    cursors.add(result.next); after = result.next;
  }
  return reject("Diagnostic pagination is incomplete", 503);
}

export type RetirementSafetyInput = {
  nowMs: number;
  target: RetirementDiagnosticTarget;
  mapping?: Mapping;
  taskIndex?: Mapping;
  ownerIndex?: Mapping;
  eventIndex?: Mapping;
  link?: RecurrenceLink;
  master?: CalendarEvent;
  occurrence?: CalendarEvent;
  instances: CalendarEvent[];
  completedTask?: CompletedTodoistEvidence;
  activeTask?: TodoistTask;
  completedLookupFailed: boolean;
  history: CompletedCalendarProjection[];
  terminal?: VerifiedTerminalSeries;
  otherOwners: string[];
  activeReviews: string[];
  inFlightControls: string[];
};

/**
 * Pure policy for future approval, not a permission to mutate state.
 * Requires positive terminal evidence from both providers AND local immutable
 * completion history. A missing task, a past date, or a cancelled instance is
 * never sufficient evidence on its own.
 */
export function assessRecurrenceRetirement(input: RetirementSafetyInput): string[] {
  const b: string[] = [];
  const {target, mapping, link, master, occurrence, instances, nowMs} = input;
  if (!mapping || mapping.profile !== target.profile || mapping.taskId !== target.taskId
      || mapping.eventId !== target.eventId || mapping.seriesId !== target.seriesId
      || mapping.recurrenceOwner !== "calendar" || !mapping.masterEventId
      || !mapping.updatedAt) b.push("The exact Calendar-owned mapping is absent, incomplete or has changed");
  if (!exactSameMapping(mapping, input.taskIndex) || !exactSameMapping(mapping, input.ownerIndex)
    || !exactSameMapping(mapping, input.eventIndex)) b.push("TASK, TASKOWNER and EVENT indexes do not agree on an exact revision");
  if (!link || link.profile !== target.profile || link.owner !== "calendar"
    || link.taskId !== target.taskId || link.eventId !== target.eventId
    || link.seriesId !== target.seriesId || link.masterEventId !== mapping?.masterEventId
    || link.activeInstanceId !== mapping?.activeInstanceId || !link.updatedAt)
    b.push("The recurrence link is missing or has different ownership/progress");
  if (!master || master.id !== mapping?.masterEventId || master.status === "cancelled"
      || !master.etag || !master.recurrence?.length)
    b.push("An intact Calendar master with a provider ETag and RRULE was not verified");
  if (master?.recurrence?.some(rule => !rule.startsWith("RRULE:")))
    b.push("Additional RDATE/EXDATE rules require separate series review");
  if (master?.recurrence?.some(rule => !/(?:^|;)(COUNT|UNTIL)=/.test(rule)))
    b.push("Unbounded Calendar recurrence cannot be retired as an ended series");
  if (!occurrence || occurrence.id !== target.eventId || occurrence.recurringEventId !== mapping?.masterEventId
      || occurrence.status === "cancelled" || !occurrence.etag)
    b.push("The selected, confirmed Calendar occurrence was not independently verified");
  if (!instances.length || instances.length > 20 || instances.some(item =>
      !item.id || item.recurringEventId !== mapping?.masterEventId
      || item.status !== "cancelled" && item.status !== "confirmed"))
    b.push("The full Calendar instance inventory is missing, ambiguous or too large");
  if (instances.length && !instances.some(item => item.id === target.eventId))
    b.push("The selected occurrence was not found in the complete series inventory");
  if (instances.some(item => {
    const time = isoTime(item.start?.dateTime || item.start?.date
      || item.originalStartTime?.dateTime || item.originalStartTime?.date);
    return !Number.isFinite(time) || time >= nowMs;
  })) b.push("A future or unverified Calendar occurrence exists; active series cannot be retired");
  if (input.activeTask) b.push("Todoist still has an active task; completion cannot be inferred");
  if (!input.completedTask || input.completedTask.id !== target.taskId
    || input.completedTask.is_deleted === true
    || !Number.isFinite(isoTime(input.completedTask.completed_at))
    || isoTime(input.completedTask.completed_at) >= nowMs - 7 * 86400_000)
    b.push("Todoist did not independently prove this exact task completed more than seven days ago");
  if (input.completedLookupFailed) b.push("Todoist completed-task inventory is unavailable or incomplete");
  const completion = terminalCompletionDecision(input.history, nowMs, input.terminal);
  if (completion !== "eligible") b.push(completion === "too_recent"
    ? "The immutable terminal completion is within the seven-day retention window"
    : "No matching immutable terminal-series completion evidence exists");
  if (input.history.some(item => item.seriesId !== target.seriesId
    || item.recurrenceOwner !== "calendar" || item.masterEventId !== mapping?.masterEventId))
    b.push("Completed history references another recurrence relationship");
  if (input.otherOwners.length) b.push("Other profile or live successor references prevent a scoped retirement");
  if (input.activeReviews.length) b.push("An open review case or manual decision still owns an affected identity");
  if (input.inFlightControls.length) b.push("A concurrent repair/exclusion control is active");
  return [...new Set(b)];
}

/**
 * Diagnostic-bound inspect. Does not issue confirmation tokens, change any
 * provider metadata, or delete/mutate DynamoDB records.
 */
export async function inspectRecurrenceRetirement(target: RetirementDiagnosticTarget): Promise<RecurrenceRetirementInspection> {
  if (!PROFILES.includes(target.profile) || !diagPattern.test(target.generation)
    || ![target.taskId,target.eventId,target.seriesId].every(id => idPattern.test(id)))
    return reject("Exact profile, generation, Todoist ID, Calendar occurrence ID and series ID are required", 400);
  const state = new StateRepository();
  const diagnostic = await recordedDiagnostic(state, target);
  const [taskIndex,ownerIndex,eventIndex,history,inventory] = await Promise.all([
    state.getMappingByTask(target.profile,target.taskId), state.getTaskOwnerMapping(target.taskId),
    state.getMappingByEvent(target.profile,target.eventId),
    state.listCompletedCalendarProjectionsByTask(target.profile,target.taskId),
    strongInventory(),
  ]);
  const mapping = taskIndex;
  const link = await state.getRecurrenceLink(target.profile,target.seriesId);
  const identities = new Set([target.taskId,target.eventId,target.seriesId,
    mapping?.masterEventId,mapping?.activeInstanceId].filter((id):id is string=>!!id));
  const related = inventory.filter(row => rowReferences(row, identities));
  const relatedCounters: Record<string,number> = {};
  for (const row of related) {
    const kind = String(row.pk || "").split("#")[0] || "unknown";
    relatedCounters[kind] = (relatedCounters[kind] || 0) + 1;
  }
  const otherOwners = related.filter(row => {
    const pk = String(row.pk || "");
    if (!/^(TASK#|EVENT#|TASKOWNER#|RECURRENCE#|CANONICAL#)/.test(pk)) return false;
    if (pk === "TASK#" + target.profile + "#" + target.taskId
      || pk === "EVENT#" + target.profile + "#" + target.eventId
      || pk === "TASKOWNER#" + target.taskId
      || pk === "RECURRENCE#" + target.profile + "#" + target.seriesId
      || pk.startsWith("CANONICAL#" + target.profile + "#")) return false;
    return true;
  });
  const activeReviews = related.filter(row => {
    const pk = String(row.pk || "");
    return /^(REVIEW_CASE#|MANUAL#|REPAIR#|REPAIR_PREVIEW#)/.test(pk)
      && ["open","repairing","pending","queued","running","needs_review"].includes(String(row.status || ""));
  });
  const inFlightControls = related.filter(row => {
    const pk = String(row.pk || "");
    return pk.startsWith("SYNC_CONTROL#") && (row.activeRepair || row.excluded || row.pendingRefresh);
  });
  const terminalRow = inventory.find(row => row.pk === "COMPLETED_SERIES#" + target.profile + "#" + target.seriesId
    && row.sk === "STATE");
  const terminal = terminalRow && typeof terminalRow.terminalCompletedAt === "string"
    ? terminalRow as unknown as VerifiedTerminalSeries : undefined;

  const pair = await defaultProviderClientFactory(target.profile);
  let task: TodoistTask | undefined;
  let completedTask: CompletedTodoistEvidence | undefined;
  let completedLookupFailed = false;
  try { task = await pair.todoist.getTask(target.taskId); }
  catch (error) { if (Number((error as {status?:number}).status) !== 404) throw error; }
  // The active getTask endpoint does not return completed tasks. A 404 is not
  // a completion marker: require a separate paginated direct completed lookup.
  if (!task && history.length) {
    const latest = history.slice().sort((a,b)=>b.completedAt.localeCompare(a.completedAt))[0];
    try {
      completedTask = await pair.todoist.findCompletedTaskById(target.taskId,latest.completedAt);
    } catch (error) {
      if (![400,401,403,404,410,429,500,502,503,504].includes(Number((error as {status?:number}).status))) throw error;
      completedLookupFailed = true;
    }
  }
  let master: CalendarEvent | undefined;
  let occurrence: CalendarEvent | undefined;
  let instances: CalendarEvent[] = [];
  if (mapping?.masterEventId) {
    try { master = await pair.calendar.getEvent(mapping.masterEventId); }
    catch (error) { if (![404,410].includes(Number((error as {status?:number}).status))) throw error; }
    if (master) instances = await pair.calendar.listEventInstances(master.id);
  }
  try { occurrence = await pair.calendar.getEvent(target.eventId); }
  catch (error) { if (![404,410].includes(Number((error as {status?:number}).status))) throw error; }
  const blockers = assessRecurrenceRetirement({
    nowMs:Date.now(),target,mapping,taskIndex,ownerIndex,eventIndex,link,master,occurrence,
    instances,completedTask,activeTask:task,completedLookupFailed,history,terminal,
    otherOwners:otherOwners.map(row=>String(row.pk)),
    activeReviews:activeReviews.map(row=>String(row.pk)),
    inFlightControls:inFlightControls.map(row=>String(row.pk)),
  });
  const fingerprint = reviewHash({
    target,diagnostic,task,completedTask,master,occurrence,instances,
    mapping,taskIndex,ownerIndex,eventIndex,link,history,terminal,
    relevantState:related.map(row=>({pk:row.pk,sk:row.sk,row})).sort((a,b)=>(a.pk||"").localeCompare(b.pk||"")),
  });
  return {
    target,checkedAt:new Date().toISOString(),diagnostic,
    task:{status:task?"active":completedTask?"completed_verified":"unverified",
      ...(task||completedTask ? {value:task||completedTask}:{}),
      source:task?"Todoist active task direct GET":completedTask?"Todoist completed-by-completion-date paginated API":"No direct Todoist completion verification"},
    calendar:{...(master?{master}:{}),...(occurrence?{occurrence}:{}),
      instances,source:"Calendar direct master/occurrence GET plus bounded complete instance inventory"},
    ...(mapping?{mapping}:{}),...(link?{recurrenceLink:link}:{}),
    completionHistory:history,...(terminal?{terminalSeries:terminal}:{}),
    indexKeys:related.filter(row=>/^(TASK#|TASKOWNER#|EVENT#|RECURRENCE#|CANONICAL#|BASELINE#)/.test(String(row.pk||"")))
      .map(row=>String(row.pk)+(row.sk?"/"+String(row.sk):"")),
    historicalRowCounts:relatedCounters,
    otherProfileReferences:otherOwners.map(row=>({profile:String(row.profile||"unknown"),key:String(row.pk)})),
    blockers,eligibleForFutureApproval:blockers.length===0,
    previewFingerprint:fingerprint,providerWrites:false,
  };
}

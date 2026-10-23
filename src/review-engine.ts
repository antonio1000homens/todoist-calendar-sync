import { planRecurrenceFlatten, flattenStandaloneId, flattenStandalone, flattenMasterProjection, assertFlattenedMaster, assertFlattenInstances } from "./recurrence-flatten.js";
import { randomUUID } from "node:crypto";
import { profiles } from "./config.js";
import { CanonicalIdentityStore, calendarCanonicalIdentity, todoistCanonicalIdentity } from "./canonical-identity.js";
import { defaultProviderClientFactory, ReconciliationMutationBudget, createBudgetedClientFactory, type ProviderClientFactory } from "./mutation-budget.js";
import { StateRepository } from "./repository.js";
import { DynamoReconciliationStore } from "./reconciliation.js";
import { ReviewStore, SyncControls, reviewHash } from "./review-store.js";
import { entityKey, operationHasWriteEvidence, type EntityRef, type RepairIntent, type RepairOperation, type RepairPreview, type RepairRelease, type ReviewActor, type ReviewSnapshot } from "./review-types.js";
import { hasCanonicalState, occurrenceStateMatches, selectCalendarRecurrenceInstance, toCalendarEvent, toTodoistTask } from "./sync.js";
import { upsertProjectMappingComment, deleteMappingComments } from "./mapping-comments.js";
import { calendarRecurrenceMatchesTodoist, selectTodoistCurrentInstance, todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import { planFutureSeriesSplit } from "./recurrence-split.js";
import { applyApprovedFutureSeriesSplit, assertApprovedHistoryCap } from "./future-split-execution.js";
import { planStandaloneAnnualRepair, verifyStandaloneAnnualOwnership, applyStandaloneAnnualRepair, assertStandaloneHistory } from "./standalone-annual-repair.js";
import { ManualDecisionStore, ManualInterventionService, type ManualDecision } from "./manual-intervention.js";
import { ProjectAwareSynchronizer, todoistOccurrenceProjection } from "./project-sync.js";
import { guardRepairProviders } from "./repair-provider-guard.js";
import { normalizedText } from "./security.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import type { CalendarEvent, Mapping, Profile, TodoistTask } from "./types.js";
const missing = (e: unknown) => [404, 410].includes(Number((e as { status?: number }).status));
const at = () => new Date().toISOString();
const validAllDayDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10) === value;
function invalidRepairIntent(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function recurrenceAnchorMatches(event: CalendarEvent): boolean {
  const shared = event.extendedProperties?.shared;
  return Boolean(shared?.todoistAnchorStart && shared.todoistAnchorEnd
    && (event.start?.dateTime || event.start?.date) === shared.todoistAnchorStart
    && (event.end?.dateTime || event.end?.date) === shared.todoistAnchorEnd);
}
function calendarSeriesRuleMatchesTodoistTask(event: CalendarEvent, task: TodoistTask): boolean {
  const rule = todoistRecurrenceToRrule(task);
  if (!rule || !event.recurrence?.length) return false;
  const normalize = (value: string): string | undefined => {
    if (!value.startsWith("RRULE:")) return undefined;
    const parts = value.slice("RRULE:".length).split(";");
    if (parts.some(part => !/^[A-Z]+=[^;]+$/.test(part))) return undefined;
    if (new Set(parts.map(part => part.slice(0, part.indexOf("=")))).size !== parts.length) return undefined;
    const entries = new Map(parts.map(part => {
      const [key, ...rest] = part.split("=");
      return [key, rest.join("=")];
    }));
    if (entries.get("INTERVAL") === "1") entries.delete("INTERVAL");
    return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${key}=${val}`).join(";");
  };
  const expected = normalize(rule);
  return Boolean(expected && event.recurrence.some(candidate => normalize(candidate) === expected));
}
function decisionRepairIntent(intent: RepairIntent, decision?: ManualDecision): RepairIntent {
  if (intent.action !== "decision") return intent;
  if (!decision || !decision.permittedActions.some(a => a.id === intent.decisionAction) || intent.decisionAction === "reconcile_now") invalidRepairIntent("Select a permitted repair action; reconciliation is a separate explicit request");
  const contextTaskId = typeof decision.context?.providerTaskId === "string" ? decision.context.providerTaskId : undefined;
  const contextEventId = typeof decision.context?.providerEventId === "string" ? decision.context.providerEventId : undefined;
  const taskId = intent.decisionAction?.startsWith("bind_task:") ? intent.decisionAction.slice("bind_task:".length) : decision.taskId || decision.mappingSnapshot?.taskId || contextTaskId;
  const eventId = decision.eventId || decision.mappingSnapshot?.eventId || decision.activeInstanceId || decision.masterEventId || contextEventId;
  if (intent.taskId && intent.taskId !== taskId || intent.eventId && intent.eventId !== eventId) invalidRepairIntent("Selected items do not match the decision's repair targets");
  return { ...intent, taskId, eventId };
}
function unchangedControlState(control?: Record<string, unknown>): { excluded: unknown; fencedAt: unknown } {
  // The active repair claim is expected to change while a repair runs; compare
  // the durable user-facing control state that existed in the approved preview.
  return { excluded: control?.excluded, fencedAt: control?.fencedAt };
}
function retainedTaskControlState(control?: Record<string, unknown>): { excluded: boolean; fencedAt: unknown } {
  return { excluded: control?.excluded === true, fencedAt: control?.fencedAt };
}
export function snapshotFingerprint(snapshots: ReviewSnapshot[]): string {
  return reviewHash(snapshots.map(s => ({ ref: s.ref, object: s.object, mapping: s.mapping,
    recurrence: s.recurrence, calendarProjectionId: s.calendarProjectionId, destination:s.destination,
    control: { excluded: s.control?.excluded, fencedAt: s.control?.fencedAt } })));
}
export class ReviewEngine {
  constructor(readonly store = new ReviewStore(), readonly state = new StateRepository(), readonly clients: ProviderClientFactory = defaultProviderClientFactory,
    readonly controls = new SyncControls()) {}
  private async queueDeferredRefresh(refs: EntityRef[], state = this.state): Promise<Array<EntityRef & {pendingRefreshAt:string}>> {
    const pending = await this.controls.pendingRefreshRefs(refs);
    if (!pending.length) return pending;
    const byProfile = new Map<Profile, typeof pending>();
    for (const ref of pending) {
      const group = byProfile.get(ref.profile) || [];
      group.push(ref);
      byProfile.set(ref.profile, group);
    }
    for (const [profile, profileRefs] of byProfile) {
      const request = await requestReconciliation(state, profile, "manual", enqueueDelivery,
        { requester:"review-repair", pendingRefreshRefs:profileRefs });
      if (!request.queued && !request.coalesced) {
        throw new Error(`Provider updates arrived during this repair, but reconciliation could not be queued for ${profile}; the repair barrier remains active. Resume this operation to retry.`);
      }
    }
    return pending;
  }
  private async releaseLegacyNoWriteClaims(actor: ReviewActor, snapshots: ReviewSnapshot[]): Promise<boolean> {
    const owners = [...new Set(snapshots.map(snapshot => snapshot.control?.activeRepair).filter((id): id is string => typeof id === "string"))];
    if (!owners.length) return false;
    for (const id of owners) {
      const operation = await this.store.getOperation(id);
      // Only legacy failed attempts with the durable, read-only validation
      // checkpoint can be superseded. Any other checkpoint may have crossed a
      // provider or mapping write boundary and must retain its resume barrier.
      if (!operation || operation.id !== id || operation.actor?.subject !== actor.subject
        || operation.status !== "failed" || operation.abandoned
        || operation.steps?.validated?.status !== "done" || operationHasWriteEvidence(operation)) {
        invalidRepairIntent("An incomplete repair owns an affected item; resume that operation first");
      }
      const ownedSnapshots = [...(operation.preview?.snapshots || []), ...(operation.claimSnapshots || [])];
      const refs = [...new Map(ownedSnapshots.map(snapshot => [entityKey(snapshot.ref), snapshot.ref])).values()];
      if (!refs.length || ownedSnapshots.some(snapshot => !snapshot.ref?.profile || !snapshot.ref?.side || !snapshot.ref?.id)) {
        invalidRepairIntent("The failed repair has incomplete ownership evidence; inspect it before creating another preview");
      }
      for (const ref of refs) {
        const control = await this.controls.control(ref);
        if (control?.activeRepair !== id) {
          invalidRepairIntent("Repair ownership changed while preparing a fresh preview; refresh affected items and retry");
        }
      }
      try {
        const queued = await this.queueDeferredRefresh(refs);
        await this.controls.releaseUnapplied(refs, id, ownedSnapshots, {
          error: operation.error || "No provider write was recorded",
          nextAction: "No provider write is recorded. Refresh affected items and create a new preview; the failed operation remains available for audit.",
        }, queued);
      } catch (error) {
        invalidRepairIntent(`The failed repair could not be safely superseded; its ownership remains protected. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  }
  async snapshot(ref: EntityRef): Promise<ReviewSnapshot> {
    const pair = await this.clients(ref.profile);
    let object: TodoistTask | CalendarEvent | null;
    try { object = ref.side === "todoist" ? await pair.todoist.getTask(ref.id) : await pair.calendar.getEvent(ref.id); }
    catch (e) { if (!missing(e)) throw e; object = null; }
    const mapping = ref.side === "todoist" ? await this.state.getMappingByTaskAnyProfile(ref.id) : await this.state.getMappingByEvent(ref.profile, ref.id);
    if (mapping && mapping.profile !== ref.profile) invalidRepairIntent(`Item belongs to ${mapping.profile}; use Move to profile instead`);
    if (ref.side === "todoist" && object && (object as TodoistTask).project_id !== profiles[ref.profile].todoistProjectId) invalidRepairIntent("Task is outside the selected profile's project");
    const snapshot: ReviewSnapshot = { ref, object, mapping, checkedAt: at(), control: await this.controls.control(ref) as Record<string, unknown> | undefined };
    if (ref.side === "todoist" && object && !mapping && (object as TodoistTask).due?.is_recurring) {
      const recurrence = await this.state.getRecurrenceLinkByTaskAnyProfile(ref.id);
      if (recurrence && recurrence.profile !== ref.profile) invalidRepairIntent(`Item belongs to ${recurrence.profile}; use Move to profile instead`);
      snapshot.recurrence = recurrence;
    }
    if (ref.side === "calendar" && (object as CalendarEvent|null)?.recurrence?.length) {
      const event = object as CalendarEvent;
      const taskId = mapping?.taskId || event.extendedProperties?.shared?.taskId;
      const todoistOwned = mapping?.recurrenceOwner === "todoist" || event.extendedProperties?.shared?.syncRecurrenceOwner === "todoist";
      snapshot.recurrence = await this.state.getRecurrenceLink(ref.profile, todoistOwned && taskId ? taskId : event.iCalUID || event.id);
      const instances = await pair.calendar.listInstances(event.id);
      if (todoistOwned && taskId) {
        let task: TodoistTask | undefined;
        try { task = await pair.todoist.getTask(taskId); } catch(error) { if (!missing(error)) throw error; }
        const activeId = snapshot.recurrence?.activeInstanceId || mapping?.activeInstanceId;
        snapshot.calendarProjectionId = task ? selectTodoistCurrentInstance(instances, task, activeId)?.id : activeId;
      } else snapshot.calendarProjectionId = selectCalendarRecurrenceInstance(instances, snapshot.recurrence)?.id;
    }
    return snapshot;
  }
  async collect(intent: RepairIntent, decision?: ManualDecision): Promise<ReviewSnapshot[]> {
    const refs = new Map<string, EntityRef>();
    const add = (ref: EntityRef) => {
      if (intent.action === "move" && ref.side === "todoist" && ref.profile === intent.targetProfile && ref.id === intent.taskId) return;
      if (ref.id) refs.set(entityKey(ref), ref);
    };
    if (intent.taskId) add({ profile: intent.profile, side: "todoist", id: intent.taskId });
    if (intent.eventId) add({ profile: intent.profile, side: "calendar", id: intent.eventId });
    let destination: ReviewSnapshot["destination"];
    if (intent.action === "move" && intent.targetProfile && intent.taskId) {
      const target = await (await this.clients(intent.targetProfile)).calendar.findByTodoistTaskId(intent.taskId);
      destination = { profile:intent.targetProfile, eventId:target?.id };
      if (target) add({profile:intent.targetProfile,side:"calendar",id:target.id});
    }
    if (intent.action === "decision" && decision) {
      const mapping = decision.mappingSnapshot;
      const contextTaskId = typeof decision.context?.providerTaskId === "string" ? decision.context.providerTaskId : undefined;
      const contextEventId = typeof decision.context?.providerEventId === "string" ? decision.context.providerEventId : undefined;
      for (const taskId of [decision.taskId, mapping?.taskId, contextTaskId]) if (taskId) add({ profile:intent.profile, side:"todoist", id:taskId });
      for (const eventId of [decision.eventId, decision.masterEventId, decision.activeInstanceId, mapping?.eventId, mapping?.masterEventId, mapping?.activeInstanceId, contextEventId]) {
        if (eventId) add({ profile:intent.profile, side:"calendar", id:eventId });
      }
    }
    const snapshots: ReviewSnapshot[] = [];
    for (const ref of refs.values()) {
      if (refs.size > 20) invalidRepairIntent("Too many linked items for one repair; narrow the selection");
      const snapshot = await this.snapshot(ref); snapshots.push(snapshot);
      if (destination && ref.profile === intent.profile && ref.side === "todoist" && ref.id === intent.taskId) snapshot.destination = destination;
      if (destination && ref.profile === destination.profile && snapshot.mapping && snapshot.mapping.taskId !== intent.taskId) invalidRepairIntent("Destination projection belongs to another task; repair its link before moving");
      if (snapshot.mapping) {
        add({ profile: snapshot.mapping.profile, side: "todoist", id: snapshot.mapping.taskId });
        add({ profile: snapshot.mapping.profile, side: "calendar", id: snapshot.mapping.eventId });
        if (snapshot.mapping.masterEventId) add({ profile: ref.profile, side: "calendar", id: snapshot.mapping.masterEventId });
      }
      if (ref.side === "todoist" && snapshot.recurrence) {
        if (snapshot.recurrence.masterEventId) add({ profile: ref.profile, side: "calendar", id: snapshot.recurrence.masterEventId });
        add({ profile: ref.profile, side: "calendar", id: snapshot.recurrence.activeInstanceId || snapshot.recurrence.eventId });
      }
      if (ref.side === "calendar" && snapshot.object) {
        const event = snapshot.object as CalendarEvent;
        if (event.extendedProperties?.shared?.taskId) add({ profile: ref.profile, side: "todoist", id: event.extendedProperties.shared.taskId });
        if (event.recurringEventId) add({ profile: ref.profile, side: "calendar", id: event.recurringEventId });
        if (event.recurrence?.length) {
          const recurrence = snapshot.recurrence;
          if (recurrence) {
            add({ profile:ref.profile, side:"todoist", id:recurrence.taskId });
            add({ profile:ref.profile, side:"calendar", id:recurrence.activeInstanceId || recurrence.eventId });
          }
          if (snapshot.calendarProjectionId) add({ profile:ref.profile, side:"calendar", id:snapshot.calendarProjectionId });
        }
      }
      if (ref.side === "todoist" && snapshot.object) {
        // Full provider metadata lookup includes ambiguous claims rather than picking one.
        const pair = await this.clients(ref.profile);
        for (const event of (await pair.calendar.listDelta()).items) {
          if (event.status !== "cancelled" && event.extendedProperties?.shared?.taskId === ref.id) add({ profile: ref.profile, side: "calendar", id: event.id });
        }
      }
    }
    if (intent.action === "transfer" && intent.taskId && intent.eventId) {
      const task = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === intent.taskId)?.object as TodoistTask | null | undefined;
      const master = snapshots.find(s => s.ref.side === "calendar" && s.ref.id === intent.eventId);
      const active = master?.calendarProjectionId
        ? snapshots.find(s => s.ref.side === "calendar" && s.ref.id === master.calendarProjectionId)?.object as CalendarEvent | null | undefined
        : undefined;
      const activeStart = active?.start?.dateTime || active?.start?.date;
      if (task && activeStart) {
        const provider = await this.clients(intent.profile);
        const annualRule = todoistRecurrenceToRrule(task) === "RRULE:FREQ=YEARLY";
        const annualDate = (value?: string) => value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(5, 10) : undefined;
        const candidates = (await provider.calendar.listDelta()).items.filter(candidate => candidate.id !== active.id
          && !candidate.recurringEventId && !candidate.recurrence?.length
          && candidate.status !== "cancelled"
          && ((candidate.start?.dateTime || candidate.start?.date) === activeStart
            || annualRule && annualDate(candidate.start?.dateTime || candidate.start?.date) === annualDate(activeStart))
          && normalizedText(candidate.summary).toLowerCase() === normalizedText(task.content).toLowerCase());
        for (const candidate of candidates) {
          if (snapshots.some(s => s.ref.side === "calendar" && s.ref.id === candidate.id)) continue;
          if (snapshots.length >= 20) invalidRepairIntent("Too many affected items for one transfer; narrow the selection");
          const snapshot = await this.snapshot({profile:intent.profile,side:"calendar",id:candidate.id});
          snapshots.push(snapshot);
          // Surface the exact mapped task too; matching only discovers a
          // candidate and never chooses its disposition or transfers its link.
          if (snapshot.mapping && !snapshots.some(s => s.ref.side === "todoist" && s.ref.id === snapshot.mapping!.taskId)) {
            if (snapshots.length >= 20) invalidRepairIntent("Too many affected items for one transfer; narrow the selection");
            snapshots.push(await this.snapshot({profile:intent.profile,side:"todoist",id:snapshot.mapping.taskId}));
          }
        }
      }
    }
    if (intent.action === "flatten" && intent.taskId) {
      const occurrence = snapshots.find(s=>s.ref.side==="calendar" && s.ref.id===intent.eventId)?.object as CalendarEvent|undefined;
      const master = snapshots.find(s=>s.ref.side==="calendar" && s.ref.id===occurrence?.recurringEventId)?.object as CalendarEvent|undefined;
      if (occurrence && master && occurrence.start?.date !== master.start?.date) {
        const id = flattenStandaloneId(intent.profile,intent.taskId,master.id,occurrence.id);
        if (!snapshots.some(s=>s.ref.side==="calendar" && s.ref.id===id)) snapshots.push(await this.snapshot({profile:intent.profile,side:"calendar",id}));
      }
    }
    for (const snapshot of snapshots) {
      const recurrence = snapshot.recurrence;
      if (!recurrence) continue;
      for (const refId of [recurrence.masterEventId, recurrence.activeInstanceId || recurrence.eventId]) {
        if (!refId) continue;
        const related = snapshots.find(candidate => candidate.ref.profile === recurrence.profile
          && candidate.ref.side === "calendar" && candidate.ref.id === refId);
        if (related && !related.recurrence) related.recurrence = recurrence;
      }
    }
    return snapshots.sort((a,b) => entityKey(a.ref).localeCompare(entityKey(b.ref)));
  }
  async preview(actor: ReviewActor, intent: RepairIntent): Promise<RepairPreview> {
    const record = await this.store.getCase(intent.caseId);
    if (!record || record.profile !== intent.profile) invalidRepairIntent("Conflict not found in this profile");
    if (!["flatten","todoist-only","link","transfer","separate","create","exclude","decision","verify","move"].includes(intent.action)) invalidRepairIntent("Unknown repair action");
    if (!["none","todoist","calendar"].includes(intent.winner) || !["occurrence","series","future"].includes(intent.scope)) invalidRepairIntent("Invalid field winner or recurrence scope");
    if (!intent.leftovers || Object.values(intent.leftovers).some(v => !["exclude","create","unchanged","retain-unlinked"].includes(v))) invalidRepairIntent("Invalid leftover dispositions");
    if (intent.action !== "transfer" && Object.values(intent.leftovers).includes("retain-unlinked")) invalidRepairIntent("Retain unlinked is available only during an explicit Calendar series transfer");
    intent = decisionRepairIntent(intent, record.decision);
    let snapshots = await this.collect(intent, record.decision);
    if (!snapshots.length) invalidRepairIntent("Select at least one provider item");
    // Never accept a disposition submitted for an undisclosed or ambiguous object.
    // In particular a stale task's 404 snapshot must not be mistaken for a live task.
    for (const key of Object.keys(intent.leftovers)) {
      const s = snapshots.find(snapshot => entityKey(snapshot.ref) === key);
      if (!s || !s.object || s.object.id !== s.ref.id) invalidRepairIntent(`Cannot identify the live item for disposition ${key}; refresh affected items`);
      if (s.ref.side === "calendar") {
        const event = s.object as CalendarEvent;
        if ((!event.start?.date && !event.start?.dateTime) || !["confirmed","cancelled"].includes(event.status || "")) {
          invalidRepairIntent(`Calendar disposition ${key} lacks a verified start or status; refresh affected items`);
        }
      }
    }
    if (snapshots.some(s => s.control?.activeRepair)) {
      if (!await this.releaseLegacyNoWriteClaims(actor, snapshots)) invalidRepairIntent("An incomplete repair owns an affected item; resume that operation first");
      // Release is conditional and atomic with the old operation's terminal
      // audit marker. Re-read provider versions, mappings, and controls so the
      // newly created preview is never based on the pre-release snapshot.
      snapshots = await this.collect(intent, record.decision);
      if (snapshots.some(s => s.control?.activeRepair)) invalidRepairIntent("An incomplete repair still owns an affected item; resume that operation first");
    }
    const task = snapshots.find(s => s.ref.profile === intent.profile && s.ref.side === "todoist" && s.ref.id === intent.taskId)?.object as TodoistTask | undefined;
    const event = snapshots.find(s => s.ref.profile === intent.profile && s.ref.side === "calendar" && s.ref.id === intent.eventId)?.object as CalendarEvent | undefined;
    if (intent.action === "todoist-only") {
      const taskSnapshot = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === intent.taskId);
      const eventSnapshot = snapshots.find(s => s.ref.side === "calendar" && s.ref.id === intent.eventId);
      if (record.status && record.status !== "open") invalidRepairIntent("Todoist-only flatten is available only for unresolved open cases");
      if (!task || !event || !taskSnapshot || !eventSnapshot) invalidRepairIntent("Select the exact live Todoist task and historical Calendar event");
      const dueDate = task.due?.date;
      if (!validAllDayDate(dueDate) || task.due?.datetime || task.due?.date?.includes("T")
        || !["RRULE:FREQ=YEARLY","RRULE:FREQ=YEARLY;INTERVAL=1"].includes(todoistRecurrenceToRrule(task) || "")) {
        invalidRepairIntent("Todoist-only flatten requires an active all-day yearly task with a verified due date");
      }
      const eventDate = event.start?.date;
      if (task.is_deleted || task.is_completed || event.status !== "confirmed" || !validAllDayDate(eventDate) || !validAllDayDate(event.end?.date)
        || event.end.date <= eventDate || event.start?.dateTime || event.end.dateTime
        || event.recurringEventId || event.recurrence?.length || eventDate >= dueDate) {
        invalidRepairIntent("Select a confirmed, historical standalone all-day Calendar item before the task due date");
      }
      if (snapshots.length !== 2 || taskSnapshot.mapping || taskSnapshot.recurrence || eventSnapshot.mapping || eventSnapshot.recurrence
        || event.extendedProperties?.shared?.taskId) {
        invalidRepairIntent("Todoist-only flatten requires the selected historical Calendar item and task to have no mapping, recurrence ownership, or stale Calendar task identity");
      }
      if (Object.keys(intent.leftovers).some(key => key !== entityKey(eventSnapshot.ref) || intent.leftovers[key] !== "unchanged")) {
        invalidRepairIntent("Todoist-only flatten keeps only the selected historical Calendar item unchanged");
      }
    }
    if (intent.action === "verify") {
      if (!task) invalidRepairIntent(`Verification requires live Todoist task ${intent.taskId || "(not selected)"}; refresh affected items and select the current pair`);
      if (!event) invalidRepairIntent(`Verification requires live Calendar event ${intent.eventId || "(not selected)"}; refresh affected items and select the current pair`);
      const mapping = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === intent.taskId)?.mapping
        || snapshots.find(s => s.ref.side === "calendar" && s.ref.id === intent.eventId)?.mapping;
      if (!mapping) invalidRepairIntent(`Selected pair does not match the current mapping: Todoist task ${task.id}, selected Calendar event ${event.id}; expected Calendar event none (no mapping found). Refresh affected items and use the current mapped pair.`);
      const expectedEventIds = [...new Set([mapping?.eventId, mapping?.masterEventId, mapping?.activeInstanceId].filter((id): id is string => Boolean(id)))];
      const mismatch = () => invalidRepairIntent(`Selected pair does not match the current mapping: Todoist task ${task.id}, selected Calendar event ${event.id}; expected Calendar event ${expectedEventIds.join(", ") || "none (no mapping found)"}. Refresh affected items and use the current mapped pair.`);
      if (mapping.taskId !== task.id || !expectedEventIds.includes(event.id)) mismatch();
      if (mapping.recurrenceOwner === "calendar" && mapping.masterEventId) {
        const active = await (await this.clients(intent.profile)).calendar.getEvent(mapping.activeInstanceId || mapping.eventId);
        if (!hasCanonicalState(active, task)) mismatch();
      } else if (mapping.recurrenceOwner === "todoist" && mapping.masterEventId) {
        const pairClients = await this.clients(intent.profile);
        const [master, active] = await Promise.all([
          pairClients.calendar.getEvent(mapping.masterEventId),
          pairClients.calendar.getEvent(mapping.activeInstanceId || mapping.eventId),
        ]);
        if (!calendarRecurrenceMatchesTodoist(master, task) || !recurrenceAnchorMatches(master) || !occurrenceStateMatches(active, task)) mismatch();
      } else if (mapping.eventId !== event.id || !hasCanonicalState(event, task)) mismatch();
    }
    const masterSnapshot = snapshots.find(s => s.ref.profile === intent.profile && s.ref.side === "calendar" && s.ref.id === (event?.recurringEventId || event?.id));
    const approvedCalendarOccurrence = event?.recurrence?.length && intent.owner === "calendar"
      ? snapshots.find(s => s.ref.profile === intent.profile && s.ref.side === "calendar" && s.ref.id === masterSnapshot?.calendarProjectionId)?.object as CalendarEvent | undefined
      : undefined;
    const calendarFieldSource = approvedCalendarOccurrence || event;
    if (intent.action === "transfer") {
      if (!task || !event) invalidRepairIntent("Series transfer requires a live Todoist task and Calendar series master");
      if (intent.owner !== "calendar" || intent.scope !== "future" || intent.winner !== "none") invalidRepairIntent("Series transfer requires Calendar ownership, Future occurrences (preserve history), and Keep current fields");
      if (!event.recurrence?.length || event.recurringEventId) invalidRepairIntent("Select the existing Calendar series master for transfer");
      if (!task.due?.is_recurring || !task.due.string) invalidRepairIntent("Series transfer requires an already-recurring Todoist task with a verifiable recurrence rule");
      if (task.is_completed || task.is_deleted) invalidRepairIntent("Series transfer requires an active, incomplete Todoist task");
      if (await this.state.getCalendarProjectionTombstone(intent.profile, task.id)) invalidRepairIntent("The selected Todoist task has a projection tombstone; resolve that state before transfer");
      if (!masterSnapshot?.calendarProjectionId) invalidRepairIntent("Calendar series has no verifiable future occurrence; refresh affected items");
      const occurrence = snapshots.find(s => s.ref.side === "calendar" && s.ref.id === masterSnapshot.calendarProjectionId)?.object as CalendarEvent | null | undefined;
      if (!occurrence || occurrence.recurringEventId !== event.id || occurrence.status !== "confirmed") invalidRepairIntent("The selected Calendar occurrence changed or is not confirmed; refresh affected items");
      if (!calendarSeriesRuleMatchesTodoistTask(event, task) || !occurrenceStateMatches(occurrence, task)) invalidRepairIntent("The existing Todoist recurrence and Calendar series do not describe the same future occurrence; no transfer is safe");
      const selectedTaskSnapshot = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === task.id);
      if (selectedTaskSnapshot?.mapping) invalidRepairIntent("The selected recurring Todoist task already has a mapping; resolve that exact association before transfer");
      const seriesId = event.iCalUID || event.id;
      if (masterSnapshot.recurrence?.owner === "calendar" && masterSnapshot.recurrence.seriesId === seriesId
        && masterSnapshot.recurrence.taskId === task.id
        && (masterSnapshot.recurrence.activeInstanceId || masterSnapshot.recurrence.eventId) === occurrence.id) {
        invalidRepairIntent("This Todoist task already owns the selected Calendar series occurrence; refresh the case and apply its pending decision instead of transferring the association");
      }
      const calendarOwnerVerified = (masterSnapshot.recurrence?.owner === "calendar"
        && masterSnapshot.recurrence.seriesId === seriesId)
        || event.extendedProperties?.shared?.syncRecurrenceOwner === "calendar";
      if (!calendarOwnerVerified) invalidRepairIntent("Series transfer requires a verified Calendar ownership signal");
      if (masterSnapshot.recurrence && (masterSnapshot.recurrence.owner !== "calendar" || masterSnapshot.recurrence.seriesId !== seriesId)) invalidRepairIntent("The existing recurrence owner or series identity changed; refresh affected items");
      const oldTaskId = masterSnapshot.recurrence?.taskId;
      const seriesMappings = [...new Map(snapshots.map(s => s.mapping).filter((m): m is Mapping => Boolean(m)
        && m!.recurrenceOwner === "calendar" && m!.seriesId === seriesId).map(m => [`${m.taskId}:${m.eventId}:${m.updatedAt}`,m])).values()];
      if (seriesMappings.length > 1) invalidRepairIntent("Multiple mappings claim this Calendar series; resolve the competing associations before transfer");
      const previous = seriesMappings.find(m => m.taskId === oldTaskId && [event.id, masterSnapshot.calendarProjectionId].includes(m.eventId));
      if (oldTaskId && oldTaskId !== task.id && !previous) invalidRepairIntent("The displaced recurrence mapping is missing or ambiguous; use a fresh preview or the stale-mapping recovery workflow");
      if (previous) {
        const disposition = intent.leftovers[entityKey({profile:previous.profile,side:"todoist",id:previous.taskId})];
        if (!["retain-unlinked","exclude","create"].includes(String(disposition))) invalidRepairIntent("Choose an explicit disposition for the exact displaced Todoist task before transfer");
      }
      if (masterSnapshot.recurrence && !masterSnapshot.recurrence.updatedAt) invalidRepairIntent("The Calendar recurrence state has no version; refresh affected items before transfer");
      if (previous && (!previous.updatedAt || previous.profile !== intent.profile || previous.masterEventId !== event.id
        || previous.activeInstanceId && previous.activeInstanceId !== masterSnapshot.calendarProjectionId
        || masterSnapshot.recurrence && (previous.calendarProgressVersion !== masterSnapshot.recurrence.calendarProgressVersion
          || previous.completedThroughOriginalStart !== masterSnapshot.recurrence.completedThroughOriginalStart))) {
        invalidRepairIntent("The displaced mapping and recurrence progress disagree; refresh affected items and resolve the split state first");
      }
      if (!oldTaskId && snapshots.some(s => s.mapping?.recurrenceOwner === "calendar" && s.mapping.masterEventId === event.id)) invalidRepairIntent("A competing Calendar-owned mapping exists without matching recurrence state");
      if (Object.entries(intent.leftovers).some(([key, disposition]) => disposition === "retain-unlinked"
        && !snapshots.some(s => entityKey(s.ref) === key && s.mapping?.taskId === oldTaskId))) invalidRepairIntent("Retain unlinked is allowed only for the exact displaced task mapping");
    }
    if (intent.action === "link" && event?.recurringEventId && intent.owner === "todoist") {
      const parent = masterSnapshot?.object as CalendarEvent|undefined;
      const existingOwner = masterSnapshot?.recurrence?.owner || masterSnapshot?.mapping?.recurrenceOwner || parent?.extendedProperties?.shared?.syncRecurrenceOwner;
      if (existingOwner !== "todoist") invalidRepairIntent("Select the Calendar master for a future-only repair to transfer recurrence ownership to Todoist");
    }
    if (event?.recurringEventId && intent.owner === "calendar" && ["link","create"].includes(intent.action)
      && (masterSnapshot?.recurrence?.owner === "todoist" || (masterSnapshot?.object as CalendarEvent)?.extendedProperties?.shared?.syncRecurrenceOwner === "todoist")) {
      invalidRepairIntent("Use a master-level recurrence repair to change Todoist ownership; an occurrence repair must preserve its parent series");
    }
    if (event?.recurringEventId && intent.owner === "calendar" && ["link","create"].includes(intent.action)
      && masterSnapshot?.calendarProjectionId !== event.id) invalidRepairIntent("Choose the active Calendar occurrence or its master to repair this series");
    const changes: string[] = [], warnings: string[] = [];
    if (intent.action === "todoist-only") {
      changes.push(`Remove the yearly recurrence from Todoist task ${task!.id}; keep its current due date ${task!.due!.date}`);
      changes.push(`Do not create or link a Calendar counterpart for Todoist task ${task!.id}`);
      changes.push(`Leave historical Calendar event ${event!.id} byte-for-byte unchanged and exclude it from future syncing`);
    }
    const show = (value:unknown) => value === undefined ? "unset" : typeof value === "string" ? value : JSON.stringify(value);
    const fieldChange = (label:string,before:unknown,after:unknown) => {
      if (reviewHash({value:before}) !== reviewHash({value:after})) changes.push(`${label}: ${show(before)} → ${show(after)}`);
    };
    const preview: RepairPreview = { id: randomUUID(), actor, intent, case: record, snapshots, fingerprint: snapshotFingerprint(snapshots),
      createdAt: at(), expiresAt: Math.floor(Date.now()/1000)+600, changes, warnings, itemPlan: [] };
    if (intent.action === "flatten") {
      if (record.status && record.status !== "open") invalidRepairIntent("Flatten is available only for unresolved open cases");
      if (!task || !event?.recurringEventId || !masterSnapshot?.object) invalidRepairIntent("Select the exact Calendar occurrence and live Todoist task to flatten");
      if (masterSnapshot.calendarProjectionId !== event.id) invalidRepairIntent("Select the current active Calendar occurrence; another occurrence would retain unwanted future dates");
      if (intent.scope !== "future" || intent.owner || intent.winner !== "none") invalidRepairIntent("Flatten requires Future occurrences, matching current fields and no recurrence owner");
      const provider = await this.clients(intent.profile), master = masterSnapshot.object as CalendarEvent;
      try {
        preview.flattenPlan = planRecurrenceFlatten(intent.profile,task,master,event,await provider.calendar.getTimeZone());
        const instances = await provider.calendar.listInstancesInWindow(master.id,master.start!.date!+"T00:00:00Z",event.end!.date!+"T00:00:00Z");
        assertFlattenInstances(master,instances);
        if (!instances.some(item=>item.id===event.id)) throw new Error("Selected Calendar occurrence is missing from its verified series expansion");
        preview.flattenPlan.verifiedInstanceIds = instances.map(item=>item.id).sort();
        if ((await provider.calendar.listExplicitSeriesExceptions(master.id)).length) throw new Error("Explicit Calendar series exceptions require separate review before flattening");
      } catch(error) { invalidRepairIntent(error instanceof Error ? error.message : "Unsupported flatten repair"); }
      if (preview.flattenPlan!.standaloneId !== master.id && snapshots.some(s=>s.ref.side==="calendar" && s.ref.id===preview.flattenPlan!.standaloneId && s.object)) invalidRepairIntent("The deterministic standalone ID already exists; resume its original repair instead");
      for (const snapshot of snapshots) if (intent.leftovers[entityKey(snapshot.ref)] && (
        snapshot.ref.side === "todoist" && snapshot.ref.id === task.id
        || snapshot.ref.side === "calendar" && ([master.id,event.id,preview.flattenPlan!.standaloneId].includes(snapshot.ref.id)
          || snapshot.mapping && (snapshot.object as CalendarEvent|null)?.status === "cancelled"))) invalidRepairIntent("A provider item handled by the flatten plan cannot have a separate disposition");
      const providerTaskIds = [master.extendedProperties?.shared?.taskId,event.extendedProperties?.shared?.taskId].filter(Boolean);
      if (snapshots.some(s=>s.ref.side==="todoist" && s.ref.id!==task.id && s.object && providerTaskIds.includes(s.ref.id))) invalidRepairIntent("The series still names another live Todoist task; resolve its exact ownership before flattening");
      const previousMappings = [...new Map(snapshots.filter(s=>s.mapping).map(s=>[s.mapping!.taskId,s.mapping!])).values()];
      for (const mapping of previousMappings) {
        if (mapping.profile !== intent.profile || ![task.id,masterSnapshot.recurrence?.taskId].includes(mapping.taskId)) invalidRepairIntent("Competing mapping is not attributable to the selected pair");
        if (mapping.taskId !== task.id && snapshots.some(s=>s.ref.side==="todoist" && s.ref.id===mapping.taskId && s.object)) invalidRepairIntent("The displaced mapped task is still live; resolve its disposition first");
        if (mapping.masterEventId && mapping.masterEventId !== master.id) invalidRepairIntent("The selected task is linked to a different series; resolve that mapping first");
      }
      if (snapshots.some(s=>s.ref.side==="calendar" && s.object && (s.object as CalendarEvent).status !== "cancelled" && s.ref.id !== master.id && s.ref.id !== event.id && s.mapping)) invalidRepairIntent("Another mapped Calendar object requires a separate repair");
      await this.state.assertHistoricalSeriesUnowned(master.id,preview.flattenPlan!.verifiedInstanceIds!,{mapping:previousMappings.find(m=>m.masterEventId===master.id || m.eventId===event.id),link:masterSnapshot.recurrence});
      changes.push(`Remove recurrence from Todoist ${task.id}; retain due date ${preview.flattenPlan!.start}`);
      changes.push(`Retain exact Calendar occurrence ${event.id} as standalone ${preview.flattenPlan!.standaloneId} on ${preview.flattenPlan!.start}–${preview.flattenPlan!.end}`);
      changes.push(preview.flattenPlan!.mode === "cap-history" ? `Preserve master ${master.id} history with ${preview.flattenPlan!.cappedRule}; archive its sync identity` : `Remove the RRULE from master ${master.id} in place; retain the chosen DTSTART`);
      changes.push("Atomically replace the exact stale EVENT, TASK and TASKOWNER indexes and remove obsolete RECURRENCE state; verify both providers before release");
    }
    if (intent.action === "link" && task?.due?.is_recurring && event && !event.recurrence?.length && !event.recurringEventId
      && intent.owner === "todoist") {
      if (intent.scope !== "future") invalidRepairIntent("Creating a yearly Calendar series from a standalone event requires Future occurrences (preserve history)");
      if (intent.winner !== "todoist") invalidRepairIntent("Use Todoist fields for a Todoist-owned yearly Calendar series repair");
      const provider = await this.clients(intent.profile);
      try {
        const zone = await provider.calendar.getTimeZone();
        let existingMasterId: string | undefined;
        let existingActiveInstanceId: string | undefined;
        const due = task.due?.date;
        if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
          const nextDay = new Date(Date.parse(`${due}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
          const occurrences = await provider.calendar.listOccurrencesInWindow(`${due}T00:00:00Z`, `${nextDay}T00:00:00Z`);
          for (const occurrence of occurrences) {
            if (occurrence.status === "cancelled" || !occurrence.recurringEventId || occurrence.start?.date !== due
              || normalizedText(occurrence.summary).toLowerCase() !== normalizedText(task.content).toLowerCase()) continue;
            const master = await provider.calendar.getEvent(occurrence.recurringEventId);
            if (calendarRecurrenceMatchesTodoist(master, task)
              && (!master.extendedProperties?.shared?.taskId || master.extendedProperties.shared.taskId === task.id)) {
              existingMasterId = master.id;
              existingActiveInstanceId = occurrence.id;
              break;
            }
          }
        }
        preview.annualPlan = planStandaloneAnnualRepair(intent.profile, task, event, zone, new Date(), existingMasterId, existingActiveInstanceId);
        await verifyStandaloneAnnualOwnership(intent.profile, task, event, preview.annualPlan, provider, this.state);
      } catch (error) {
        invalidRepairIntent(error instanceof Error ? error.message : "Unsupported standalone Calendar recurrence repair");
      }
    }
    if (["link","transfer"].includes(intent.action) && (!task || !event)) invalidRepairIntent("Linking requires a live task and event");
    if (["link","transfer","create"].includes(intent.action) && event && event.status !== "confirmed") invalidRepairIntent("Calendar repair sources must be confirmed; choose a live event or exclude the cancelled item");
    if (["link","transfer","create"].includes(intent.action) && task?.is_deleted) invalidRepairIntent("Todoist repair sources must not be deleted; choose a live task or exclude the deleted item");
    const selectedTaskSnapshot = snapshots.find(snapshot => snapshot.ref.profile === intent.profile
      && snapshot.ref.side === "todoist" && snapshot.ref.id === intent.taskId);
    if (intent.action === "link" && task && event && selectedTaskSnapshot?.mapping
      && selectedTaskSnapshot.mapping.eventId !== event.id
      && !selectedTaskSnapshot.mapping.recurrenceOwner && !selectedTaskSnapshot.mapping.seriesId && !selectedTaskSnapshot.mapping.masterEventId
      && !event.recurringEventId && !event.recurrence?.length) {
      const oldEvent = snapshots.find(snapshot => snapshot.ref.profile === intent.profile
        && snapshot.ref.side === "calendar" && snapshot.ref.id === selectedTaskSnapshot.mapping!.eventId);
      if (oldEvent?.mapping?.taskId === task.id && oldEvent.mapping.eventId === selectedTaskSnapshot.mapping.eventId
        && intent.leftovers[entityKey(oldEvent.ref)] === "unchanged") {
        invalidRepairIntent(`Cannot leave the currently mapped Calendar event ${oldEvent.ref.id} and its mapping unchanged while linking Todoist task ${task.id} to ${event.id}; choose Exclude to retain the old event while detaching its obsolete mapping`);
      }
    }
    if (intent.action === "link" && intent.winner === "todoist") {
      try {
        if(event?.recurringEventId && intent.owner === "todoist") todoistOccurrenceProjection(task!,event!);
        else toCalendarEvent(task!, event!);
      } catch(error) { invalidRepairIntent(error instanceof Error ? error.message : "Todoist fields cannot be projected to this Calendar event"); }
    }
    if (intent.action === "link" && event?.recurringEventId && !intent.owner) invalidRepairIntent("Choose which provider owns the recurrence for this Calendar occurrence");
    if (intent.action === "link" && intent.owner === "todoist" && !task?.due?.is_recurring) invalidRepairIntent("Todoist recurrence ownership requires a recurring Todoist task");
    if (intent.action === "create" && Boolean(task) === Boolean(event)) invalidRepairIntent("Select just the item whose counterpart should be created");
    if (intent.action === "create" && event?.recurrence?.length && intent.owner !== "calendar") invalidRepairIntent("Creating a counterpart for a Calendar series requires Calendar recurrence ownership");
    if (intent.action === "create" && event?.recurringEventId && intent.owner !== "calendar") invalidRepairIntent("Creating a counterpart for a Calendar occurrence requires Calendar recurrence ownership");
    if (["link","transfer","create"].includes(intent.action) && event?.recurrence?.length && intent.owner === "calendar" && !masterSnapshot?.calendarProjectionId) invalidRepairIntent("Calendar series has no active occurrence to preview");
    if (intent.action === "decision") {
      if (!record.decision || !record.decision.permittedActions.some(a => a.id === intent.decisionAction) || intent.decisionAction === "reconcile_now") invalidRepairIntent("Select a permitted repair action; reconciliation is a separate explicit request");
      changes.push(`Apply ${intent.decisionAction} with the existing guarded executor`);
    } else if (intent.action === "move") {
      if (!task || !intent.targetProfile || !["home","antonio","work"].includes(intent.targetProfile) || intent.targetProfile === intent.profile) invalidRepairIntent("Select a different destination profile for this task");
      changes.push(`Move task to ${intent.targetProfile}; apply existing project-transition rules to its Calendar projection`);
      warnings.push("The source projection follows the existing project-move lifecycle, shown as displaced below.");
    } else if (intent.action === "transfer") {
      changes.push(`Preserve recurring Todoist task ${task!.id} exactly and transfer the Calendar-owned series association to its verified active occurrence`);
      changes.push(`Calendar series ${event!.id} and RRULE remain unchanged; no recurrence is created, split, or annualized`);
    } else if (intent.action === "link") {
      // Calendar occurrence projections are date-only. Applying one to an
      // existing recurring Todoist task can move its due date to that
      // occurrence and alter the recurring schedule. Refuse this occurrence
      // repair until it can preserve the Todoist recurrence anchor.
      if (task?.due?.is_recurring && !preview.annualPlan && intent.owner === "calendar"
        && event?.recurringEventId) {
        invalidRepairIntent("Cannot link a recurring Todoist task to a Calendar-owned series: this repair would replace its recurrence with a one-off due date. Preserve Todoist recurrence ownership or use a recurrence-preserving repair.");
      }
      if (intent.winner === "none" && !preview.annualPlan && !hasCanonicalState(event!, task!)) invalidRepairIntent("Fields differ: choose Todoist or Calendar as the source");
      if (event?.recurringEventId && intent.scope !== "occurrence") invalidRepairIntent("Choose the Calendar master to repair a whole series");
      if (event?.recurrence?.length) {
        if (!intent.owner) invalidRepairIntent("Choose which provider owns the recurrence");
        if (intent.owner === "todoist" && intent.scope !== "future") invalidRepairIntent("Changing a Calendar series to Todoist ownership requires a future-only preview");
        if (intent.owner === "calendar" && intent.winner === "todoist") invalidRepairIntent("Use Calendar fields for a Calendar-owned series; change a future series with the Todoist owner option");
        if (intent.owner === "todoist") {
          const zone = await (await this.clients(intent.profile)).calendar.getTimeZone();
          try {
            preview.splitPlan = planFutureSeriesSplit(intent.profile, task!, event, new Date(), zone);
          } catch (error) {
            invalidRepairIntent(error instanceof Error ? error.message : "Unsupported Calendar recurrence; manual review required");
          }
          const split = preview.splitPlan!;
          if (split.expiredUntil) {
            changes.push(`Existing Calendar RRULE expired on ${split.expiredUntil}; keep historical master ${split.oldMasterId} and its rule unchanged (no old occurrences will be manufactured)`);
          } else {
            changes.push(`Retain Calendar history through ${split.previousOccurrence}; cap existing future dates starting ${split.nextOldOccurrence}`);
          }
          changes.push(`Historical Calendar RRULE: ${split.originalRule} → ${split.truncatedRule}`);
          changes.push(`New future Calendar master starts ${split.newStart} in ${split.calendarTimeZone}: ${split.newRule}`);
        } else changes.push("Bind the next active Calendar occurrence; preserve the existing series and completed history");
      } else if (task?.due?.is_recurring && intent.owner !== "todoist" && !event?.recurringEventId) {
        invalidRepairIntent("Choose Todoist recurrence ownership for this recurring task, or use its existing recurrence resolution action");
      }
      if (preview.annualPlan) {
        const p = preview.annualPlan;
        changes.push(p.mode === "keep-history"
          ? `Keep standalone Calendar event ${p.sourceId} unchanged as an event on ${p.originalStart}–${p.originalEnd} (remove only its obsolete task-link metadata); create future annual master ${p.masterId}`
          : p.mode === "reuse-existing"
            ? `Keep standalone Calendar event ${p.sourceId} as history and reuse verified Todoist-owned annual master ${p.masterId}`
            : `Annualize Calendar event ${p.sourceId} in place without moving its date; retain its original occurrence as part of the series`);
        changes.push(`Calendar yearly series: DTSTART ${p.start}, DTEND ${p.end}, ${p.rule}, timezone ${p.timeZone}; master ID ${p.masterId}; map existing Todoist task ${task!.id} to its verified ${p.start} occurrence (Google instance ID verified at Apply)`);
      }
      changes.push(`Link Todoist task ${task!.id} to Calendar ${preview.annualPlan ? "annual series " + preview.annualPlan.masterId : "event " + event!.id}; ${intent.winner === "none" ? "retain matching fields" : `use ${intent.winner} fields`}`);
      if (intent.winner === "todoist" && !preview.splitPlan && !preview.annualPlan) {
        const desired=event?.recurringEventId && intent.owner === "todoist"
          ? todoistOccurrenceProjection(task!,event!) : toCalendarEvent(task!,event!);
        fieldChange("Calendar title",event!.summary,desired.summary);
        fieldChange("Calendar description",event!.description,desired.description);
        fieldChange("Calendar start",event!.start,desired.start);
        fieldChange("Calendar end (duration / multi-day span)",event!.end,desired.end);
      } else if (intent.winner === "calendar") {
        let desired: ReturnType<typeof toTodoistTask>;
        try { desired=toTodoistTask(calendarFieldSource!); }
        catch(error) { invalidRepairIntent(error instanceof Error ? error.message : "Calendar fields cannot be projected to this Todoist task"); }
        fieldChange("Todoist title",task!.content,desired.content);
        fieldChange("Todoist description",task!.description,desired.description);
        fieldChange("Todoist due date",task!.due,desired.due);
      }
    } else if (intent.action === "create") {
      const source=task || event!;
      changes.push(task ? `Create and link a new Calendar event from Todoist task ${task.id}` : `Create and link a new Todoist task from Calendar event ${event!.id}`);
      if(task) {
        const desired=toCalendarEvent(task);
        changes.push(`New Calendar fields: title ${show(desired.summary)}, description ${show(desired.description)}, start ${show(desired.start)}, end ${show(desired.end)}`);
      } else {
        let desired: ReturnType<typeof toTodoistTask>;
        try { desired=toTodoistTask(calendarFieldSource as CalendarEvent); }
        catch(error) { invalidRepairIntent(error instanceof Error ? error.message : "Calendar fields cannot be projected to a Todoist task"); }
        changes.push(`New Todoist fields: title ${show(desired.content)}, description ${show(desired.description)}, due ${show(desired.due)}`);
      }
    } else if (intent.action === "separate") changes.push(`Keep the selected Todoist task ${intent.taskId || "(none)"} and Calendar event ${intent.eventId || "(none)"} unlinked`);
    else if (intent.action === "exclude") changes.push("Exclude the selected provider items from future syncing");
    else if (intent.action === "verify") changes.push(`Verify the existing association between task ${intent.taskId || "(none)"} and event ${intent.eventId || "(none)"} without changing provider fields`);
    else changes.push(`${intent.action}: preserve the original provider items`);
    const chosen = new Set(intent.action === "todoist-only"
      ? [intent.taskId && `todoist:${intent.taskId}`]
      : [intent.taskId && `todoist:${intent.taskId}`, intent.eventId && `calendar:${intent.eventId}`]);
    if (preview.annualPlan?.mode === "reuse-existing" && preview.annualPlan.activeInstanceId) {
      chosen.add(`calendar:${preview.annualPlan.activeInstanceId}`);
      chosen.add(`calendar:${preview.annualPlan.masterId}`);
    }
    const seriesProjections = new Set(snapshots.filter(s => s.ref.side === "calendar" && s.calendarProjectionId
      && (intent.leftovers[entityKey(s.ref)] === "create" || s.ref.id === intent.eventId && ["link","transfer","create"].includes(intent.action)))
      .map(s => s.calendarProjectionId!));
    if (event?.recurrence?.length && masterSnapshot?.calendarProjectionId && ["link","transfer","create"].includes(intent.action)) {
      chosen.add(`calendar:${masterSnapshot.calendarProjectionId}`);
      if (intent.leftovers[entityKey({profile:intent.profile, side:"calendar", id:masterSnapshot.calendarProjectionId})]) invalidRepairIntent("The active occurrence belongs to the selected series repair and cannot have a separate disposition");
      changes.push(`Use active Calendar occurrence ${masterSnapshot.calendarProjectionId} for the resulting association`);
    }
    for (const s of snapshots) {
      const selected = chosen.has(`${s.ref.side}:${s.ref.id}`);
      const masterOfSelected = s.ref.side === "calendar" && event?.recurringEventId === s.ref.id;
      const selectedProjection = s.ref.side === "calendar" && seriesProjections.has(s.ref.id);
      if (selectedProjection && intent.leftovers[entityKey(s.ref)]) invalidRepairIntent("An occurrence handled by a series repair cannot have a separate disposition");
      if (intent.action === "flatten" && s.mapping && s.ref.side === "calendar" && (s.object as CalendarEvent|null)?.status === "cancelled") continue;
      if (intent.action === "todoist-only" && selected && s.ref.side === "todoist") continue;
      if (["flatten","link","transfer"].includes(intent.action) && selected || selectedProjection || ["decision","verify","move"].includes(intent.action) || masterOfSelected) continue;
      const todoistHistory = intent.action === "todoist-only" && s.ref.side === "calendar" && s.ref.id === intent.eventId;
      const disposition = todoistHistory ? "unchanged"
        : intent.action === "exclude" && selected ? "exclude" : intent.action === "create" && selected ? "create" : intent.leftovers[entityKey(s.ref)];
      if (s.object && !disposition) invalidRepairIntent(`Choose Create counterpart, Exclude, Leave unchanged, or Retain unlinked for ${entityKey(s.ref)}`);
      if (s.object && disposition === "create") {
        if (s.ref.side === "todoist") {
          if ((s.object as TodoistTask).is_deleted) invalidRepairIntent(`Todoist repair source ${entityKey(s.ref)} must not be deleted`);
          toCalendarEvent(s.object as TodoistTask);
        } else if ((s.object as CalendarEvent).status !== "confirmed") invalidRepairIntent(`Calendar repair source ${entityKey(s.ref)} must be confirmed`);
      }
      if (s.object && disposition === "create") {
        const title=(s.object as TodoistTask).content || (s.object as CalendarEvent).summary || s.ref.id;
        changes.push(s.ref.side === "todoist"
          ? `Create a new Calendar counterpart from Todoist task ${s.ref.id} (${title}) and link that new pair`
          : `Create a new Todoist counterpart from Calendar event ${s.ref.id} (${title}) and link that new pair`);
      } else if (s.object && disposition === "exclude") changes.push(`Exclude ${s.ref.side} item ${s.ref.id} from future syncing`);
      else if (s.object && disposition === "unchanged") changes.push(`Leave ${s.ref.side} item ${s.ref.id} unchanged`);
      else if (s.object && disposition === "retain-unlinked") changes.push(`Retain ${s.ref.side} item ${s.ref.id} unchanged and detach its exact obsolete mapping`);
    }
    for (const s of snapshots) {
      const key = entityKey(s.ref);
      const selected = chosen.has(`${s.ref.side}:${s.ref.id}`);
      const projection = s.ref.side === "calendar" && seriesProjections.has(s.ref.id);
      const parent = s.ref.side === "calendar" && event?.recurringEventId === s.ref.id;
      const todoistHistory = intent.action === "todoist-only" && s.ref.side === "calendar" && s.ref.id === intent.eventId;
      const disposition = todoistHistory ? "unchanged"
        : intent.action === "exclude" && selected ? "exclude"
        : intent.action === "create" && selected ? "create" : intent.leftovers[key];
      let operation: string, result: string;
      if (intent.action === "flatten" && s.ref.side === "calendar" && s.ref.id === preview.flattenPlan!.standaloneId && !s.object) {
        operation = "Create deterministic standalone Calendar event";
        result = `Create ${s.ref.id} on ${preview.flattenPlan!.start}–${preview.flattenPlan!.end}; atomically link it to task ${intent.taskId}`;
      } else if (!s.object) {
        operation = "Missing provider object — no provider write";
        result = s.mapping ? "Stale association detached as part of repair; Calendar history retained" : "No live provider object or association";
      } else if (projection) {
        operation = "Use active Calendar occurrence for selected series";
        result = "Included in the resulting recurrence association";
      } else if (parent && intent.action === "flatten") {
        operation = preview.flattenPlan!.mode === "cap-history" ? "Cap historical master and archive its sync identity" : "Convert master to selected standalone occurrence";
        result = preview.flattenPlan!.mode === "cap-history" ? `${preview.flattenPlan!.cappedRule}; retain historical dates and remove recurrence ownership mapping` : "Remove RRULE; retain the exact selected date and unrelated metadata";
      } else if (parent) {
        operation = "Retain recurring master as occurrence context";
        result = "Existing series history retained";
      } else if (intent.action === "verify") {
        operation = "Verify existing association";
        result = "Retain verified mapping; no provider fields changed";
      } else if (intent.action === "todoist-only" && s.ref.side === "todoist" && selected) {
        operation = "Make the Todoist task a one-off and exclude it from Calendar projection";
        result = `Keep due date ${task!.due!.date}; remove only its recurrence and retain the Calendar history unlinked`;
      } else if (todoistHistory) {
        operation = "Retain historical Calendar item and exclude it from syncing";
        result = "Preserve the provider object byte-for-byte; prevent it from importing or linking a Todoist counterpart";
      } else if (intent.action === "decision") {
        operation = "Apply existing guarded decision";
        result = "See decision executor details in planned changes";
      } else if (intent.action === "move") {
        operation = selected ? "Move Todoist task" : "Handle existing Calendar projection";
        result = selected ? `Move to ${intent.targetProfile}; remap projection there` : "Use existing project-move lifecycle";
      } else if (intent.action === "flatten" && selected) {
        operation = "Flatten exact occurrence to a verified one-off pair";
        result = `Map task ${intent.taskId} to standalone ${preview.flattenPlan!.standaloneId}; remove recurrence on both providers`;
      } else if (intent.action === "transfer" && selected) {
        operation = "Transfer existing Calendar series to recurring Todoist task";
        result = `Preserve Todoist recurrence and map task ${intent.taskId} to active Calendar occurrence ${masterSnapshot?.calendarProjectionId} under master ${intent.eventId}`;
      } else if (intent.action === "link" && selected) {
        operation = "Link selected provider object";
        const activeCalendarId = preview.annualPlan?.masterId || (event?.recurrence?.length && intent.owner === "calendar" && masterSnapshot?.calendarProjectionId
          ? masterSnapshot.calendarProjectionId : intent.eventId);
        result = `Map Todoist ${intent.taskId} ↔ Calendar ${activeCalendarId}${activeCalendarId !== intent.eventId ? ` (series master ${intent.eventId})` : ""}${intent.owner ? ` (recurrence owner: ${intent.owner}, scope: ${intent.scope})` : ""}`;
      } else if (disposition === "create") {
        operation = "Create a new counterpart";
        const sourceEventId = s.ref.side === "calendar" && event?.recurrence?.length && s.ref.id === event.id && intent.owner === "calendar"
          ? masterSnapshot?.calendarProjectionId : undefined;
        result = `Create ${s.ref.side === "todoist" ? "Calendar event" : "Todoist task"} and map it to ${sourceEventId ? `active Calendar occurrence ${sourceEventId} (series master ${s.ref.id})` : key}`;
      } else if (disposition === "exclude") {
        operation = "Exclude from syncing";
        result = "Remove any displaced mapping and mark this provider object excluded";
      } else if (disposition === "unchanged") {
        operation = "Leave unchanged";
        result = "Retain provider object, mapping, and sync control without changes";
      } else if (disposition === "retain-unlinked") {
        operation = "Retain provider item and detach its old mapping";
        result = "Keep this exact provider object unchanged; detach only its obsolete mapping, ownership, comments, and baseline links";
      } else if (selected && intent.action === "separate") {
        operation = "Keep selected items separate";
        result = "Remove existing association; do not link the selected pair";
      } else {
        operation = "No provider mutation";
        result = s.mapping ? "Existing association handled by repair" : "No association";
      }
      preview.itemPlan.push({ref:s.ref, operation, result});
    }
    if (intent.action !== "verify") {
      for (const s of snapshots) {
        if (s.mapping && intent.leftovers[entityKey(s.ref)] !== "unchanged") {
          changes.push(`Replace existing association ${s.mapping.taskId} ↔ ${s.mapping.eventId}`);
        }
      }
    }
    warnings.push("Past Calendar occurrences and audit records are retained. Old associations cannot be recovered automatically.");
    await this.store.putPreview(preview); return preview;
  }
  async execute(id: string): Promise<RepairOperation> {
    const operation = await this.store.getOperation(id); if (!operation) throw new Error("Repair not found");
    if (operation.status === "succeeded") return operation;
    // Already-abandoned deliveries are terminal: complete the FIFO receipt rather than
    // throwing a 409 into the dead-letter queue on retry/redelivery.
    if (operation.abandoned) return operation;
    let { intent } = operation.preview;
    const state = new StateRepository(id);
    const rawFactory = this.clients;
    const budget = new ReconciliationMutationBudget(20);
    const factory = guardRepairProviders(operation, createBudgetedClientFactory(budget, rawFactory), async () => {
      operation.writeStarted = true;
      await this.store.saveOperation(operation);
    });
    let claimed = false;
    const queueDeferredRefresh = async (refs:EntityRef[]) => this.queueDeferredRefresh(refs,state);
    // Legacy failed operations can predate the durable abandoned marker. Do not
    // replay them unless persisted execution state proves a write may have begun.
    if (["failed", "needs_review"].includes(operation.status) && !operationHasWriteEvidence(operation)) {
      const snapshots = [...operation.preview.snapshots, ...(operation.claimSnapshots || [])];
      const refs = snapshots.map(snapshot => snapshot.ref);
      const queued = await queueDeferredRefresh(refs);
      await this.controls.releaseUnapplied(refs, operation.id, snapshots, {
        error: operation.error || "No provider write was recorded",
        nextAction: "No provider write is recorded. Refresh affected items and create a new preview; this failed operation remains immutable for audit.",
      }, queued);
      operation.abandoned = true;
      return operation;
    }
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const saved = operation.steps[name];
      if (saved?.status === "done") return saved.result as T;
      if (saved && Date.now()-Date.parse(saved.startedAt) > 23*3600000 && name.startsWith("create-task")) throw new Error("Task creation acknowledgement is uncertain and its idempotency window expired; inspect provider state before retrying");
      // Persist the side-effect boundary with the checkpoint before running it.
      // releaseUnapplied conditions on this marker to race safely with retries.
      if (name !== "validated") operation.writeStarted = true;
      operation.steps[name] = { id: name, status: "running", startedAt: saved?.startedAt || at() }; await this.store.saveOperation(operation);
      const result = await run(); operation.steps[name] = { ...operation.steps[name], status: "done", result: result ?? null, completedAt: at() }; await this.store.saveOperation(operation); return result;
    };
    try {
      intent = decisionRepairIntent(intent, operation.preview.case.decision);
      const targetTaskRef: EntityRef | undefined = intent.action === "move" && intent.targetProfile && intent.taskId
        ? { profile:intent.targetProfile, side:"todoist", id:intent.taskId } : undefined;
      // Move claims a destination-profile task barrier not included in the
      // source profile preview. Save its original control state before claiming,
      // so even a no-write validation failure can release the entire lock set.
      if (targetTaskRef && !operation.claimSnapshots?.length) {
        operation.claimSnapshots = [{
          ref: targetTaskRef, object: null, control: await this.controls.control(targetTaskRef) as Record<string, unknown> | undefined,
        }];
        await this.store.saveOperation(operation);
      }
      await this.controls.claim([...operation.preview.snapshots.map(s=>s.ref), ...(targetTaskRef?[targetTaskRef]:[])], id);
      claimed = true;
      if (!operation.steps.validated) {
        const current = await this.collect(intent, operation.preview.case.decision);
        if (snapshotFingerprint(current) !== operation.preview.fingerprint) throw new Error("Provider state or ownership changed after preview. Refresh the preview; no repair was applied.");
        operation.steps.validated = { id:"validated", status:"done", startedAt:at(), completedAt:at() };
        await this.store.saveOperation(operation);
      }
      operation.status = "running"; await this.store.saveOperation(operation);
      await this.store.updateCase(intent.caseId, "repairing", "Repair in progress", id);
      const verified: NonNullable<RepairOperation["verified"]> = [];
      const recurrenceBindings: Mapping[] = [];
      const verifyStandaloneMapping = async (mapping:Mapping) => {
        const values = await Promise.all([state.getMappingByTask(mapping.profile,mapping.taskId),state.getMappingByTaskAnyProfile(mapping.taskId),state.getMappingByEvent(mapping.profile,mapping.eventId)]);
        if (values.some(m=>!m || m.profile!==mapping.profile || m.taskId!==mapping.taskId || m.eventId!==mapping.eventId || m.recurrenceOwner || m.seriesId || m.masterEventId)) throw new Error("Flatten standalone mapping indexes changed or disagree");
      };
      const recordVerified = (mapping: Mapping) => {
        verified.push({profile:mapping.profile,taskId:mapping.taskId,eventId:mapping.eventId});
        if (mapping.recurrenceOwner && mapping.masterEventId) recurrenceBindings.push(mapping);
      };
      const bindings = new Map<string, string>();
      const matchesExpectedAfterDetach = (snapshot: ReviewSnapshot, current: ReviewSnapshot): boolean => {
        const mapping = snapshot.mapping;
        let expected = mapping && operation.steps[`detach:${mapping.profile}:${mapping.taskId}`]?.status === "done"
          ? { ...snapshot, mapping:undefined } : snapshot;
        const recurrence = snapshot.recurrence;
        if (recurrence && operation.steps[`detach:${snapshot.ref.profile}:${recurrence.taskId}`]?.status === "done"
          && operation.preview.snapshots.some(s => s.mapping?.profile === snapshot.ref.profile && s.mapping.taskId === recurrence.taskId
            && s.mapping.seriesId === recurrence.seriesId && s.mapping.recurrenceOwner === recurrence.owner && s.mapping.masterEventId === recurrence.masterEventId)) {
          expected = { ...expected, recurrence:undefined, calendarProjectionId:undefined };
          current = { ...current, calendarProjectionId:undefined };
        }
        return snapshotFingerprint([expected]) === snapshotFingerprint([current]);
      };
      const pair = await factory(intent.profile);
      const taskSnapshot = operation.preview.snapshots.find(s=>s.ref.profile===intent.profile && s.ref.side==="todoist" && s.ref.id===intent.taskId);
      const eventSnapshot = operation.preview.snapshots.find(s=>s.ref.profile===intent.profile && s.ref.side==="calendar" && s.ref.id===intent.eventId);
      const originalTask = taskSnapshot?.object as TodoistTask | undefined;
      const originalEvent = eventSnapshot?.object as CalendarEvent | undefined;
      const splitHistoryMasterId = (snapshot: ReviewSnapshot) => operation.preview.splitPlan && snapshot.ref.side === "calendar"
        && (snapshot.ref.id === intent.eventId || (snapshot.object as CalendarEvent|null)?.recurringEventId === intent.eventId) ? intent.eventId : undefined;
      const standaloneHistory = (snapshot: ReviewSnapshot) => Boolean(operation.preview.annualPlan
        && operation.preview.annualPlan.mode !== "annualize-in-place"
        && snapshot.ref.side === "calendar" && snapshot.ref.id === operation.preview.annualPlan.sourceId);
      const writeGate = async (profile: Profile) => { if (!await state.mutationAllowed(profile)) throw new Error("Mutation circuit is open. Wait for it to cool down, then resume this repair."); };
      const trackedWrite = async <T>(profile: Profile, run: () => Promise<T>, count: number | ((result: T) => number) = 1): Promise<T> => {
        await writeGate(profile);
        const result = await run();
        const writes=typeof count==="function"?count(result):count;
        for (let i = 0; i < writes; i += 1) await state.recordMutation(profile);
        return result;
      };
      const bind = async (profile: Profile, task: TodoistTask, event: CalendarEvent, owner?: "todoist"|"calendar") => {
        let mapping: Mapping = { profile, taskId: task.id, eventId: event.id, projectId: task.project_id || profiles[profile].todoistProjectId, updatedAt: at() };
        let projection = event;
        const clients = await factory(profile);
        if ((event.recurrence?.length || event.recurringEventId) && owner === "calendar") {
          const master=event.recurringEventId?await clients.calendar.getEvent(event.recurringEventId):event;
          const seriesId = master.iCalUID || master.id;
          const existing = await state.getRecurrenceLink(profile, seriesId)
            || operation.preview.snapshots.find(s=>s.ref.profile===profile && s.ref.side==="calendar" && s.ref.id===master.id)?.recurrence;
          projection = selectCalendarRecurrenceInstance(await clients.calendar.listInstances(master.id), existing)!;
          if (!projection) throw new Error("Calendar series has no verifiable active occurrence");
          const approvedProjection = operation.preview.snapshots.find(s=>s.ref.profile===profile && s.ref.side==="calendar" && s.ref.id===master.id)?.calendarProjectionId;
          if (approvedProjection && projection.id !== approvedProjection && !["decision","move"].includes(intent.action)) throw new Error("The Calendar series active occurrence changed after preview; refresh the repair before changing its counterpart");
          mapping = { ...mapping, eventId: projection.id, recurrenceOwner:"calendar", seriesId, masterEventId:master.id, activeInstanceId:projection.id,
            originalStart:projection.originalStartTime?.dateTime || projection.originalStartTime?.date || projection.start?.dateTime || projection.start?.date,
            activeEffectiveStart:projection.start?.dateTime || projection.start?.date, calendarProgressVersion:existing?.calendarProgressVersion ?? 1,
            completedThroughOriginalStart:existing?.completedThroughOriginalStart };
          task = await step(`series-task:${task.id}`, async()=> trackedWrite(profile, () => clients.todoist.upsertTask(toTodoistTask(projection),task.id)));
        } else if (task.due?.is_recurring) {
          const master=(event.recurringEventId?await clients.calendar.getEvent(event.recurringEventId):event);
          const hasMasterRecurrence=Boolean(master.recurrence?.length);
          mapping = { ...mapping, recurrenceOwner:"todoist", seriesId:task.id, masterEventId:hasMasterRecurrence ? master.id : undefined };
          if(hasMasterRecurrence) {
            mapping.eventId=master.id;
            const instances = await clients.calendar.listInstances(master.id);
            projection = selectTodoistCurrentInstance(instances, task, (await state.getRecurrenceLink(profile, task.id))?.activeInstanceId)!;
            if(!projection) throw new Error("Todoist-owned Calendar series has no active occurrence");
            mapping.activeInstanceId=projection.id; mapping.originalStart=projection.originalStartTime?.dateTime || projection.originalStartTime?.date || projection.start?.dateTime || projection.start?.date;
            mapping.activeEffectiveStart=projection.start?.dateTime || projection.start?.date;
          }
        }
        const stored = await step(`metadata:${profile}:${event.id}`, async()=> {
          const metadataEventId=mapping.recurrenceOwner === "calendar" ? projection.id : mapping.masterEventId||event.id;
          const live=await clients.calendar.getEvent(metadataEventId);
          return trackedWrite(profile, () => clients.calendar.upsertEventIfUnchanged({ ...live, extendedProperties:{...live.extendedProperties,shared:{...live.extendedProperties?.shared,taskId:task.id,taskUrl:`https://app.todoist.com/app/task/${task.id}`,syncSource:"todoist-calendar-sync",...(mapping.recurrenceOwner?{syncRecurrenceOwner:mapping.recurrenceOwner}:{})}} },live.id,live.etag!));
        });
        mapping = await step(`comments:${profile}:${task.id}`, async()=> trackedWrite(profile, () => upsertProjectMappingComment(clients.todoist,mapping,mapping.projectId!,stored.htmlLink), 2));
        await this.controls.allow(profile,task.id,event.id);
        if (mapping.eventId !== event.id) await this.controls.allow(profile,task.id,mapping.eventId);
        await state.putMapping(mapping);
        if(mapping.seriesId && mapping.recurrenceOwner) await state.putRecurrenceLink({profile,owner:mapping.recurrenceOwner,seriesId:mapping.seriesId,taskId:mapping.taskId,eventId:mapping.eventId,masterEventId:mapping.masterEventId,activeInstanceId:mapping.activeInstanceId,originalStart:mapping.originalStart,activeEffectiveStart:mapping.activeEffectiveStart,calendarProgressVersion:mapping.calendarProgressVersion,completedThroughOriginalStart:mapping.completedThroughOriginalStart,updatedAt:at()});
        bindings.set(entityKey({profile,side:"todoist",id:task.id}),event.id);bindings.set(entityKey({profile,side:"calendar",id:event.id}),task.id);bindings.set(entityKey({profile,side:"calendar",id:projection.id}),task.id);
        const [liveTask,liveEvent] = await Promise.all([clients.todoist.getTask(task.id),clients.calendar.getEvent(projection.id)]);
        if (mapping.recurrenceOwner === "todoist" && mapping.masterEventId) {
          const master = await clients.calendar.getEvent(mapping.masterEventId);
          if (!calendarRecurrenceMatchesTodoist(master, liveTask) || !recurrenceAnchorMatches(master) || !occurrenceStateMatches(liveEvent, liveTask)) {
            throw new Error("Todoist recurrence, Calendar master, or active occurrence changed during repair; review the live values before continuing");
          }
        } else if(!hasCanonicalState(liveEvent,liveTask)) throw new Error("Provider fields changed during repair; review the live values before continuing");
        await new DynamoReconciliationStore().putBaseline(profile,task.id,liveTask,liveEvent);
        const identities=new CanonicalIdentityStore(); const ti=todoistCanonicalIdentity(liveTask),ei=calendarCanonicalIdentity(liveEvent);
        if(ti)await identities.put(profile,"todoist",task.id,ti);if(ei)await identities.put(profile,"calendar",projection.id,ei);
        await state.deleteCalendarProjectionTombstone(profile,task.id);
        await state.resolveConflictAudits(profile,{taskId:task.id,eventId:event.id});
        recordVerified(mapping);
      };
      if(intent.action === "decision") {
        await step("decision",async()=> {
          const source=operation.preview.case.decision!;
          const decisions=new ManualDecisionStore();
          const { status: _status, createdAt: _createdAt, decisionDeadline: _deadline, ...pending } = source;
          const {decision}=await decisions.putPending({...pending,decisionId:`review-${id}`});
          const created = Object.values(operation.creations || {}).filter(c => c.profile === intent.profile && c.result);
          const recoveredTaskId = created.find(c => c.side === "todoist")?.result?.id || intent.taskId;
          const recoveredEventId = created.find(c => c.side === "calendar")?.result?.id || intent.eventId;
          if (created.length && recoveredTaskId && recoveredEventId) {
            const [task,event,taskOwner,eventOwner] = await Promise.all([pair.todoist.getTask(recoveredTaskId),pair.calendar.getEvent(recoveredEventId),state.getMappingByTaskAnyProfile(recoveredTaskId),state.getMappingByEvent(intent.profile,recoveredEventId)]);
            for (const owner of [taskOwner,eventOwner]) if (owner && (owner.taskId !== recoveredTaskId || owner.eventId !== recoveredEventId)) {
              if (!operation.preview.snapshots.some(s => s.mapping?.profile === owner.profile && s.mapping.taskId === owner.taskId && s.mapping.eventId === owner.eventId)) throw new Error("A recovered counterpart is now owned by an unapproved association");
              await state.deleteMapping(owner);
              if (owner.seriesId) await state.deleteRecurrenceLink(owner.profile,owner.seriesId);
            }
            await bind(intent.profile,task,event,source.mappingSnapshot?.recurrenceOwner || taskSnapshot?.mapping?.recurrenceOwner || eventSnapshot?.mapping?.recurrenceOwner || (event.recurrence?.length || event.recurringEventId ? "calendar" : task.due?.is_recurring ? "todoist" : undefined));
            await new ManualInterventionService(decisions,undefined,factory).finishReconciliationDecision(decision.decisionId,"Recovered and verified the previously created counterpart");
            return { ...decision,status:"resolved" };
          }
          await new ManualInterventionService(decisions,undefined,factory).processManualDelivery({id:`review-action:${id}`,kind:"manual",profile:intent.profile,mode:"aws",receivedAt:at(),headers:{},body:"",manual:{decisionId:decision.decisionId,action:intent.decisionAction,slackUserId:undefined}},state);
          const after=await decisions.get(decision.decisionId); if(after?.status!=="resolved")throw new Error("Guarded action requires further review; inspect the decision result");
          return after;
        });
        const mapping=(intent.taskId?await state.getMappingByTask(intent.profile,intent.taskId):undefined)
          || (intent.eventId?await state.getMappingByEvent(intent.profile,intent.eventId):undefined);
        if (!mapping && (["create_new_task","restore_todoist_task","calendar_wins","todoist_wins","use_calendar_version","use_todoist_recurrence"].includes(intent.decisionAction!) || intent.decisionAction?.startsWith("bind_task:"))) throw new Error("The decision did not produce a verifiable mapping; review the provider result");
        if(mapping && !verified.some(v => v.profile === mapping.profile && v.taskId === mapping.taskId))await bind(intent.profile,await pair.todoist.getTask(mapping.taskId),await pair.calendar.getEvent(mapping.masterEventId||mapping.eventId),mapping.recurrenceOwner);
      } else if(intent.action==="move") {
        if (!operation.steps["move-project"] || operation.steps["move-project"].status !== "done") await (await factory(intent.targetProfile!)).calendar.findByTodoistTaskId(originalTask!.id);
        await step("move-project",async()=> trackedWrite(intent.profile, () => pair.todoist.moveTask(originalTask!.id,profiles[intent.targetProfile!].todoistProjectId)));
        await step("move-projection",async()=> {
          const moved=await pair.todoist.getTask(originalTask!.id);
          await new ProjectAwareSynchronizer(state,undefined,factory).process({id:`review-move:${id}`,kind:"todoist",profile:intent.profile,mode:"aws",receivedAt:at(),headers:{},body:JSON.stringify({event_name:"item:updated",event_data:moved,event_data_extra:{old_item:originalTask}})});return true;
        });
        const mapping=await state.getMappingByTaskAnyProfile(originalTask!.id);if(!mapping||mapping.profile!==intent.targetProfile)throw new Error("Project move is not verified");
        const destination=await factory(mapping.profile);await bind(mapping.profile,await destination.todoist.getTask(mapping.taskId),await destination.calendar.getEvent(mapping.masterEventId||mapping.eventId),mapping.recurrenceOwner);
      } else if (intent.action === "flatten") {
        const plan = operation.preview.flattenPlan!;
        if (!plan || !originalTask || !originalEvent) throw new Error("Missing approved flatten plan");
        const masterSnapshot = operation.preview.snapshots.find(s=>s.ref.side==="calendar" && s.ref.id===plan.masterId)!;
        const originalMaster = masterSnapshot.object as CalendarEvent;
        const previous = [...new Map(operation.preview.snapshots.filter(s=>s.mapping && intent.leftovers[entityKey(s.ref)] !== "unchanged").map(s=>[s.mapping!.taskId,s.mapping!])).values()];
        const links = [...new Map(operation.preview.snapshots.filter(s=>s.recurrence).map(s=>[s.recurrence!.seriesId,s.recurrence!])).values()];
        if (!operation.steps["flatten-master"]) {
          const instances = await pair.calendar.listInstancesInWindow(plan.masterId,originalMaster.start!.date!+"T00:00:00Z",plan.end+"T00:00:00Z");
          assertFlattenInstances(await pair.calendar.getEvent(plan.masterId),instances);
          if (reviewHash(instances.map(item=>item.id).sort())!==reviewHash(plan.verifiedInstanceIds)) throw new Error("Calendar series expansion changed after flatten preview");
          if ((await pair.calendar.listExplicitSeriesExceptions(plan.masterId)).length) throw new Error("Explicit Calendar series exceptions appeared after preview");
          await state.assertHistoricalSeriesUnowned(plan.masterId,plan.verifiedInstanceIds!,{mapping:previous.find(m=>m.masterEventId===plan.masterId || m.eventId===plan.occurrenceId),link:links.find(l=>l.masterEventId===plan.masterId)});
        }
        await step("flatten-master",async()=> {
          const live = await pair.calendar.getEvent(plan.masterId);
          try { assertFlattenedMaster(plan,live); return live; } catch { /* The approved transformation is still needed. */ }
          return trackedWrite(intent.profile,()=>pair.calendar.upsertEventIfUnchanged(flattenMasterProjection(plan,live,originalEvent),live.id,live.etag!));
        });
        const standalone = plan.mode === "flatten-master" ? await pair.calendar.getEvent(plan.masterId) : await step("flatten-standalone",async()=> {
          const event = await trackedWrite(intent.profile,()=>pair.calendar.createRepairEventOnce(flattenStandalone(plan,originalEvent),id));
          if (event.recurrence?.length || event.recurringEventId || !hasCanonicalState(event,{...toTodoistTask(originalEvent),id:originalTask.id})
            || event.end?.date!==plan.end || event.extendedProperties?.shared?.syncFlattenOccurrenceId!==plan.occurrenceId || event.extendedProperties?.shared?.taskId!==originalTask.id) throw new Error("Standalone creation does not match the approved flatten occurrence");
          return event;
        });
        const flattenedTask = await step("flatten-task",async()=> {
          const live = await pair.todoist.getTask(originalTask.id);
          if (!live.due?.is_recurring && hasCanonicalState(standalone,live)) return live;
          const task = await trackedWrite(intent.profile,()=>pair.todoist.upsertTask(toTodoistTask(standalone),originalTask.id));
          if (task.due?.is_recurring || !hasCanonicalState(standalone,task)) throw new Error("Todoist did not confirm the approved one-off due date");
          return task;
        });
        let mapping: Mapping = {profile:intent.profile,eventId:standalone.id,taskId:flattenedTask.id,projectId:flattenedTask.project_id,updatedAt:operation.preview.createdAt};
        mapping = await step("flatten-comment",async()=> trackedWrite(intent.profile,()=>upsertProjectMappingComment(pair.todoist,mapping,mapping.projectId!,standalone.htmlLink),2));
        await step("flatten-mapping",async()=> {
          if (!await state.commitFlattenMapping({operationId:id,mapping,previous,links})) throw new Error("Flatten mapping ownership changed; repair barriers retained");
          return true;
        });
        await verifyStandaloneMapping(mapping);
        for (const link of links) if (await state.getRecurrenceLink(link.profile,link.seriesId)) throw new Error("Obsolete recurrence state survived flatten transition");
        for (const previousMapping of previous) await new DynamoReconciliationStore().deleteBaseline(previousMapping.profile,previousMapping.taskId);
        assertFlattenedMaster(plan,await pair.calendar.getEvent(plan.masterId));
        const currentTask = await pair.todoist.getTask(flattenedTask.id), currentEvent = await pair.calendar.getEvent(standalone.id);
        if (currentTask.due?.is_recurring || currentEvent.recurrence?.length || currentEvent.recurringEventId || !hasCanonicalState(currentEvent,currentTask)) throw new Error("Flatten provider readback failed");
        await new DynamoReconciliationStore().putBaseline(intent.profile,currentTask.id,currentTask,currentEvent);
        const identities = new CanonicalIdentityStore(), ti=todoistCanonicalIdentity(currentTask), ei=calendarCanonicalIdentity(currentEvent);
        if (ti) await identities.put(intent.profile,"todoist",currentTask.id,ti);
        if (ei) await identities.put(intent.profile,"calendar",currentEvent.id,ei);
        await state.deleteCalendarProjectionTombstone(intent.profile,currentTask.id);
        await this.controls.allow(intent.profile,currentTask.id,currentEvent.id);
        bindings.set(entityKey({profile:intent.profile,side:"todoist",id:currentTask.id}),currentEvent.id);
        bindings.set(entityKey({profile:intent.profile,side:"calendar",id:currentEvent.id}),currentTask.id);
        recordVerified(mapping);
      } else if (intent.action === "todoist-only") {
        if (!originalTask || !originalEvent) throw new Error("Missing approved Todoist-only flatten items");
        const dueDate = originalTask.due?.date;
        if (!dueDate) throw new Error("The approved Todoist task no longer has its one-off due date");
        const [preflightTask,preflightEvent] = await Promise.all([
          pair.todoist.getTask(originalTask.id), pair.calendar.getEvent(originalEvent.id),
        ]);
        if (reviewHash(preflightTask) !== reviewHash(originalTask) || reviewHash(preflightEvent) !== reviewHash(originalEvent)) {
          throw new Error("Todoist task or historical Calendar item changed after preview; refresh affected items");
        }
        await step(`todoist-only-exclude:${originalTask.id}`, async () => {
          await this.controls.exclude({profile:intent.profile,side:"todoist",id:originalTask.id},true,id);
          return true;
        });
        await step(`todoist-only-exclude-history:${originalEvent.id}`, async () => {
          await this.controls.exclude({profile:intent.profile,side:"calendar",id:originalEvent.id},true,id);
          return true;
        });
        const flattened = await step(`todoist-only-task:${originalTask.id}`, async () => {
          const live = await pair.todoist.getTask(originalTask.id);
          if (!live.due?.is_recurring && live.due?.date === dueDate && !live.due?.datetime) return live;
          const {id:_id,...payload} = live;
          payload.due = {date:dueDate};
          const updated = await trackedWrite(intent.profile, () => pair.todoist.upsertTask(payload,live.id));
          if (updated.due?.is_recurring || updated.due?.datetime || updated.due?.date !== dueDate) {
            throw new Error("Todoist did not confirm the approved one-off due date");
          }
          return updated;
        });
        await step(`todoist-only-version-fence:${flattened.id}`, async () => {
          await state.acceptTaskVersion(intent.profile,flattened.id,flattened.updated_at,`review:${id}`);
          return true;
        });
        const [finalTask,finalEvent] = await Promise.all([
          pair.todoist.getTask(flattened.id), pair.calendar.getEvent(originalEvent.id),
        ]);
        if (finalTask.due?.is_recurring || finalTask.due?.datetime || finalTask.due?.date !== dueDate
          || finalEvent.id !== originalEvent.id || reviewHash(finalEvent) !== reviewHash(originalEvent)) {
          throw new Error("Todoist-only flatten or unchanged Calendar history failed readback verification");
        }
        if (!(await this.controls.control({profile:intent.profile,side:"todoist",id:flattened.id}))?.excluded) {
          throw new Error("Todoist-only projection exclusion did not persist");
        }
      } else if (intent.action === "transfer") {
        const master = originalEvent;
        const targetTask = originalTask;
        const masterState = eventSnapshot?.recurrence;
        const activeId = eventSnapshot?.calendarProjectionId;
        if (!master || !targetTask || !activeId || !targetTask.due?.is_recurring || !targetTask.due.string) throw new Error("The approved series transfer no longer has its recurring task or active occurrence");
        const originalDue = reviewHash(targetTask.due);
        const originalRule = reviewHash(master.recurrence);
        const occurrenceSnapshot = operation.preview.snapshots.find(s => s.ref.side === "calendar" && s.ref.id === activeId);
        const originalOccurrence = occurrenceSnapshot?.object as CalendarEvent | null | undefined;
        if (!occurrenceSnapshot || !originalOccurrence || originalOccurrence.recurringEventId !== master.id) throw new Error("The approved active occurrence is missing or no longer belongs to the selected master");
        const seriesId = master.iCalUID || master.id;
        if (!(masterState?.owner === "calendar" && masterState.seriesId === seriesId)
          && master.extendedProperties?.shared?.syncRecurrenceOwner !== "calendar") throw new Error("Calendar series ownership is no longer verified; no transfer was applied");
        const previous = masterState?.taskId && masterState.taskId !== targetTask.id
          ? operation.preview.snapshots.map(s => s.mapping).find(m => m?.taskId === masterState.taskId && m.seriesId === seriesId
            && m.recurrenceOwner === "calendar" && [master.id, activeId].includes(m.eventId))
          : undefined;
        if (masterState?.taskId && masterState.taskId !== targetTask.id && !previous) throw new Error("The displaced series mapping changed after preview; refresh affected items");
        if (operation.preview.snapshots.some(s => s.mapping && s.mapping.taskId !== previous?.taskId
          && (s.mapping.masterEventId === master.id || s.mapping.eventId === master.id || s.mapping.activeInstanceId === activeId))) {
          throw new Error("A competing mapping now owns this Calendar series or occurrence; no transfer was applied");
        }
        const exactDisposition = previous && intent.leftovers[entityKey({profile:previous.profile,side:"todoist",id:previous.taskId})];
        if (previous && !["retain-unlinked","exclude","create"].includes(String(exactDisposition))) throw new Error("Choose an explicit disposition for the exact displaced Todoist task before transfer");
        const transferMapping: Mapping = {
          profile:intent.profile, taskId:targetTask.id, eventId:activeId,
          projectId:targetTask.project_id || profiles[intent.profile].todoistProjectId,
          recurrenceOwner:"calendar", seriesId, masterEventId:master.id, activeInstanceId:activeId,
          originalStart:originalOccurrence.originalStartTime?.dateTime || originalOccurrence.originalStartTime?.date
            || originalOccurrence.start?.dateTime || originalOccurrence.start?.date,
          activeEffectiveStart:originalOccurrence.start?.dateTime || originalOccurrence.start?.date,
          calendarProgressVersion:masterState?.calendarProgressVersion ?? 1,
          completedThroughOriginalStart:masterState?.completedThroughOriginalStart,
          updatedAt:at(),
        };
        const transferLink: import("./types.js").RecurrenceLink = {
          profile:intent.profile, owner:"calendar", seriesId, masterEventId:master.id,
          activeInstanceId:activeId, eventId:activeId, taskId:targetTask.id,
          originalStart:transferMapping.originalStart, activeEffectiveStart:transferMapping.activeEffectiveStart,
          calendarProgressVersion:transferMapping.calendarProgressVersion,
          completedThroughOriginalStart:transferMapping.completedThroughOriginalStart, updatedAt:at(),
        };
        const [preflightTask,preflightMaster,preflightOccurrence] = await Promise.all([
          pair.todoist.getTask(targetTask.id), pair.calendar.getEvent(master.id), pair.calendar.getEvent(activeId),
        ]);
        if (reviewHash(preflightTask.due) !== originalDue || !preflightTask.due?.is_recurring || !preflightTask.due.string) throw new Error("Todoist recurrence changed after preview; refresh affected items");
        if (reviewHash(preflightMaster.recurrence) !== originalRule || preflightMaster.status !== "confirmed"
          || !calendarSeriesRuleMatchesTodoistTask(preflightMaster,preflightTask) || preflightOccurrence.status !== "confirmed"
          || preflightOccurrence.recurringEventId !== master.id || !occurrenceStateMatches(preflightOccurrence,preflightTask)) {
          throw new Error("Calendar series or selected occurrence changed after preview; refresh affected items");
        }
        const mappingStep = `transfer-mapping:${seriesId}`;
        if (operation.steps[mappingStep]?.status !== "done"
          && (preflightTask.updated_at !== targetTask.updated_at || preflightMaster.etag !== master.etag
            || preflightOccurrence.etag !== originalOccurrence.etag)) {
          throw new Error("A provider version changed after preview; refresh affected items before transfer");
        }
        const installed = await step(mappingStep, async () => state.transferCalendarSeriesMapping({
          previous, expectedLink:masterState, mapping:transferMapping, link:transferLink,
        }));
        if (!installed) {
          // A conditional transaction returning false proves it committed no
          // state. Remove its read-only checkpoint so the normal no-write
          // failure path can release the claim and require a fresh preview.
          delete operation.steps[mappingStep];
          await this.store.saveOperation(operation);
          throw new Error("Calendar series mapping or Todoist ownership changed during transfer; refresh affected items");
        }
        await step(`transfer-calendar-metadata:${master.id}`, async () => {
          const liveMaster = await pair.calendar.getEvent(master.id);
          const liveOccurrence = await pair.calendar.getEvent(activeId);
          const liveTask = await pair.todoist.getTask(targetTask.id);
          if (reviewHash(liveTask.due) !== originalDue || !liveTask.due?.is_recurring || !liveTask.due.string) throw new Error("Todoist recurrence changed after preview; no transfer was applied");
          const masterMetadataApplied = liveMaster.extendedProperties?.shared?.taskId === targetTask.id
            && liveMaster.extendedProperties?.shared?.syncRecurrenceOwner === "calendar";
          const occurrenceMetadataApplied = liveOccurrence.extendedProperties?.shared?.taskId === targetTask.id
            && liveOccurrence.extendedProperties?.shared?.syncRecurrenceOwner === "calendar";
          if ((!masterMetadataApplied && liveMaster.etag !== master.etag) || (!occurrenceMetadataApplied && liveOccurrence.etag !== originalOccurrence.etag)
            || reviewHash(liveMaster.recurrence) !== originalRule || liveMaster.status !== "confirmed"
            || !calendarSeriesRuleMatchesTodoistTask(liveMaster, liveTask) || liveOccurrence.status !== "confirmed"
            || liveOccurrence.recurringEventId !== master.id || !occurrenceStateMatches(liveOccurrence, liveTask)) {
            throw new Error("Calendar series or selected occurrence changed after preview; refresh affected items");
          }
          const shared = { ...liveMaster.extendedProperties?.shared, taskId: liveTask.id,
            taskUrl: `https://app.todoist.com/app/task/${liveTask.id}`, syncSource: "todoist-calendar-sync", syncRecurrenceOwner: "calendar" };
          const activeShared = { ...liveOccurrence.extendedProperties?.shared, ...shared };
          const storedMaster = await trackedWrite(intent.profile, () => pair.calendar.upsertEventIfUnchanged({
            ...liveMaster, extendedProperties: { ...liveMaster.extendedProperties, shared },
          }, liveMaster.id, liveMaster.etag!));
          const storedOccurrence = await trackedWrite(intent.profile, () => pair.calendar.upsertEventIfUnchanged({
            ...liveOccurrence, extendedProperties: { ...liveOccurrence.extendedProperties, shared: activeShared },
          }, liveOccurrence.id, liveOccurrence.etag!));
          return { master: storedMaster, occurrence: storedOccurrence };
        });
        if (previous) {
          await this.controls.reject(previous.profile, previous.taskId, previous.eventId, id);
          await step(`transfer-delete-old-comment:${previous.taskId}`, async () => {
            const oldClient = await factory(previous.profile);
            return trackedWrite(previous.profile, () => deleteMappingComments(oldClient.todoist, previous), count => count);
          });
          await step(`transfer-delete-old-baseline:${previous.taskId}`, async () => new DynamoReconciliationStore().deleteBaseline(previous.profile, previous.taskId));
          if (exactDisposition === "retain-unlinked") await this.controls.exclude({profile:previous.profile,side:"todoist",id:previous.taskId},true,id);
        }
        await this.controls.allow(intent.profile,targetTask.id,activeId);
        const mappedComment = await step(`transfer-project-comment:${targetTask.id}`, async () => {
          const liveTask = await pair.todoist.getTask(targetTask.id);
          const liveMaster = await pair.calendar.getEvent(master.id);
          return trackedWrite(intent.profile, () => upsertProjectMappingComment(pair.todoist, transferMapping, transferMapping.projectId!, liveMaster.htmlLink), 2);
        });
        const finalTask = await pair.todoist.getTask(targetTask.id);
        const finalMaster = await pair.calendar.getEvent(master.id);
        const finalOccurrence = await pair.calendar.getEvent(activeId);
        if (reviewHash(finalTask.due) !== originalDue || !finalTask.due?.is_recurring || !finalTask.due.string) throw new Error("The recurring Todoist due rule changed during transfer");
        if (reviewHash(finalMaster.recurrence) !== originalRule || !calendarSeriesRuleMatchesTodoistTask(finalMaster, finalTask)
          || !occurrenceStateMatches(finalOccurrence, finalTask)) throw new Error("Calendar recurrence or selected occurrence failed post-transfer verification");
        const persisted = await state.getMappingByTask(intent.profile, targetTask.id);
        const persistedLink = await state.getRecurrenceLink(intent.profile, seriesId);
        if (!persisted || persisted.taskId !== targetTask.id || persisted.eventId !== activeId || persisted.recurrenceOwner !== "calendar"
          || !persistedLink || persistedLink.taskId !== targetTask.id || persistedLink.activeInstanceId !== activeId) throw new Error("Transferred mapping indexes or recurrence ownership did not verify");
        await new DynamoReconciliationStore().putBaseline(intent.profile,targetTask.id,finalTask,finalOccurrence);
        const identities = new CanonicalIdentityStore();
        const ti = todoistCanonicalIdentity(finalTask), ei = calendarCanonicalIdentity(finalOccurrence);
        if (ti) await identities.put(intent.profile,"todoist",targetTask.id,ti);
        if (ei) await identities.put(intent.profile,"calendar",activeId,ei);
        await state.acceptTaskVersion(intent.profile,targetTask.id,finalTask.updated_at,`review:${id}`);
        bindings.set(entityKey({profile:intent.profile,side:"todoist",id:targetTask.id}),activeId);
        bindings.set(entityKey({profile:intent.profile,side:"calendar",id:activeId}),targetTask.id);
        bindings.set(entityKey({profile:intent.profile,side:"calendar",id:master.id}),targetTask.id);
        recordVerified(persisted);
        if (previous && exactDisposition === "exclude") await step(`transfer-exclude-old:${previous.taskId}`, () => this.controls.exclude({profile:previous.profile,side:"todoist",id:previous.taskId},true,id));
        // The new project mapping comment is idempotently upserted; a subsequent
        // repair retry resumes from the durable operation checkpoint.
        void mappedComment;
        for (const snapshot of operation.preview.snapshots) {
          const disposition = intent.leftovers[entityKey(snapshot.ref)];
          if (!snapshot.object || !disposition || disposition === "retain-unlinked" || disposition === "unchanged") continue;
          if (disposition === "exclude") await step(`transfer-exclude:${entityKey(snapshot.ref)}`, () => this.controls.exclude(snapshot.ref,true,id));
          if (disposition === "create") {
            const clients = await factory(snapshot.ref.profile);
            if (snapshot.ref.side === "todoist") {
              const source = await clients.todoist.getTask(snapshot.ref.id);
              const created = await step(`transfer-create-event:${source.id}`, () => trackedWrite(snapshot.ref.profile,
                () => clients.calendar.createRepairEventOnce({...toCalendarEvent(source),id:reviewHash([id,source.id]).slice(0,32)},id)));
              await bind(snapshot.ref.profile,source,created,source.due?.is_recurring?"todoist":undefined);
            } else {
              const source = await clients.calendar.getEvent(snapshot.ref.id);
              const created = await step(`transfer-create-task:${source.id}`, () => trackedWrite(snapshot.ref.profile,
                () => clients.todoist.createTaskOnce(toTodoistTask(source),id+":"+source.id)));
              await bind(snapshot.ref.profile,created,source,undefined);
            }
          }
        }
      } else if (operation.preview.annualPlan) {
        const converted = await step("annualize-standalone", async () =>
          trackedWrite(intent.profile, () => applyStandaloneAnnualRepair(
            intent.profile, originalTask!, originalEvent!, operation.preview.annualPlan!, pair, state), 2));
        await bind(intent.profile, await pair.todoist.getTask(originalTask!.id),
          await pair.calendar.getEvent(converted.mapping.masterEventId!), "todoist");
      } else if(operation.preview.splitPlan) {
        const split=await step("future-split",async()=> {
          const old=await pair.calendar.getEvent(originalEvent!.id);
          return trackedWrite(intent.profile, () => applyApprovedFutureSeriesSplit(intent.profile,originalTask!,old,pair,state,{approvedPlan:operation.preview.splitPlan,approvedEtag:originalEvent!.etag}), 2);
        });
        await bind(intent.profile,await pair.todoist.getTask(originalTask!.id),await pair.calendar.getEvent(split.mapping.masterEventId||split.mapping.eventId),"todoist");
      } else if(intent.action!=="verify") {
        const mappings=new Map(operation.preview.snapshots.filter(s=>s.mapping
          && intent.leftovers[entityKey(s.ref)] !== "unchanged")
          .map(s=>[`${s.mapping!.profile}:${s.mapping!.taskId}`,s.mapping!]));
        for(const mapping of mappings.values()) await step(`detach:${mapping.profile}:${mapping.taskId}`,async()=> {
          const clients=await factory(mapping.profile);await writeGate(mapping.profile);await this.controls.reject(mapping.profile,mapping.taskId,mapping.eventId,id);
          await trackedWrite(mapping.profile, () => deleteMappingComments(clients.todoist,mapping), count => count);
          await state.deleteMapping(mapping);await new DynamoReconciliationStore().deleteBaseline(mapping.profile,mapping.taskId);
          if(mapping.seriesId)await state.deleteRecurrenceLink(mapping.profile,mapping.seriesId);return true;
        });
        for(const snapshot of operation.preview.snapshots.filter(s=>s.ref.side==="calendar" && s.object
          && intent.leftovers[entityKey(s.ref)] !== "unchanged"
          && !(intent.scope === "occurrence" && originalEvent?.recurringEventId === s.ref.id)
          && (s.ref.id===intent.eventId || [...mappings.values()].some(mapping=>mapping.eventId===s.ref.id))))await step(`unlink-metadata:${snapshot.ref.id}`,async()=> {
          const clients=await factory(snapshot.ref.profile),live=await clients.calendar.getEvent(snapshot.ref.id);
          const linked=live.extendedProperties?.shared?.taskId;
          if(linked){await writeGate(snapshot.ref.profile);await this.controls.reject(snapshot.ref.profile,linked,live.id,id);
            const shared={...live.extendedProperties?.shared};for(const name of Object.keys(shared))if(name==="taskId"||name==="taskUrl"||name==="originalSummary"||name.startsWith("sync")||name.startsWith("todoist"))delete shared[name];
            await trackedWrite(snapshot.ref.profile, () => clients.calendar.upsertEventIfUnchanged({...live,extendedProperties:{...live.extendedProperties,shared}},live.id,live.etag!));
          }return true;
        });
        if(intent.action==="link") {
          let task=await pair.todoist.getTask(originalTask!.id),event=await pair.calendar.getEvent(originalEvent!.id);
          if(intent.winner==="todoist")event=await step(`align-event:${event.id}`,async()=> {const desired=event.recurringEventId ? todoistOccurrenceProjection(task,event) : toCalendarEvent(task,event);return trackedWrite(intent.profile, () => pair.calendar.upsertEventIfUnchanged({...event,...desired,id:event.id,extendedProperties:{...event.extendedProperties,shared:{...event.extendedProperties?.shared,...desired.extendedProperties?.shared}}},event.id,event.etag!));});
          if(intent.winner==="calendar"&&!event.recurrence?.length)task=await step(`align-task:${task.id}`,async()=> trackedWrite(intent.profile, () => task.due?.is_recurring?pair.todoist.updateRecurringOccurrence(task,toTodoistTask(event)):pair.todoist.upsertTask(toTodoistTask(event),task.id)));
          await bind(intent.profile,task,event,intent.owner);
        }
        for(const snapshot of operation.preview.snapshots) {
          const selected=snapshot.ref.id===(snapshot.ref.side==="todoist"?intent.taskId:intent.eventId);
          if(intent.action==="link"&&selected)continue;
          if(!snapshot.object||bindings.has(entityKey(snapshot.ref)))continue;
          if(originalEvent?.recurringEventId===snapshot.ref.id)continue;
          const disposition=intent.action==="exclude"&&selected?"exclude":intent.action==="create"&&selected?"create":intent.leftovers[entityKey(snapshot.ref)];
          if(disposition==="exclude")await step(`exclude:${entityKey(snapshot.ref)}`,()=>this.controls.exclude(snapshot.ref,true,id));
          if(disposition==="unchanged")continue;
          if(disposition==="create") {
            const clients=await factory(snapshot.ref.profile);
            if(snapshot.ref.side==="todoist") {
              const task=await clients.todoist.getTask(snapshot.ref.id),event=await step(`create-event:${task.id}`,async()=> trackedWrite(snapshot.ref.profile, () => clients.calendar.createRepairEventOnce({...toCalendarEvent(task),id:reviewHash([id,task.id]).slice(0,32)},id)));
              await bind(snapshot.ref.profile,task,event,task.due?.is_recurring?"todoist":undefined);
            } else {
              const event=await clients.calendar.getEvent(snapshot.ref.id);let source=event;
              if(event.recurrence?.length){source=selectCalendarRecurrenceInstance(await clients.calendar.listInstances(event.id))!;if(!source)throw new Error("No active occurrence to mirror");}
              const task=await step(`create-task:${event.id}`,async()=> trackedWrite(snapshot.ref.profile, () => clients.todoist.createTaskOnce(toTodoistTask(source),id+":"+event.id)));
              await bind(snapshot.ref.profile,task,event,event.recurrence?.length || event.recurringEventId ? "calendar":undefined);
            }
          }
        }
      } else {
        if(!originalTask||!originalEvent)throw new Error("Verification requires both selected provider items");
        const mapping=await state.getMappingByTask(intent.profile,originalTask.id);
        if(!mapping)throw new Error(`Selected pair does not match the current mapping: Todoist task ${originalTask.id}, Calendar event ${originalEvent.id}; no mapping is recorded. Refresh affected items and use the current mapped pair.`);
        if(mapping.recurrenceOwner==="calendar"&&mapping.masterEventId){
          const pairClients=await factory(intent.profile),active=await pairClients.calendar.getEvent(mapping.activeInstanceId||mapping.eventId);
          if((originalEvent.id!==mapping.masterEventId&&originalEvent.id!==mapping.eventId&&originalEvent.id!==mapping.activeInstanceId)||!hasCanonicalState(active,originalTask))throw new Error(`Selected pair does not match the current Calendar-owned recurrence: Todoist task ${originalTask.id}, Calendar event ${originalEvent.id}; expected ${[mapping.eventId,mapping.masterEventId,mapping.activeInstanceId].filter(Boolean).join(", ")}. Refresh affected items and use the current mapped pair.`);
        }else if(mapping.recurrenceOwner==="todoist"&&mapping.masterEventId){
          const pairClients=await factory(intent.profile),master=await pairClients.calendar.getEvent(mapping.masterEventId),active=await pairClients.calendar.getEvent(mapping.activeInstanceId||mapping.eventId);
          if(![mapping.eventId,mapping.masterEventId,mapping.activeInstanceId].includes(originalEvent.id)||!calendarRecurrenceMatchesTodoist(master,originalTask)||!recurrenceAnchorMatches(master)||!occurrenceStateMatches(active,originalTask))throw new Error(`Selected pair does not match the current Todoist-owned recurrence: Todoist task ${originalTask.id}, Calendar event ${originalEvent.id}; expected ${[mapping.eventId,mapping.masterEventId,mapping.activeInstanceId].filter(Boolean).join(", ")}. Refresh affected items and use the current mapped pair.`);
        }else if(mapping.eventId!==originalEvent.id||!hasCanonicalState(originalEvent,originalTask))throw new Error(`Selected pair does not match the current mapping: Todoist task ${originalTask.id}, Calendar event ${originalEvent.id}; expected Calendar event ${mapping.eventId}. Refresh affected items and use the current mapped pair.`);
        recordVerified(mapping);
      }
      const outcomes: NonNullable<RepairOperation["outcomes"]> = [];
      for(const snapshot of operation.preview.snapshots) {
        const excluded=await this.controls.control(snapshot.ref);
        if(excluded?.excluded && intent.leftovers[entityKey(snapshot.ref)] !== "retain-unlinked") {outcomes.push({entity:entityKey(snapshot.ref),outcome:"excluded",checkedAt:at()});continue;}
        if(verified.some(v=>v.profile===snapshot.ref.profile&&(snapshot.ref.side==="todoist"?v.taskId===snapshot.ref.id:v.eventId===snapshot.ref.id))||["decision","move"].includes(intent.action))continue;
        if (operation.preview.flattenPlan && snapshot.ref.side === "calendar"
          && [operation.preview.flattenPlan.masterId,operation.preview.flattenPlan.occurrenceId].includes(snapshot.ref.id)) {
          assertFlattenedMaster(operation.preview.flattenPlan,await pair.calendar.getEvent(operation.preview.flattenPlan.masterId));
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"history",checkedAt:at()});continue;
        }
        if (intent.action === "flatten" && snapshot.mapping && snapshot.ref.side === "calendar" && (snapshot.object as CalendarEvent|null)?.status === "cancelled") {
          const current = await this.snapshot(snapshot.ref);
          if (reviewHash(current.object)!==reviewHash(snapshot.object) || current.mapping) throw new Error("Displaced cancelled Calendar object changed during flatten");
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"history",checkedAt:at()});continue;
        }
        const disposition=intent.action === "todoist-only" && snapshot.ref.side === "calendar" && snapshot.ref.id === intent.eventId
          ? "unchanged" : intent.leftovers[entityKey(snapshot.ref)];
        if(disposition==="unchanged"){
          const current=await this.snapshot(snapshot.ref);
          if(reviewHash(current.object)!==reviewHash(operation.expectedProviders?.[entityKey(snapshot.ref)]??snapshot.object)
            ||reviewHash(current.mapping??null)!==reviewHash(snapshot.mapping??null)
            ||reviewHash(unchangedControlState(current.control))!==reviewHash(unchangedControlState(snapshot.control)))throw new Error(`Leave unchanged verification failed for ${entityKey(snapshot.ref)}; provider or sync state changed`);
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"unchanged",checkedAt:at()});continue;
        }
        if (disposition === "retain-unlinked") {
          if (intent.action !== "transfer" || snapshot.ref.side !== "todoist" || !snapshot.mapping) throw new Error("Retain unlinked is restricted to the exact displaced Todoist mapping");
          const current = await this.snapshot(snapshot.ref);
          const seriesId = snapshot.mapping.seriesId;
          const link = seriesId ? await state.getRecurrenceLink(snapshot.ref.profile, seriesId) : undefined;
          if (reviewHash(current.object) !== reviewHash(operation.expectedProviders?.[entityKey(snapshot.ref)] ?? snapshot.object)
            || current.mapping || !link || link.taskId === snapshot.ref.id || link.owner !== "calendar"
            || current.control?.excluded !== true
            || reviewHash(retainedTaskControlState(current.control)) !== reviewHash({ ...retainedTaskControlState(snapshot.control), excluded:true })) {
            throw new Error(`Retained provider item ${entityKey(snapshot.ref)} or its detached mapping changed during transfer`);
          }
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"retained-unlinked",checkedAt:at()});continue;
        }
        if (snapshot.ref.side === "calendar" && recurrenceBindings.some(m => m.profile === snapshot.ref.profile && m.activeInstanceId === snapshot.ref.id)) continue;
        if(!snapshot.object){
          const current=await this.snapshot(snapshot.ref);
          if (intent.action === "flatten" && !current.object && !current.mapping) { outcomes.push({entity:entityKey(snapshot.ref),outcome:"missing",checkedAt:at()});continue; }
          if(current.object||!matchesExpectedAfterDetach(snapshot,current))throw new Error(`Missing item ${entityKey(snapshot.ref)} changed during repair`);
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"missing",checkedAt:at()});continue;
        }
        const masterBinding = recurrenceBindings.find(m => m.profile === snapshot.ref.profile && snapshot.ref.side === "calendar" && m.masterEventId === snapshot.ref.id);
        const isSelectedRecurringMaster=masterBinding?.recurrenceOwner === "calendar";
        const contextMaster=snapshot.ref.side==="calendar"&&(originalEvent?.recurringEventId===snapshot.ref.id||Boolean(isSelectedRecurringMaster));
        const splitHistory=splitHistoryMasterId(snapshot);
        if(contextMaster||splitHistory||standaloneHistory(snapshot)){
          const current=await this.snapshot(snapshot.ref);
          if (standaloneHistory(snapshot)) {
            assertStandaloneHistory(current.object as CalendarEvent|null,operation.preview.annualPlan!,intent.taskId!);
          } else if(splitHistory){
            const master=snapshot.ref.id===splitHistory ? current.object as CalendarEvent|null : await (await factory(snapshot.ref.profile)).calendar.getEvent(splitHistory);
            assertApprovedHistoryCap(master, operation.preview.splitPlan!, intent.taskId!);
          } else if(isSelectedRecurringMaster){
            const master=current.object as CalendarEvent|null;
            if (reviewHash(master) !== reviewHash(operation.expectedProviders?.[entityKey(snapshot.ref)] ?? snapshot.object)) throw new Error(`Calendar-owned series master ${entityKey(snapshot.ref)} changed during repair`);
            const linkedTaskId=masterBinding!.taskId;
            const mapping=linkedTaskId?await state.getMappingByTask(snapshot.ref.profile,linkedTaskId):undefined;
            const seriesId=master?.iCalUID||master?.id;
            const recurrence=seriesId?await state.getRecurrenceLink(snapshot.ref.profile,seriesId):undefined;
            if(!master?.recurrence?.length||mapping?.recurrenceOwner!=="calendar"||mapping.masterEventId!==master.id||mapping.seriesId!==seriesId||!recurrence||recurrence.taskId!==linkedTaskId||recurrence.masterEventId!==master.id)throw new Error(`Calendar-owned series master ${entityKey(snapshot.ref)} is not verified`);
          } else if(!matchesExpectedAfterDetach(snapshot,current))throw new Error(`Context master ${entityKey(snapshot.ref)} changed during repair`);
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"history",checkedAt:at()});continue;
        }
        throw new Error(`Unverified leftover ${entityKey(snapshot.ref)}; repair barrier retained`);
      }
      operation.outcomes=outcomes;
      operation.recurrenceBindings=recurrenceBindings;
      await this.store.saveOperation(operation);
      // Re-read every affected entity before releasing barriers; external edits
      // become a review outcome rather than being overwritten by delayed events.
      for(const binding of verified){
        const clients=await factory(binding.profile),mapping=await state.getMappingByTask(binding.profile,binding.taskId);
        const recurrence = recurrenceBindings.find(m => m.profile === binding.profile && m.taskId === binding.taskId);
        if (recurrence) {
          const link = await state.getRecurrenceLink(binding.profile, recurrence.seriesId!);
          if (!mapping || !link || ["eventId","masterEventId","activeInstanceId","seriesId","recurrenceOwner"].some(field => mapping[field as keyof Mapping] !== recurrence[field as keyof Mapping])
            || link.taskId !== binding.taskId || link.masterEventId !== recurrence.masterEventId || link.activeInstanceId !== recurrence.activeInstanceId || link.owner !== recurrence.recurrenceOwner) throw new Error("The repaired recurrence association changed before verification completed");
        }
        if (intent.action === "flatten") {
          if (!mapping) throw new Error("Flattened mapping disappeared before release");
          await verifyStandaloneMapping(mapping);
        }
        const [t,e]=await Promise.all([clients.todoist.getTask(binding.taskId),clients.calendar.getEvent(mapping?.activeInstanceId||binding.eventId)]);
        if (recurrence?.activeInstanceId && e.recurringEventId !== recurrence.masterEventId) throw new Error("The repaired active occurrence no longer belongs to its verified master");
        if (intent.action === "transfer" && mapping?.recurrenceOwner === "calendar" && mapping.masterEventId) {
          const master=await clients.calendar.getEvent(mapping.masterEventId);
          if(!calendarSeriesRuleMatchesTodoistTask(master,t)||!occurrenceStateMatches(e,t))throw new Error("Transferred Calendar-owned recurrence or active occurrence changed before release");
        } else if (mapping?.recurrenceOwner === "todoist" && mapping.masterEventId) {
          const master=await clients.calendar.getEvent(mapping.masterEventId);
          if(!calendarRecurrenceMatchesTodoist(master,t)||!recurrenceAnchorMatches(master)||!occurrenceStateMatches(e,t))throw new Error("A provider changed before recurrence verification completed; resume after reviewing the live data");
        } else if(!hasCanonicalState(e,t))throw new Error("A provider changed before verification completed; resume after reviewing the live data");
        // Fence delayed Todoist payloads at the verified provider version before
        // releasing any repair barrier. A newer existing fence is also safe.
        await state.acceptTaskVersion(binding.profile, t.id, t.updated_at, `review:${id}`);
      }
      for(const outcome of outcomes){
        const snapshot=operation.preview.snapshots.find(item=>entityKey(item.ref)===outcome.entity);
        if(!snapshot)throw new Error(`Recorded outcome ${outcome.entity} is missing its preview reference`);
        if(outcome.outcome==="excluded"){
          if(!(await this.controls.control(snapshot.ref))?.excluded)throw new Error(`Exclusion for ${outcome.entity} changed before release`);
          continue;
        }
        const current=await this.snapshot(snapshot.ref);
        if(outcome.outcome==="missing"){
          if (intent.action === "flatten" && !current.object && !current.mapping) continue;
          if(current.object||!matchesExpectedAfterDetach(snapshot,current))throw new Error(`Missing item ${outcome.entity} changed before release`);
          continue;
        }
        if(outcome.outcome==="unchanged"){
          if(reviewHash(current.object)!==reviewHash(operation.expectedProviders?.[outcome.entity]??snapshot.object)
            ||reviewHash(current.mapping??null)!==reviewHash(snapshot.mapping??null)
            ||reviewHash(unchangedControlState(current.control))!==reviewHash(unchangedControlState(snapshot.control)))throw new Error(`Leave unchanged state for ${outcome.entity} changed before release`);
          continue;
        }
        if (outcome.outcome === "retained-unlinked") {
          const seriesId = snapshot.mapping?.seriesId;
          const link = seriesId ? await state.getRecurrenceLink(snapshot.ref.profile, seriesId) : undefined;
          if (reviewHash(current.object) !== reviewHash(operation.expectedProviders?.[outcome.entity] ?? snapshot.object)
            || current.mapping || !link || link.taskId === snapshot.ref.id || link.owner !== "calendar"
            || current.control?.excluded !== true
            || reviewHash(retainedTaskControlState(current.control)) !== reviewHash({ ...retainedTaskControlState(snapshot.control), excluded:true })) throw new Error(`Retained provider item ${outcome.entity} changed before release`);
          continue;
        }
        if (operation.preview.flattenPlan && snapshot.ref.side === "calendar" && [operation.preview.flattenPlan.masterId,operation.preview.flattenPlan.occurrenceId].includes(snapshot.ref.id)) {
          assertFlattenedMaster(operation.preview.flattenPlan,await pair.calendar.getEvent(operation.preview.flattenPlan.masterId));continue;
        }
        if (intent.action === "flatten" && snapshot.mapping && snapshot.ref.side === "calendar" && (snapshot.object as CalendarEvent|null)?.status === "cancelled") {
          if (reviewHash(current.object)!==reviewHash(snapshot.object) || current.mapping) throw new Error("Displaced cancelled Calendar object changed before release");
          continue;
        }
        const splitHistory=splitHistoryMasterId(snapshot);
        if (standaloneHistory(snapshot)) {
          assertStandaloneHistory(current.object as CalendarEvent|null,operation.preview.annualPlan!,intent.taskId!);
          continue;
        }
        if(splitHistory){
          const master=snapshot.ref.id===splitHistory ? current.object as CalendarEvent|null : await (await factory(snapshot.ref.profile)).calendar.getEvent(splitHistory);
          assertApprovedHistoryCap(master, operation.preview.splitPlan!, intent.taskId!);
          continue;
        }
        const masterBinding=recurrenceBindings.find(m => m.profile === snapshot.ref.profile && snapshot.ref.side === "calendar" && m.masterEventId === snapshot.ref.id);
        const isSelectedMaster=masterBinding?.recurrenceOwner === "calendar";
        if(isSelectedMaster){
          const master=current.object as CalendarEvent|null, linkedTaskId=masterBinding!.taskId;
          if (reviewHash(master) !== reviewHash(operation.expectedProviders?.[entityKey(snapshot.ref)] ?? snapshot.object)) throw new Error(`Calendar-owned series master ${outcome.entity} changed before release`);
          const mapping=linkedTaskId?await state.getMappingByTask(snapshot.ref.profile,linkedTaskId):undefined;
          const seriesId=master?.iCalUID||master?.id, recurrence=seriesId?await state.getRecurrenceLink(snapshot.ref.profile,seriesId):undefined;
          if(!master?.recurrence?.length||mapping?.recurrenceOwner!=="calendar"||mapping.masterEventId!==master.id||mapping.seriesId!==seriesId||!recurrence||recurrence.taskId!==linkedTaskId||recurrence.masterEventId!==master.id)throw new Error(`Calendar-owned series master ${outcome.entity} changed before release`);
        } else if(!matchesExpectedAfterDetach(snapshot,current))throw new Error(`Retained history ${outcome.entity} changed before release`);
      }
      const releases: RepairRelease[] = [];
      for(const snapshot of operation.preview.snapshots){
        const preserveControlState = operation.outcomes?.some(outcome => outcome.entity === entityKey(snapshot.ref) && outcome.outcome === "unchanged") || false;
        if(intent.action==="move"&&snapshot.ref.side==="todoist"&&snapshot.ref.id===intent.taskId){
          const moved=await(await factory(intent.targetProfile!)).todoist.getTask(snapshot.ref.id);
          releases.push({ref:snapshot.ref,providerUpdatedAt:moved.updated_at,preserveControlState});continue;
        }
        const live=await this.snapshot(snapshot.ref);
        releases.push({ref:snapshot.ref,providerUpdatedAt:(live.object as TodoistTask)?.updated_at || (live.object as CalendarEvent)?.updated,clearExclusion:bindings.has(entityKey(snapshot.ref)),preserveControlState});
      }
      if(targetTaskRef){
        const moved=await this.snapshot(targetTaskRef);
        releases.push({ref:targetTaskRef,providerUpdatedAt:(moved.object as TodoistTask|null)?.updated_at,clearExclusion:true});
      }
      operation.verified=verified;
      const queuedRefresh=await queueDeferredRefresh([
        ...operation.preview.snapshots.map(snapshot=>snapshot.ref),
        ...(targetTaskRef?[targetTaskRef]:[]),
      ]);
      if(queuedRefresh.length) {
        operation.notificationText="Succeeded: repair verified; queued a refresh for updates received during the repair.";
      }
      if(operation.preview.case.decision)await new ManualInterventionService().finishReconciliationDecision(operation.preview.case.decision.decisionId,"Resolved and verified in the review page");
      // Finalization owns its transaction/recovery. Do not persist a failure
      // over an uncertain commit; a delivery retry reads the durable result.
      return this.store.finalizeOperation(operation, releases);
    } catch(e) {
      const providerProgress = Object.keys(operation.creations || {}).length > 0
        || Object.entries(operation.expectedProviders || {}).some(([key, object]) =>
          reviewHash(object) !== reviewHash(operation.preview.snapshots.find(s => entityKey(s.ref) === key)?.object ?? null));
      // 'validated' is read-only: it must not strand a failed repair. Other
      // started steps, provider changes or recorded outcomes may contain writes.
      const changesMayHaveStarted = providerProgress || Object.keys(operation.steps).some(name => name !== 'validated')
        || operation.outcomes !== undefined || operation.verified !== undefined || operation.recurrenceBindings !== undefined;
      const failureMessage = e instanceof Error ? e.message : String(e);
      const abandonedNextAction = 'No repair writes were recorded and ownership was released. Refresh affected items and create a new preview; do not resume this failed operation.';
      let releaseError: unknown;
      if (claimed && !changesMayHaveStarted) {
        const snapshots = [...operation.preview.snapshots, ...(operation.claimSnapshots || [])];
        const refs = snapshots.map(snapshot => snapshot.ref);
        try {
          const queued = await queueDeferredRefresh(refs);
          try {
            await this.controls.releaseUnapplied(refs, id, snapshots, {error: failureMessage, nextAction: abandonedNextAction}, queued);
            operation.abandoned = true;
          } catch(error) {
            // A lost DynamoDB transaction response may mean BOTH the marker
            // and locks were committed; never overwrite that durable result.
            const durable = await this.store.getOperation(id).catch(()=>undefined);
            if (durable?.abandoned) operation.abandoned = true;
            else releaseError = error;
          }
        } catch(error) { releaseError = error; }
      }
      operation.status = changesMayHaveStarted || releaseError || claimed && !operation.abandoned ? 'needs_review' : 'failed';
      operation.error = failureMessage;
      if (releaseError) operation.error += `; repair barriers were retained because safe release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      operation.nextAction = operation.abandoned
        ? abandonedNextAction
        : 'Repair ownership remains protected; inspect live state and resume only when the recorded changes are understood.';
      try {
        await this.store.updateCase(intent.caseId, 'open', operation.error, id);
      } catch (updateError) {
        // A case-status update is best effort after failure: always persist the
        // terminal operation outcome and preserve the original failure.
        const detail = updateError instanceof Error ? updateError.message : String(updateError);
        operation.error += `; case status could not be updated: ${detail}`;
        operation.nextAction += ' The case status may still show repairing; inspect the operation status directly.';
      }
    }
    operation.notificationPending=true;operation.notificationText=`${operation.status === "needs_review"?"Needs review":"Failed"}: ${operation.error}`;
    await this.store.saveOperation(operation);return operation;
  }
}

import { randomUUID } from "node:crypto";
import { profiles } from "./config.js";
import { CanonicalIdentityStore, calendarCanonicalIdentity, todoistCanonicalIdentity } from "./canonical-identity.js";
import { defaultProviderClientFactory, ReconciliationMutationBudget, createBudgetedClientFactory, type ProviderClientFactory } from "./mutation-budget.js";
import { StateRepository } from "./repository.js";
import { DynamoReconciliationStore } from "./reconciliation.js";
import { ReviewStore, SyncControls, reviewHash } from "./review-store.js";
import { entityKey, type EntityRef, type RepairIntent, type RepairOperation, type RepairPreview, type ReviewActor, type ReviewSnapshot } from "./review-types.js";
import { hasCanonicalState, occurrenceStateMatches, selectCalendarRecurrenceInstance, toCalendarEvent, toTodoistTask } from "./sync.js";
import { upsertProjectMappingComment, deleteMappingComments } from "./mapping-comments.js";
import { calendarRecurrenceMatchesTodoist, selectTodoistCurrentInstance, todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import { planFutureSeriesSplit } from "./recurrence-split.js";
import { applyApprovedFutureSeriesSplit } from "./future-split-execution.js";
import { ManualDecisionStore, ManualInterventionService, type ManualDecision } from "./manual-intervention.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import type { CalendarEvent, Mapping, Profile, TodoistTask } from "./types.js";
const missing = (e: unknown) => [404, 410].includes(Number((e as { status?: number }).status));
const at = () => new Date().toISOString();
function recurrenceAnchorMatches(event: CalendarEvent): boolean {
  const shared = event.extendedProperties?.shared;
  return Boolean(shared?.todoistAnchorStart && shared.todoistAnchorEnd
    && (event.start?.dateTime || event.start?.date) === shared.todoistAnchorStart
    && (event.end?.dateTime || event.end?.date) === shared.todoistAnchorEnd);
}
function decisionRepairIntent(intent: RepairIntent, decision?: ManualDecision): RepairIntent {
  if (intent.action !== "decision") return intent;
  if (!decision || !decision.permittedActions.some(a => a.id === intent.decisionAction) || intent.decisionAction === "reconcile_now") throw new Error("Select a permitted repair action; reconciliation is a separate explicit request");
  const taskId = intent.decisionAction?.startsWith("bind_task:") ? intent.decisionAction.slice("bind_task:".length) : decision.taskId || decision.mappingSnapshot?.taskId;
  const eventId = decision.eventId || decision.mappingSnapshot?.eventId || decision.activeInstanceId || decision.masterEventId;
  if (intent.taskId && intent.taskId !== taskId || intent.eventId && intent.eventId !== eventId) throw new Error("Selected items do not match the decision's repair targets");
  return { ...intent, taskId, eventId };
}
export function snapshotFingerprint(snapshots: ReviewSnapshot[]): string {
  return reviewHash(snapshots.map(s => ({ ref: s.ref, object: s.object, mapping: s.mapping,
    recurrence: s.recurrence, calendarProjectionId: s.calendarProjectionId,
    control: { excluded: s.control?.excluded, fencedAt: s.control?.fencedAt } })));
}
export class ReviewEngine {
  constructor(readonly store = new ReviewStore(), readonly state = new StateRepository(), readonly clients: ProviderClientFactory = defaultProviderClientFactory,
    readonly controls = new SyncControls()) {}
  async snapshot(ref: EntityRef): Promise<ReviewSnapshot> {
    const pair = await this.clients(ref.profile);
    let object: TodoistTask | CalendarEvent | null;
    try { object = ref.side === "todoist" ? await pair.todoist.getTask(ref.id) : await pair.calendar.getEvent(ref.id); }
    catch (e) { if (!missing(e)) throw e; object = null; }
    const mapping = ref.side === "todoist" ? await this.state.getMappingByTaskAnyProfile(ref.id) : await this.state.getMappingByEvent(ref.profile, ref.id);
    if (mapping && mapping.profile !== ref.profile) throw new Error(`Item belongs to ${mapping.profile}; use Move to profile instead`);
    if (ref.side === "todoist" && object && (object as TodoistTask).project_id !== profiles[ref.profile].todoistProjectId) throw new Error("Task is outside the selected profile's project");
    const snapshot: ReviewSnapshot = { ref, object, mapping, control: await this.controls.control(ref) as Record<string, unknown> | undefined };
    if (ref.side === "calendar" && (object as CalendarEvent|null)?.recurrence?.length) {
      const event = object as CalendarEvent;
      snapshot.recurrence = await this.state.getRecurrenceLink(ref.profile, event.iCalUID || event.id);
      snapshot.calendarProjectionId = selectCalendarRecurrenceInstance(await pair.calendar.listInstances(event.id), snapshot.recurrence)?.id;
    }
    return snapshot;
  }
  async collect(intent: RepairIntent, decision?: ManualDecision): Promise<ReviewSnapshot[]> {
    const refs = new Map<string, EntityRef>();
    const add = (ref: EntityRef) => { if (ref.id) refs.set(entityKey(ref), ref); };
    if (intent.taskId) add({ profile: intent.profile, side: "todoist", id: intent.taskId });
    if (intent.eventId) add({ profile: intent.profile, side: "calendar", id: intent.eventId });
    if (intent.action === "decision" && decision) {
      const mapping = decision.mappingSnapshot;
      for (const taskId of [decision.taskId, mapping?.taskId]) if (taskId) add({ profile:intent.profile, side:"todoist", id:taskId });
      for (const eventId of [decision.eventId, decision.masterEventId, decision.activeInstanceId, mapping?.eventId, mapping?.masterEventId, mapping?.activeInstanceId]) {
        if (eventId) add({ profile:intent.profile, side:"calendar", id:eventId });
      }
    }
    const snapshots: ReviewSnapshot[] = [];
    for (const ref of refs.values()) {
      if (refs.size > 20) throw new Error("Too many linked items for one repair; narrow the selection");
      const snapshot = await this.snapshot(ref); snapshots.push(snapshot);
      if (snapshot.mapping) {
        add({ profile: snapshot.mapping.profile, side: "todoist", id: snapshot.mapping.taskId });
        add({ profile: snapshot.mapping.profile, side: "calendar", id: snapshot.mapping.eventId });
        if (snapshot.mapping.masterEventId) add({ profile: ref.profile, side: "calendar", id: snapshot.mapping.masterEventId });
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
    return snapshots.sort((a,b) => entityKey(a.ref).localeCompare(entityKey(b.ref)));
  }
  async preview(actor: ReviewActor, intent: RepairIntent): Promise<RepairPreview> {
    const record = await this.store.getCase(intent.caseId);
    if (!record || record.profile !== intent.profile) throw new Error("Conflict not found in this profile");
    if (!["link","separate","create","exclude","decision","verify","move"].includes(intent.action)) throw new Error("Unknown repair action");
    if (!["none","todoist","calendar"].includes(intent.winner) || !["occurrence","series","future"].includes(intent.scope)) throw new Error("Invalid field winner or recurrence scope");
    if (!intent.leftovers || Object.values(intent.leftovers).some(v => !["exclude","create"].includes(v))) throw new Error("Invalid leftover dispositions");
    intent = decisionRepairIntent(intent, record.decision);
    const snapshots = await this.collect(intent, record.decision);
    if (!snapshots.length) throw new Error("Select at least one provider item");
    if (snapshots.some(s => s.control?.activeRepair)) throw new Error("An incomplete repair owns an affected item; resume that operation first");
    const task = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === intent.taskId)?.object as TodoistTask | undefined;
    const event = snapshots.find(s => s.ref.side === "calendar" && s.ref.id === intent.eventId)?.object as CalendarEvent | undefined;
    const masterSnapshot = snapshots.find(s => s.ref.side === "calendar" && s.ref.id === (event?.recurringEventId || event?.id));
    if (event?.recurringEventId && intent.owner === "calendar" && ["link","create"].includes(intent.action)
      && (masterSnapshot?.recurrence?.owner === "todoist" || (masterSnapshot?.object as CalendarEvent)?.extendedProperties?.shared?.syncRecurrenceOwner === "todoist")) {
      throw new Error("Use a master-level recurrence repair to change Todoist ownership; an occurrence repair must preserve its parent series");
    }
    if (event?.recurringEventId && intent.owner === "calendar" && ["link","create"].includes(intent.action)
      && masterSnapshot?.calendarProjectionId !== event.id) throw new Error("Choose the active Calendar occurrence or its master to repair this series");
    const changes: string[] = [], warnings: string[] = [];
    const preview: RepairPreview = { id: randomUUID(), actor, intent, case: record, snapshots, fingerprint: snapshotFingerprint(snapshots),
      createdAt: at(), expiresAt: Math.floor(Date.now()/1000)+600, changes, warnings };
    if (intent.action === "link" && (!task || !event)) throw new Error("Linking requires a live task and event");
    if (intent.action === "link" && event?.recurringEventId && !intent.owner) throw new Error("Choose which provider owns the recurrence for this Calendar occurrence");
    if (intent.action === "link" && intent.owner === "todoist" && !task?.due?.is_recurring) throw new Error("Todoist recurrence ownership requires a recurring Todoist task");
    if (intent.action === "create" && Boolean(task) === Boolean(event)) throw new Error("Select just the item whose counterpart should be created");
    if (intent.action === "create" && event?.recurrence?.length && intent.owner !== "calendar") throw new Error("Creating a counterpart for a Calendar series requires Calendar recurrence ownership");
    if (intent.action === "create" && event?.recurringEventId && intent.owner !== "calendar") throw new Error("Creating a counterpart for a Calendar occurrence requires Calendar recurrence ownership");
    if (intent.action === "decision") {
      if (!record.decision || !record.decision.permittedActions.some(a => a.id === intent.decisionAction) || intent.decisionAction === "reconcile_now") throw new Error("Select a permitted repair action; reconciliation is a separate explicit request");
      changes.push(`Apply ${intent.decisionAction} with the existing guarded executor`);
    } else if (intent.action === "move") {
      if (!task || !intent.targetProfile || !["home","antonio","work"].includes(intent.targetProfile) || intent.targetProfile === intent.profile) throw new Error("Select a different destination profile for this task");
      changes.push(`Move task to ${intent.targetProfile}; apply existing project-transition rules to its Calendar projection`);
      warnings.push("The source projection follows the existing project-move lifecycle, shown as displaced below.");
    } else if (intent.action === "link") {
      if (intent.winner === "none" && !hasCanonicalState(event!, task!)) throw new Error("Fields differ: choose Todoist or Calendar as the source");
      if (event?.recurringEventId && intent.scope !== "occurrence") throw new Error("Choose the Calendar master to repair a whole series");
      if (event?.recurrence?.length) {
        if (!intent.owner) throw new Error("Choose which provider owns the recurrence");
        if (intent.owner === "todoist" && intent.scope !== "future") throw new Error("Changing a Calendar series to Todoist ownership requires a future-only preview");
        if (intent.owner === "calendar" && intent.winner === "todoist") throw new Error("Use Calendar fields for a Calendar-owned series; change a future series with the Todoist owner option");
        if (intent.owner === "todoist") {
          const zone = await (await this.clients(intent.profile)).calendar.getTimeZone();
          preview.splitPlan = planFutureSeriesSplit(intent.profile, task!, event, new Date(), zone);
          changes.push(`Retain history through ${preview.splitPlan.previousOccurrence}; start future recurrence ${preview.splitPlan.newStart}`);
        } else changes.push("Bind the next active Calendar occurrence; preserve the existing series and completed history");
      } else if (task?.due?.is_recurring && intent.owner !== "todoist" && !event?.recurringEventId) {
        throw new Error("Choose Todoist recurrence ownership for this recurring task, or use its existing recurrence resolution action");
      }
      changes.push(`Link task ${task!.content} to event ${event!.summary}; ${intent.winner === "none" ? "retain matching fields" : `use ${intent.winner} fields`}`);
    } else changes.push(`${intent.action}: preserve the original provider items`);
    const chosen = new Set([intent.taskId && `todoist:${intent.taskId}`, intent.eventId && `calendar:${intent.eventId}`]);
    if (event?.recurrence?.length && masterSnapshot?.calendarProjectionId && ["link","create"].includes(intent.action)) {
      chosen.add(`calendar:${masterSnapshot.calendarProjectionId}`);
      if (intent.leftovers[entityKey({profile:intent.profile, side:"calendar", id:masterSnapshot.calendarProjectionId})]) throw new Error("The active occurrence belongs to the selected series repair and cannot have a separate disposition");
      changes.push(`Use active Calendar occurrence ${masterSnapshot.calendarProjectionId} for the resulting association`);
    }
    for (const s of snapshots) {
      const selected = chosen.has(`${s.ref.side}:${s.ref.id}`);
      const masterOfSelected = s.ref.side === "calendar" && event?.recurringEventId === s.ref.id;
      const selectedProjection = event?.recurrence?.length && s.ref.side === "calendar" && s.ref.id === masterSnapshot?.calendarProjectionId;
      if (intent.action === "link" && selected || selectedProjection && ["link","create"].includes(intent.action) || ["decision","verify","move"].includes(intent.action) || masterOfSelected) continue;
      const disposition = intent.action === "exclude" && selected ? "exclude" : intent.action === "create" && selected ? "create" : intent.leftovers[entityKey(s.ref)];
      if (s.object && !disposition) throw new Error(`Choose Create counterpart or Exclude for ${entityKey(s.ref)}`);
      if (s.object) changes.push(`${disposition} counterpart handling for ${s.ref.side} ${(s.object as TodoistTask).content || (s.object as CalendarEvent).summary || s.ref.id}`);
    }
    for (const s of snapshots) if (s.mapping) changes.push(`Replace existing association ${s.mapping.taskId} ↔ ${s.mapping.eventId}`);
    warnings.push("Past Calendar occurrences and audit records are retained. Old associations cannot be recovered automatically.");
    await this.store.putPreview(preview); return preview;
  }
  async execute(id: string): Promise<RepairOperation> {
    const operation = await this.store.getOperation(id); if (!operation) throw new Error("Repair not found");
    if (operation.status === "succeeded") return operation;
    let { intent } = operation.preview;
    const state = new StateRepository(id);
    const rawFactory = this.clients;
    const budget = new ReconciliationMutationBudget(20);
    const factory = createBudgetedClientFactory(budget, rawFactory);
    let claimed = false;
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const saved = operation.steps[name];
      if (saved?.status === "done") return saved.result as T;
      if (saved && Date.now()-Date.parse(saved.startedAt) > 23*3600000 && name.startsWith("create-task")) throw new Error("Task creation acknowledgement is uncertain and its idempotency window expired; inspect provider state before retrying");
      operation.steps[name] = { id: name, status: "running", startedAt: saved?.startedAt || at() }; await this.store.saveOperation(operation);
      const result = await run(); operation.steps[name] = { ...operation.steps[name], status: "done", result: result ?? null, completedAt: at() }; await this.store.saveOperation(operation); return result;
    };
    try {
      intent = decisionRepairIntent(intent, operation.preview.case.decision);
      const targetTaskRef: EntityRef | undefined = intent.action === "move" && intent.targetProfile && intent.taskId
        ? { profile:intent.targetProfile, side:"todoist", id:intent.taskId } : undefined;
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
      const bindings = new Map<string, string>();
      const expectedMissingSnapshot = (snapshot: ReviewSnapshot): ReviewSnapshot => {
        const mapping = snapshot.mapping;
        return mapping && operation.steps[`detach:${mapping.profile}:${mapping.taskId}`]?.status === "done"
          ? { ...snapshot, mapping:undefined } : snapshot;
      };
      const pair = await factory(intent.profile);
      const taskSnapshot = operation.preview.snapshots.find(s=>s.ref.side==="todoist" && s.ref.id===intent.taskId);
      const eventSnapshot = operation.preview.snapshots.find(s=>s.ref.side==="calendar" && s.ref.id===intent.eventId);
      const originalTask = taskSnapshot?.object as TodoistTask | undefined;
      const originalEvent = eventSnapshot?.object as CalendarEvent | undefined;
      const splitHistoryMasterId = (snapshot: ReviewSnapshot) => operation.preview.splitPlan && snapshot.ref.side === "calendar"
        && (snapshot.ref.id === intent.eventId || (snapshot.object as CalendarEvent|null)?.recurringEventId === intent.eventId) ? intent.eventId : undefined;
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
        verified.push({profile,taskId:task.id,eventId:mapping.eventId});
      };
      if(intent.action === "decision") {
        await step("decision",async()=> {
          const source=operation.preview.case.decision!;
          const decisions=new ManualDecisionStore();
          const { status: _status, createdAt: _createdAt, decisionDeadline: _deadline, ...pending } = source;
          const {decision}=await decisions.putPending({...pending,decisionId:`review-${id}`});
          await new ManualInterventionService(decisions,undefined,factory).processManualDelivery({id:`review-action:${id}`,kind:"manual",profile:intent.profile,mode:"aws",receivedAt:at(),headers:{},body:"",manual:{decisionId:decision.decisionId,action:intent.decisionAction,slackUserId:undefined}},state);
          const after=await decisions.get(decision.decisionId); if(after?.status!=="resolved")throw new Error("Guarded action requires further review; inspect the decision result");
          return after;
        });
        const mapping=intent.taskId?await state.getMappingByTask(intent.profile,intent.taskId):undefined;
        if(mapping)await bind(intent.profile,await pair.todoist.getTask(mapping.taskId),await pair.calendar.getEvent(mapping.masterEventId||mapping.eventId),mapping.recurrenceOwner);
      } else if(intent.action==="move") {
        await step("move-project",async()=> trackedWrite(intent.profile, () => pair.todoist.moveTask(originalTask!.id,profiles[intent.targetProfile!].todoistProjectId)));
        await step("move-projection",async()=> {
          const moved=await pair.todoist.getTask(originalTask!.id);
          await new ProjectAwareSynchronizer(state,undefined,factory).process({id:`review-move:${id}`,kind:"todoist",profile:intent.profile,mode:"aws",receivedAt:at(),headers:{},body:JSON.stringify({event_name:"item:updated",event_data:moved,event_data_extra:{old_item:originalTask}})});return true;
        });
        const mapping=await state.getMappingByTaskAnyProfile(originalTask!.id);if(!mapping||mapping.profile!==intent.targetProfile)throw new Error("Project move is not verified");
        const destination=await factory(mapping.profile);await bind(mapping.profile,await destination.todoist.getTask(mapping.taskId),await destination.calendar.getEvent(mapping.masterEventId||mapping.eventId),mapping.recurrenceOwner);
      } else if(operation.preview.splitPlan) {
        const split=await step("future-split",async()=> {
          const old=await pair.calendar.getEvent(originalEvent!.id);
          return trackedWrite(intent.profile, () => applyApprovedFutureSeriesSplit(intent.profile,originalTask!,old,pair,state,{approvedPlan:operation.preview.splitPlan,approvedEtag:originalEvent!.etag}), 2);
        });
        await bind(intent.profile,await pair.todoist.getTask(originalTask!.id),await pair.calendar.getEvent(split.mapping.masterEventId||split.mapping.eventId),"todoist");
      } else if(intent.action!=="verify") {
        const mappings=new Map(operation.preview.snapshots.filter(s=>s.mapping).map(s=>[`${s.mapping!.profile}:${s.mapping!.taskId}`,s.mapping!]));
        for(const mapping of mappings.values()) await step(`detach:${mapping.profile}:${mapping.taskId}`,async()=> {
          const clients=await factory(mapping.profile);await writeGate(mapping.profile);await this.controls.reject(mapping.profile,mapping.taskId,mapping.eventId,id);
          await trackedWrite(mapping.profile, () => deleteMappingComments(clients.todoist,mapping), count => count);
          await state.deleteMapping(mapping);await new DynamoReconciliationStore().deleteBaseline(mapping.profile,mapping.taskId);
          if(mapping.seriesId)await state.deleteRecurrenceLink(mapping.profile,mapping.seriesId);return true;
        });
        for(const snapshot of operation.preview.snapshots.filter(s=>s.ref.side==="calendar" && s.object
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
          if(intent.winner==="todoist")event=await step(`align-event:${event.id}`,async()=> {const desired=toCalendarEvent(task,event);return trackedWrite(intent.profile, () => pair.calendar.upsertEventIfUnchanged({...event,...desired,id:event.id,extendedProperties:{...event.extendedProperties,shared:{...event.extendedProperties?.shared,...desired.extendedProperties?.shared}}},event.id,event.etag!));});
          if(intent.winner==="calendar"&&!event.recurrence?.length)task=await step(`align-task:${task.id}`,async()=> trackedWrite(intent.profile, () => task.due?.is_recurring?pair.todoist.updateRecurringOccurrence(task,toTodoistTask(event)):pair.todoist.upsertTask(toTodoistTask(event),task.id)));
          await bind(intent.profile,task,event,intent.owner);
        }
        for(const snapshot of operation.preview.snapshots) {
          const selected=snapshot.ref.id===(snapshot.ref.side==="todoist"?intent.taskId:intent.eventId);
          if(intent.action==="link"&&selected)continue;
          if(!snapshot.object||bindings.has(entityKey(snapshot.ref)))continue;
          if(originalEvent?.recurringEventId===snapshot.ref.id)continue;
          const disposition=intent.action==="exclude"&&selected?"exclude":intent.action==="create"&&selected?"create":intent.leftovers[entityKey(snapshot.ref)];
          if(disposition==="exclude")await this.controls.exclude(snapshot.ref,true,id);
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
        if(!mapping)throw new Error("Mapping does not match the selected pair");
        if(mapping.recurrenceOwner==="calendar"&&mapping.masterEventId){
          const pairClients=await factory(intent.profile),active=await pairClients.calendar.getEvent(mapping.activeInstanceId||mapping.eventId);
          if((originalEvent.id!==mapping.masterEventId&&originalEvent.id!==mapping.eventId)||!hasCanonicalState(active,originalTask))throw new Error("Calendar-owned recurrence is not currently synchronized");
        }else if(mapping.recurrenceOwner==="todoist"&&mapping.masterEventId){
          const pairClients=await factory(intent.profile),master=await pairClients.calendar.getEvent(mapping.masterEventId),active=await pairClients.calendar.getEvent(mapping.activeInstanceId||mapping.eventId);
          if(!calendarRecurrenceMatchesTodoist(master,originalTask)||!recurrenceAnchorMatches(master)||!occurrenceStateMatches(active,originalTask))throw new Error("Todoist-owned recurrence is not currently synchronized");
        }else if(mapping.eventId!==originalEvent.id||!hasCanonicalState(originalEvent,originalTask))throw new Error("Mapping does not match the selected pair");
        verified.push({profile:mapping.profile,taskId:mapping.taskId,eventId:mapping.eventId});
      }
      const outcomes: NonNullable<RepairOperation["outcomes"]> = [];
      for(const snapshot of operation.preview.snapshots) {
        const excluded=await this.controls.control(snapshot.ref);
        if(excluded?.excluded){outcomes.push({entity:entityKey(snapshot.ref),outcome:"excluded",checkedAt:at()});continue;}
        if(verified.some(v=>v.profile===snapshot.ref.profile&&(snapshot.ref.side==="todoist"?v.taskId===snapshot.ref.id:v.eventId===snapshot.ref.id))||["decision","move"].includes(intent.action))continue;
        if(!snapshot.object){
          const current=await this.snapshot(snapshot.ref);
          if(current.object||snapshotFingerprint([expectedMissingSnapshot(snapshot)])!==snapshotFingerprint([current]))throw new Error(`Missing item ${entityKey(snapshot.ref)} changed during repair`);
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"missing",checkedAt:at()});continue;
        }
        const isSelectedRecurringMaster=snapshot.ref.side==="calendar"&&(originalEvent?.recurrence?.length&&intent.eventId===snapshot.ref.id||originalEvent?.recurringEventId===snapshot.ref.id)&&intent.owner==="calendar";
        const contextMaster=snapshot.ref.side==="calendar"&&(originalEvent?.recurringEventId===snapshot.ref.id||Boolean(isSelectedRecurringMaster));
        const splitHistory=splitHistoryMasterId(snapshot);
        if(contextMaster||splitHistory){
          const current=await this.snapshot(snapshot.ref);
          if(splitHistory){
            const master=snapshot.ref.id===splitHistory ? current.object as CalendarEvent|null : await (await factory(snapshot.ref.profile)).calendar.getEvent(splitHistory);
            if(!master||master.extendedProperties?.shared?.syncHistoryOnly!=="true")throw new Error(`Future split history ${entityKey(snapshot.ref)} is not verified`);
          } else if(isSelectedRecurringMaster){
            const master=current.object as CalendarEvent|null;
            if (reviewHash(master) !== reviewHash(snapshot.object)) throw new Error(`Calendar-owned series master ${entityKey(snapshot.ref)} changed during repair`);
            const linkedTaskId=originalTask?.id||verified.find(item=>item.profile===snapshot.ref.profile)?.taskId;
            const mapping=linkedTaskId?await state.getMappingByTask(snapshot.ref.profile,linkedTaskId):undefined;
            const seriesId=master?.iCalUID||master?.id;
            const recurrence=seriesId?await state.getRecurrenceLink(snapshot.ref.profile,seriesId):undefined;
            if(!master?.recurrence?.length||mapping?.recurrenceOwner!=="calendar"||mapping.masterEventId!==master.id||mapping.seriesId!==seriesId||!recurrence||recurrence.taskId!==linkedTaskId||recurrence.masterEventId!==master.id)throw new Error(`Calendar-owned series master ${entityKey(snapshot.ref)} is not verified`);
          } else if(snapshotFingerprint([snapshot])!==snapshotFingerprint([current]))throw new Error(`Context master ${entityKey(snapshot.ref)} changed during repair`);
          outcomes.push({entity:entityKey(snapshot.ref),outcome:"history",checkedAt:at()});continue;
        }
        throw new Error(`Unverified leftover ${entityKey(snapshot.ref)}; repair barrier retained`);
      }
      operation.outcomes=outcomes;
      await this.store.saveOperation(operation);
      // Re-read every affected entity before releasing barriers; external edits
      // become a review outcome rather than being overwritten by delayed events.
      for(const binding of verified){
        const clients=await factory(binding.profile),mapping=await state.getMappingByTask(binding.profile,binding.taskId);
        const [t,e]=await Promise.all([clients.todoist.getTask(binding.taskId),clients.calendar.getEvent(mapping?.activeInstanceId||binding.eventId)]);
        if (mapping?.recurrenceOwner === "todoist" && mapping.masterEventId) {
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
          if(current.object||snapshotFingerprint([expectedMissingSnapshot(snapshot)])!==snapshotFingerprint([current]))throw new Error(`Missing item ${outcome.entity} changed before release`);
          continue;
        }
        const splitHistory=splitHistoryMasterId(snapshot);
        if(splitHistory){
          const master=snapshot.ref.id===splitHistory ? current.object as CalendarEvent|null : await (await factory(snapshot.ref.profile)).calendar.getEvent(splitHistory);
          if(master?.extendedProperties?.shared?.syncHistoryOnly!=="true")throw new Error(`Future split history ${outcome.entity} changed before release`);
          continue;
        }
        const isSelectedMaster=snapshot.ref.side==="calendar"&&(originalEvent?.recurrence?.length&&intent.eventId===snapshot.ref.id||originalEvent?.recurringEventId===snapshot.ref.id)&&intent.owner==="calendar";
        if(isSelectedMaster){
          const master=current.object as CalendarEvent|null, linkedTaskId=originalTask?.id||verified.find(item=>item.profile===snapshot.ref.profile)?.taskId;
          if (reviewHash(master) !== reviewHash(snapshot.object)) throw new Error(`Calendar-owned series master ${outcome.entity} changed before release`);
          const mapping=linkedTaskId?await state.getMappingByTask(snapshot.ref.profile,linkedTaskId):undefined;
          const seriesId=master?.iCalUID||master?.id, recurrence=seriesId?await state.getRecurrenceLink(snapshot.ref.profile,seriesId):undefined;
          if(!master?.recurrence?.length||mapping?.recurrenceOwner!=="calendar"||mapping.masterEventId!==master.id||mapping.seriesId!==seriesId||!recurrence||recurrence.taskId!==linkedTaskId||recurrence.masterEventId!==master.id)throw new Error(`Calendar-owned series master ${outcome.entity} changed before release`);
        } else if(snapshotFingerprint([snapshot])!==snapshotFingerprint([current]))throw new Error(`Retained history ${outcome.entity} changed before release`);
      }
      for(const snapshot of operation.preview.snapshots){
        if(bindings.has(entityKey(snapshot.ref)))await this.controls.exclude(snapshot.ref,false,id);
        if(intent.action==="move"&&snapshot.ref.side==="todoist"&&snapshot.ref.id===intent.taskId){
          const moved=await(await factory(intent.targetProfile!)).todoist.getTask(snapshot.ref.id);
          await this.controls.release(snapshot.ref,id,moved.updated_at);continue;
        }
        const live=await this.snapshot(snapshot.ref);await this.controls.release(snapshot.ref,id,(live.object as TodoistTask)?.updated_at || (live.object as CalendarEvent)?.updated);
      }
      if(targetTaskRef){
        const moved=await this.snapshot(targetTaskRef);
        await this.controls.exclude(targetTaskRef,false,id);
        await this.controls.release(targetTaskRef,id,(moved.object as TodoistTask|null)?.updated_at);
      }
      operation.status="succeeded";operation.error=undefined;operation.nextAction=undefined;operation.verified=verified;
      await this.store.updateCase(intent.caseId,intent.action==="exclude"?"excluded":"resolved","Repair verified against current provider state",id);
      if(operation.preview.case.decision)await new ManualInterventionService().finishReconciliationDecision(operation.preview.case.decision.decisionId,"Resolved and verified in the review page");
    } catch(e) {
      if (claimed && !operation.steps.validated && !Object.values(operation.steps).some(s=>s.status==="done"&&s.id!=="validated")) {
        for (const ref of operation.preview.snapshots.map(s=>s.ref)) await this.controls.release(ref,id).catch(()=>undefined);
        if (intent.action==="move"&&intent.targetProfile&&intent.taskId) await this.controls.release({profile:intent.targetProfile,side:"todoist",id:intent.taskId},id).catch(()=>undefined);
      }
      operation.status=Object.values(operation.steps).some(s=>s.status==="done"&&s.id!=="validated")?"needs_review":"failed";
      operation.error=e instanceof Error?e.message:String(e);operation.nextAction="Review live state. Resume this operation for an interrupted write, or refresh an unapplied stale preview.";
      await this.store.updateCase(intent.caseId,"open",operation.error,id);
    }
    operation.notificationPending=true;operation.notificationText=`${operation.status === "succeeded"?"Succeeded":operation.status === "needs_review"?"Needs review":"Failed"}: ${operation.error||"repair verified"}`;
    await this.store.saveOperation(operation);return operation;
  }
}

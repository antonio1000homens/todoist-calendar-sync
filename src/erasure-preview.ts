import { randomUUID } from "node:crypto";
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient, pacingDelayMs, scanPageItemLimit } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { buildProjectMappingIndex, LEGACY_TASK_COMMENT_MARKERS } from "./mapping-comments.js";
import { inspectErasureFence } from "./erasure-protocol.js";
import { ERASURE_BACKUP_RETENTION_NOTICE, erasurePreviewFingerprint, type ErasureOperation } from "./erasure-executor.js";
import {observeCrossProfileErasureEvidence,type CrossProfileErasureEvidence} from "./erasure-cross-profile-evidence.js";
import type {VerifiedCalendarProvenance} from "./erasure-calendar-provenance.js";
import { exactCalendarEventIds, fingerprint, planPurge, type PurgeTarget } from "../scripts/item-purge-policy.mjs";
import {summarizeErasureDeliveryReceipts,type ErasureDeliveryReceiptAudit} from "./erasure-delivery-receipt-audit.js";
import { calendarEventGoneOnDirectRead } from "./sync.js";
import type { Profile } from "./types.js";

export interface ErasurePreviewRequest {
  profile: Profile;
  taskId: string;
  eventId?: string;
  deleteCalendar: boolean;
}

/** Exact direct-read results for the configured profile only.
 * These statuses NEVER assert that unknown shared/legacy Calendars are empty. */
export interface KnownTargetReadback {
  todoist: "present" | "absent" | "unknown";
  calendar: "present" | "absent" | "unknown" | "not_recorded";
  configuredCalendarLink: "present" | "not_found";
}

export interface ErasurePreviewResult {
  operationId: string;
  profile: Profile;
  target: ErasureOperation["target"];
  selectedActions: ErasureOperation["selectedActions"];
  previewFingerprint: string;
  providerSnapshotFingerprint: string;
  inventoryDigest: string;
  inventory: ErasureOperation["inventory"];
  actionPlan: NonNullable<ErasureOperation["actionPlan"]>;
  knownTargetReadback?: KnownTargetReadback;
  backupRetentionNotice: string;
  classificationCounts: Record<string, number>;
  blockers: string[];
  crossProfileEvidence?:CrossProfileErasureEvidence;
  deliveryReceiptAudit?:ErasureDeliveryReceiptAudit;
  confirmation?: { confirmationId: string; expiresAt: number };
}

type Dependencies = {
  db?: Pick<DynamoDBDocumentClient, "send">;
  clients?: Awaited<ReturnType<typeof defaultProviderClientFactory>>;
  providerFactory?: typeof defaultProviderClientFactory;
  inspectFence?: typeof inspectErasureFence;
  newOperationId?: () => string;
  ignoreOperationId?: string;
  allowFenceOperationId?: string;
  allowJournalOperationId?: string;
  allowLeaseOwner?: string;
  scanDeadlineMs?: number;
  scanAbortSignal?:AbortSignal;
  onInventoryProgress?:(progress:{pages:number;rowCount:number;consumedCapacityUnits:number;elapsedMs:number})=>void;
  auditCrossProfileIdentity?:boolean;
  calendarProvenance?:VerifiedCalendarProvenance;
  auditDeliveryReceipts?:boolean;
  sleep?: (ms: number) => Promise<void>;
};

function tableName(): string {
  const value = process.env.STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}

function validateTarget(target: ErasurePreviewRequest): PurgeTarget {
  if (!target || !["home", "antonio", "work"].includes(target.profile)
    || typeof target.taskId !== "string" || !/^[A-Za-z0-9_.-]{1,256}$/.test(target.taskId)
    || (target.eventId !== undefined && (typeof target.eventId !== "string" || !/^[A-Za-z0-9_.-]{1,1024}$/.test(target.eventId)))
    || typeof target.deleteCalendar !== "boolean" || (target.deleteCalendar && !target.eventId))
    throw new Error("Exact profile, Todoist task, selected actions, and any Calendar event are required");
  return { profile: target.profile, taskId: target.taskId, ...(target.eventId ? { eventId: target.eventId } : {}) };
}

class ErasurePreviewDeadlineError extends Error {
  readonly status=503;
  constructor() { super("Full inventory did not finish within the preview window; no confirmation was issued. Retry or use the guarded operator CLI."); }
}

async function scanAll(db: Pick<DynamoDBDocumentClient, "send">, dependencies: Dependencies): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seenCursors=new Set<string>();
  const seenKeys=new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  const started=Date.now();
  const deadline=started+(dependencies.scanDeadlineMs??80_000);
  let pages=0,consumedCapacityUnits=0;
  const sleep=dependencies.sleep || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  do {
    if(Date.now()>=deadline) throw new ErasurePreviewDeadlineError();
    if(cursor) {
      const cursorKey=JSON.stringify(cursor);
      if(seenCursors.has(cursorKey))throw new Error("Strong state inventory repeated a pagination cursor");
      seenCursors.add(cursorKey);
    }
    const pageStarted=Date.now();
    let result;
    for(let attempt=0;;attempt++) {
      try {
        result=await db.send(new ScanCommand({TableName:tableName(),ConsistentRead:true,Limit:scanPageItemLimit(),
          ExclusiveStartKey:cursor,ReturnConsumedCapacity:"TOTAL"}),
        dependencies.scanAbortSignal?{abortSignal:dependencies.scanAbortSignal}:undefined);
        break;
      } catch(error) {
        const name=(error as {name?:string})?.name;
        if(!["ThrottlingException","ProvisionedThroughputExceededException","RequestLimitExceeded"].includes(name||"")
          ||attempt>=6) throw error;
        await sleep(Math.min(8000,250*2**attempt));
      }
    }
    for(const row of (result.Items||[]) as Record<string,unknown>[]) {
      if(typeof row.pk!=="string"||typeof row.sk!=="string")
        throw new Error("Strong state inventory returned a row without its exact key");
      const rowKey=JSON.stringify([row.pk,row.sk]);
      if(seenKeys.has(rowKey))throw new Error("Strong state inventory repeated a row across pages");
      seenKeys.add(rowKey);rows.push(row);
    }
    pages++;
    consumedCapacityUnits+=Number(result.ConsumedCapacity?.CapacityUnits||0);
    dependencies.onInventoryProgress?.({pages,rowCount:rows.length,consumedCapacityUnits,elapsedMs:Date.now()-started});
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if(cursor) await sleep(pacingDelayMs(Number(result.ConsumedCapacity?.CapacityUnits||0),Date.now()-pageStarted));
  } while (cursor);
  if(Date.now()>=deadline) throw new ErasurePreviewDeadlineError();
  return rows;
}

function providerBlockers(data: {
  task: any; event: any; linked: any; comments: any[]; legacy: any[]; malformed: any[];
}, target: PurgeTarget, deleteCalendar: boolean): string[] {
  const blockers: string[] = [];
  if (data.task && (typeof data.task.id !== "string" || data.task.id !== target.taskId))
    blockers.push("Todoist response is missing or has a different task identity");
  if (data.task && (typeof data.task.project_id !== "string" || data.task.project_id !== profiles[target.profile].todoistProjectId))
    blockers.push("Todoist response is missing or has a different project identity");
  if (data.event && (typeof data.event.id !== "string" || data.event.id !== target.eventId))
    blockers.push("Calendar response is missing or has a different event identity");
  if (data.task?.due?.is_recurring) blockers.push("Recurring Todoist task: series must be investigated manually");
  if (data.event?.recurrence?.length || data.event?.recurringEventId) blockers.push("Recurring Calendar item: series/exception requires manual handling");
  if (data.event && !deleteCalendar) blockers.push("Calendar item exists; select and confirm its exact deletion or handle re-import risk manually");
  if (data.event?.extendedProperties?.shared?.taskId && data.event.extendedProperties.shared.taskId !== target.taskId)
    blockers.push("Selected Calendar event is linked to a different Todoist task");
  if (data.linked && (!target.eventId || typeof data.linked.id !== "string" || data.linked.id !== target.eventId)) blockers.push("Another or unidentifiable Calendar projection links to this task; manual inspection required");
  if (data.linked && !deleteCalendar) blockers.push("A live Calendar projection would recreate the Todoist task unless separately deleted");
  if (data.linked?.recurrence?.length || data.linked?.recurringEventId) blockers.push("Linked Calendar recurrence needs manual handling");
  if (data.comments.some(item => item.profile !== target.profile || item.taskId !== target.taskId || item.eventId !== target.eventId || item.seriesId))
    blockers.push("Project mapping comment belongs to another item or recurrence");
  if (data.malformed.length) blockers.push("Unparseable mapping comments contain the selected identity");
  if (data.legacy.some(item => !target.eventId || item.eventId !== target.eventId)) blockers.push("Legacy task comments refer to another or unknown Calendar event");
  return blockers;
}

/** Read the exact DynamoDB/provider inventory; this function never mutates provider or state records. */
export async function buildErasurePreview(input: ErasurePreviewRequest, dependencies: Dependencies = {}): Promise<ErasurePreviewResult> {
  const target = validateTarget(input);
  const db = dependencies.db || documentClient;
  const [allRows, providerClients] = await Promise.all([
    scanAll(db,dependencies), dependencies.clients ? Promise.resolve(dependencies.clients)
      : (dependencies.providerFactory || defaultProviderClientFactory)(target.profile),
  ]);
  const rows = allRows.filter(row => row.pk !== `ERASURE#${target.profile}`
    && !(dependencies.ignoreOperationId && (row.pk===`ERASURE_OPERATION#${dependencies.ignoreOperationId}`
      || row.pk===`ERASURE_CONFIRMATION#${dependencies.ignoreOperationId}`)));
  const plan = planPurge(rows, target);
  const todoistMissing = (error: unknown) => Number((error as { status?: number })?.status) === 404;
  let task: any, event: any, directEventIdentity:any;
  let taskMissing = false, eventMissing = false;
  try { task = await providerClients.todoist.getTask(target.taskId); }
  catch (error) { if (!todoistMissing(error)) throw error; taskMissing = true; }
  if (target.eventId) {
    try {
      event = await providerClients.calendar.getEvent(target.eventId);
      directEventIdentity=event;
      // A cancelled item is absent for purge purposes only after the provider
      // response proves it is the exact requested event. A malformed or
      // mismatched response must flow through providerBlockers and fail closed.
      if (event?.status === "cancelled" && event.id === target.eventId) { event = undefined; eventMissing = true; }
    }
    catch (error) { if (!calendarEventGoneOnDirectRead(error)) throw error; eventMissing = true; }
  }
  const [linkedResult, projectComments] = await Promise.all([
    providerClients.calendar.findByTodoistTaskId(target.taskId),
    providerClients.todoist.listProjectComments(profiles[target.profile].todoistProjectId, true),
  ]);
  // A cancelled lookup result is absence only when it identifies the exact
  // selected Calendar event. Without an explicit event target, or with an
  // absent/mismatched ID, retain it so providerBlockers fails closed.
  const linked = linkedResult?.status === "cancelled" && target.eventId && linkedResult.id === target.eventId
    ? undefined : linkedResult;
  const indexed = buildProjectMappingIndex(projectComments);
  const relevant = indexed.parsed.filter(item => item.payload.taskId === target.taskId || item.payload.eventId === target.eventId);
  const malformed = indexed.malformed.filter(item => item.comment.content?.includes(target.taskId)
    || (target.eventId && item.comment.content?.includes(target.eventId)));
  // Task-scoped comments may outlive a task. Inventory them even when the
  // task itself is already absent, so deletion can prove no breadcrumb remains.
  const taskComments = await providerClients.todoist.listTaskComments(target.taskId);
  const legacy: Array<{ id: string; eventId?: string; digest: string }> = taskComments
    .filter(comment => LEGACY_TASK_COMMENT_MARKERS.has(String(comment.content || "").split(/\r?\n/)[0]))
    .map(comment => ({ id: comment.id, digest: fingerprint(comment.content), eventId: String(comment.content || "").split(/\r?\n/)
      .find(line => line.startsWith("calendarEventId="))?.slice("calendarEventId=".length) }));
  const providerData = {
    task, event, linked,
    comments: relevant.map(item => ({ id: item.comment.id, contentDigest: fingerprint(item.comment.content),
      profile: item.payload.profile, taskId: item.payload.taskId, eventId: item.payload.eventId, seriesId: item.payload.seriesId })),
    legacy, malformed: malformed.map(item => ({ id: item.comment.id, error: item.error })),
  };
  const blockers = [...new Set([...plan.blockers, ...providerBlockers(providerData, target, input.deleteCalendar)])].sort();
  if (!task && !taskMissing) blockers.push("Todoist returned no task without an explicit not-found response");
  if (target.eventId && !event && !eventMissing)
    blockers.push("Calendar returned no event without an explicit not-found response");
  if (input.deleteCalendar && event && (typeof event.etag!=="string"||!event.etag))
    blockers.push("Calendar event has no ETag for conditional deletion; refresh or use manual review");
  const protocol = await (dependencies.inspectFence || inspectErasureFence)(target.profile);
  const journal = await db.send(new GetCommand({ TableName: tableName(), Key: { pk: `ERASURE#${target.profile}`, sk: "JOURNAL" }, ConsistentRead: true }));
  if (journal.Item && journal.Item.operationId !== dependencies.allowJournalOperationId)
    blockers.push("A prior item-erasure journal exists for this profile; break-glass review is required before another preview");
  if (protocol.fence && protocol.fence.operationId !== dependencies.allowFenceOperationId)
    blockers.push("A profile erasure fence is active; preserve protections and use the break-glass recovery procedure");
  if (protocol.leases.some(lease=>lease.owner!==dependencies.allowLeaseOwner))
    blockers.push("Provider work leases are active; retry only after they have drained");
  const operationId = (dependencies.newOperationId || randomUUID)();
  const selectedActions = { deleteTodoist: true, deleteCalendar: input.deleteCalendar };
  const inventory = plan.records.map(record => ({ type: record.type, key: { pk: record.pk, sk: record.sk },
    digest: record.digest, classification: record.classification }));
  const knownAliases=new Map<string,{profile:Profile;calendarId:string;eventId:string}>();
  let knownAliasesComplete=true;
  const addKnownAlias=(profile:Profile,calendarId:string,eventId:string)=>{
    if(!/^[^\u0000-\u001f\u007f]{1,1024}$/.test(calendarId)
      ||!/^[A-Za-z0-9_.-]{1,1024}$/.test(eventId)) {
      knownAliasesComplete=false;
      return;
    }
    knownAliases.set(JSON.stringify([profile,calendarId,eventId]),{profile,calendarId,eventId});
  };
  if(target.eventId)addKnownAlias(target.profile,profiles[target.profile].calendarId,target.eventId);
  for(const source of [directEventIdentity,linkedResult]) {
    if(source&&typeof source.id==="string")
      addKnownAlias(target.profile,profiles[target.profile].calendarId,source.id);
    if(source&&typeof source.recurringEventId==="string")
      addKnownAlias(target.profile,profiles[target.profile].calendarId,source.recurringEventId);
  }
  const selectedRowKeys=new Set(plan.records.map(record=>JSON.stringify([record.pk,record.sk])));
  for(const row of rows) {
    if(!selectedRowKeys.has(JSON.stringify([row.pk,row.sk])))continue;
    const eventIds=exactCalendarEventIds(row);
    if(!eventIds.length)continue;
    const keyProfiles=String(row.pk).split("#").filter((value):value is Profile=>
      value==="home"||value==="antonio"||value==="work");
    const rowProfile=typeof row.profile==="string"&&(row.profile==="home"||row.profile==="antonio"||row.profile==="work")
      ?row.profile:keyProfiles.length===1?keyProfiles[0]:undefined;
    if(!rowProfile||(new Set(keyProfiles).size>1)
      ||(keyProfiles.length===1&&keyProfiles[0]!==rowProfile)) {
      knownAliasesComplete=false;
      blockers.push("A recorded Calendar alias has no unambiguous profile scope");
      continue;
    }
    const calendarId=typeof row.calendarId==="string"?row.calendarId:profiles[rowProfile].calendarId;
    for(const eventId of eventIds)addKnownAlias(rowProfile,calendarId,eventId);
  }
  const allKnownAliases=[...knownAliases.values()].sort((a,b)=>
    a.profile.localeCompare(b.profile)||a.calendarId.localeCompare(b.calendarId)||a.eventId.localeCompare(b.eventId));
  if(allKnownAliases.length>32) {
    knownAliasesComplete=false;
    blockers.push("Recorded Calendar aliases exceed the bounded replay-marker limit; manual handling is required");
  }
  if(!knownAliasesComplete)
    blockers.push("The operation's exact Calendar alias manifest is incomplete; no deletion confirmation is available");
  const boundedKnownAliases=allKnownAliases.slice(0,32);
  const crossProfileEvidence=dependencies.auditCrossProfileIdentity?await observeCrossProfileErasureEvidence({
    taskId:target.taskId,eventId:target.eventId,rows,fullRows:allRows,
    calendarProvenance:dependencies.calendarProvenance,
    readerForProfile:async profile=>profile===target.profile?providerClients
      :(dependencies.providerFactory || defaultProviderClientFactory)(profile),
  }):undefined;
  const providerSnapshotFingerprint = fingerprint(crossProfileEvidence
    ?{primary:providerData,crossProfileEvidence}:providerData);
  const actionPlan = { todoistTask: task ? { id: target.taskId, digest: fingerprint(task) } : undefined,
    calendarEvent: event ? { id: target.eventId!,calendarId:profiles[target.profile].calendarId,
      digest: fingerprint(event), etag:event.etag as string } : undefined,
    knownCalendarAliases:boundedKnownAliases,knownCalendarAliasesComplete:knownAliasesComplete,
    comments: [
      ...relevant.map(item => ({ id: item.comment.id, kind: "project" as const, digest: fingerprint(item.comment.content) })),
      ...legacy.map(item => ({ id: item.id, kind: "task" as const, digest: item.digest })),
    ].sort((a,b)=>a.id.localeCompare(b.id)) };
  const operationPreview = { operationId, profile: target.profile, target: { ...target, deleteCalendar: input.deleteCalendar },
    selectedActions, inventory, providerSnapshotFingerprint, actionPlan };
  const deliveryReceiptAudit=dependencies.auditDeliveryReceipts
    ?summarizeErasureDeliveryReceipts(allRows,target.profile):undefined;
  return {
    operationId, profile: target.profile, target: operationPreview.target, selectedActions,
    previewFingerprint: erasurePreviewFingerprint(operationPreview), providerSnapshotFingerprint, inventoryDigest: plan.inventoryDigest,
    inventory: plan.records.map(record => ({ type: record.type, key: { pk: record.pk, sk: record.sk },
      digest: record.digest, classification: record.classification })),
    actionPlan,
    // From fresh exact provider GETs only. The link lookup is limited to the
    // configured Calendar and cannot rule out unrecorded historical copies.
    knownTargetReadback: {
      todoist: task ? "present" : taskMissing ? "absent" : "unknown",
      calendar: !target.eventId ? "not_recorded" : event ? "present" : eventMissing ? "absent" : "unknown",
      configuredCalendarLink: linked ? "present" : "not_found",
    },
    backupRetentionNotice: ERASURE_BACKUP_RETENTION_NOTICE,
    classificationCounts: plan.counts, blockers: [...new Set(blockers)].sort(),
    ...(crossProfileEvidence?{crossProfileEvidence}:{}),
    ...(deliveryReceiptAudit?{deliveryReceiptAudit}:{}),
  };
}

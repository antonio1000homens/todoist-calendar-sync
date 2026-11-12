import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient as client } from "./dynamodb-capacity.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { CalendarEvent, Mapping, Profile, RecurrenceLink } from "./types.js";
import { verifyCancelledSeries } from "./verified-deletion.js";
import { retainedAuditProviderIds, retainedConflictEntity, retainedConflictIdentity } from "./audit-policy.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { entityKey, operationHasWriteEvidence, type EntityRef, type RepairOperation, type RepairPreview, type RepairRelease, type ReviewActor, type ReviewCase, type ReviewSnapshot } from "./review-types.js";
import { assertReplayAdmissionIfEnabled, ErasureReplayBlockedError, REPLAY_PROFILES } from "./erasure-replay-barrier.js";
import { activeProjectDeletionTombstone } from "./mapping-comments.js";
import { profiles, todoistToken } from "./config.js";
import { Todoist } from "./providers.js";
type VerifiedDeletionEvidence = {
  profile: Profile; taskIds: string[]; eventIds: string[];
  staleMappings?: Mapping[];
  staleMappingRows?: Array<{ pk: string; sk: string; profile: Profile; taskId: string; eventId: string; updatedAt: string }>;
  staleLinks?: RecurrenceLink[]; seriesKeys?: string[];
  masterId?: string; activeInstanceId?: string; masterSeriesId?: string;
  legacyMasterProof?: { master: CalendarEvent; occurrence: CalendarEvent };
};
type VerifiedDeletionTransaction = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>;
type HistoricalRetirementAuthorization = {
  checkpoint: { fingerprint: string; owner: string };
  scope?: { owner: string; version: number; operationId: string; epoch: number };
};
type ProjectCommentClientFactory = (profile: Profile) => Promise<{todoist: Pick<Todoist, "listProjectComments">}>;
const defaultProjectCommentClientFactory: ProjectCommentClientFactory = async profile =>
  ({todoist:new Todoist(await todoistToken(profile))});
export function reviewTable(): string { if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required"); return process.env.STATE_TABLE_NAME; }
export function reviewHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
const key = (pk: string) => ({ pk, sk: "STATE" });
const conditional = (e: unknown) => (e as { name?: string }).name === "ConditionalCheckFailedException";
const dismissalResolutions = new Set(["acknowledge","keep_separate","ignore","dismiss","dismissed"]);
async function admitReviewIdentities(refs: Iterable<EntityRef>, clientFactory: ProjectCommentClientFactory): Promise<void> {
  const unique = new Map<string, EntityRef>();
  for (const ref of refs) unique.set(entityKey(ref), ref);
  for (const ref of unique.values()) await assertReplayAdmissionIfEnabled({ profile: ref.profile,
    ...(ref.side === "todoist" ? { taskId: ref.id } : { eventIds: [ref.id] }) });

  // The bounded tombstone lives only in the Todoist project comment after
  // successful erasure. Old review/repair decisions are another replay source,
  // so an enabled writer protocol must consult that marker before recording or
  // executing a decision that carries the deleted identity.
  if (process.env.ERASURE_PROTOCOL_VERSION !== "1") return;
  const byProfile = new Map<Profile, EntityRef[]>();
  for (const ref of unique.values()) byProfile.set(ref.profile, [...(byProfile.get(ref.profile) || []), ref]);
  for (const [profile, profileRefs] of byProfile) {
    const clients = await clientFactory(profile);
    const projectId = profiles[profile].todoistProjectId;
    const comments = await clients.todoist.listProjectComments(projectId, true);
    for (const ref of profileRefs) if (activeProjectDeletionTombstone(comments, {
      profile, projectId,
      ...(ref.side === "todoist" ? { taskId: ref.id } : { eventIds: [ref.id] }),
    })) throw new ErasureReplayBlockedError();
  }
}
function nestedReviewIdentities(value: unknown, defaultProfile: Profile,
  terminal?: { seriesKeys: string[] },
): EntityRef[] {
  const refs = new Map<string, EntityRef>();
  const taskFields = new Set(["taskId","providerTaskId","linkedTaskId","ownerTaskId","discardedTaskId","retainedTaskId","masterTaskId"]);
  const eventFields = new Set(["eventId","providerEventId","masterEventId","recurringMasterId","masterId",
    "activeInstanceId","occurrenceId","selectedEventId","seriesId","calendarProjectionId",
    "oldMasterId","newMasterId","lastEventId","previousEventId","cancelledEventId",
    "syncHistoryMasterId","recurringEventId","originalEventId","activeCalendarId","afterEventId",
    "consolidationCancelledEventId","consolidationMasterEventId","contextEventId","existingActiveInstanceId",
    "existingMasterId","metadataEventId","masterSeriesId","preferredEventId","providerSeriesId",
    "reconcileAfterEventId","recoveredEventId","sourceEventId","splitHistoryMasterId",
    "syncFlattenOccurrenceId"]);
  const taskArrayFields = new Set(["taskIds","candidateTaskIds"]);
  const eventArrayFields = new Set(["eventIds","candidateEventIds"]);
  const add = (profile: Profile, side: EntityRef["side"], id: string) => {
    const ref = {profile,side,id}; refs.set(entityKey(ref),ref);
  };
  const collect = (item: unknown, profile: Profile, field = ""): void => {
    if (Array.isArray(item)) {
      if (taskArrayFields.has(field)) for (const id of item) if (typeof id === "string" && id) add(profile,"todoist",id);
      if (eventArrayFields.has(field)) for (const id of item) if (typeof id === "string" && id) add(profile,"calendar",id);
      // ManualDecision.context.candidates is a Todoist-task candidate list
      // whose provider IDs are stored as `id`, unlike named identity fields.
      if (field === "candidates") for (const candidate of item) {
        if (!candidate || typeof candidate !== "object") continue;
        const candidateObject = candidate as Record<string,unknown>;
        const candidateProfile = terminal && REPLAY_PROFILES.includes(candidateObject.profile as Profile)
          ? candidateObject.profile as Profile : profile;
        if (typeof candidateObject.id === "string" && candidateObject.id) add(candidateProfile,"todoist",candidateObject.id);
      }
      for (const child of item) collect(child,profile,field);
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item as Record<string,unknown>;
    const selectedProfile = typeof object.profile === "string" && REPLAY_PROFILES.includes(object.profile as Profile)
      ? object.profile as Profile : profile;
    if (terminal && typeof object.id === "string" && object.id && (object.side === "todoist" || object.side === "calendar"))
      add(selectedProfile, object.side, object.id);
    for (const [name,child] of Object.entries(object)) {
      if (typeof child === "string" && child && taskFields.has(name)) add(selectedProfile,"todoist",child);
      const verifiedSeriesKey = terminal && selectedProfile === defaultProfile
        && (name === "seriesId" || name === "masterSeriesId") && terminal.seriesKeys.includes(child as string);
      if (typeof child === "string" && child && eventFields.has(name) && !verifiedSeriesKey)
        add(selectedProfile,"calendar",child);
      collect(child,selectedProfile,name);
    }
  };
  collect(value,defaultProfile);
  return [...refs.values()];
}
async function admitReviewIdentity(profile: Profile, taskId?: string, eventId?: string): Promise<void> {
  const refs: EntityRef[] = [];
  if (taskId) refs.push({profile,side:"todoist",id:taskId});
  if (eventId) refs.push({profile,side:"calendar",id:eventId});
  await admitReviewIdentities(refs,defaultProjectCommentClientFactory);
}
async function admitEntityRef(ref: EntityRef): Promise<void> {
  await admitReviewIdentities([ref],defaultProjectCommentClientFactory);
}
async function admitNestedReviewIdentities(value: unknown, defaultProfile: Profile): Promise<void> {
  await admitReviewIdentities(nestedReviewIdentities(value,defaultProfile),defaultProjectCommentClientFactory);
}
/** Check all provider identities retained by a manual decision before the
 * decision itself is written or changed. */
export async function assertManualDecisionReplayAdmission(decision: ManualDecision,
  clientFactory: ProjectCommentClientFactory = defaultProjectCommentClientFactory): Promise<void> {
  await admitReviewIdentities(nestedReviewIdentities(decision, decision.profile), clientFactory);
}
export async function assertRepairPreviewReplayAdmission(preview: RepairPreview,
  clientFactory: ProjectCommentClientFactory = defaultProjectCommentClientFactory): Promise<void> {
  const refs = new Map<string, EntityRef>();
  for (const ref of nestedReviewIdentities(preview,preview.intent.profile)) refs.set(entityKey(ref),ref);
  for (const snapshot of preview.snapshots || []) refs.set(entityKey(snapshot.ref), snapshot.ref);
  for (const planned of preview.itemPlan || []) refs.set(entityKey(planned.ref), planned.ref);
  for (const snapshot of preview.snapshots || []) if (snapshot.mapping) {
    const mapping = snapshot.mapping;
    refs.set(entityKey({profile:mapping.profile,side:"todoist",id:mapping.taskId}),
      {profile:mapping.profile,side:"todoist",id:mapping.taskId});
    refs.set(entityKey({profile:mapping.profile,side:"calendar",id:mapping.eventId}),
      {profile:mapping.profile,side:"calendar",id:mapping.eventId});
    for (const id of [mapping.masterEventId,mapping.activeInstanceId]) if (id)
      refs.set(entityKey({profile:mapping.profile,side:"calendar",id}),
        {profile:mapping.profile,side:"calendar",id});
  }
  const intent: EntityRef[] = [
    ...(preview.intent.taskId ? [{ profile: preview.intent.profile, side: "todoist" as const, id: preview.intent.taskId }] : []),
    ...(preview.intent.eventId ? [{ profile: preview.intent.profile, side: "calendar" as const, id: preview.intent.eventId }] : []),
    ...(preview.intent.action === "move" && preview.intent.targetProfile && preview.intent.taskId
      ? [{profile:preview.intent.targetProfile,side:"todoist" as const,id:preview.intent.taskId}] : []),
  ];
  await admitReviewIdentities([...refs.values(), ...intent], clientFactory);
}
export class ReviewStore {
  /** Safe, case-scoped reason from the most recent verified-deletion attempt. */
  lastVerifiedDeletionBlocker?: string;
  async getHistoricalCleanupCheckpoint(caseId:string):Promise<Record<string,unknown>|undefined>{
    return (await this.db.send(new GetCommand({TableName:reviewTable(),Key:{pk:`HISTORICAL_CLEANUP#${caseId}`,sk:"OP"},ConsistentRead:true}))).Item as Record<string,unknown>|undefined;
  }
  async inventoryVerifiedDeletedMappings(profile:Profile,taskIds:string[],eventIds:string[]):Promise<Array<{
    pk:string;sk:string;profile:Profile;taskId:string;eventId:string;updatedAt:string;
  }>>{
    const candidates:Profile[]=["home","antonio","work"],rows:Array<{pk:string;sk:string;profile:Profile;taskId:string;eventId:string;updatedAt:string}>=[];
    const keys=new Map<string,{pk:string;sk:string}>();
    for(const taskId of taskIds){
      for(const candidate of candidates)keys.set(`TASK#${candidate}#${taskId}|MAP`,{pk:`TASK#${candidate}#${taskId}`,sk:"MAP"});
      keys.set(`TASKOWNER#${taskId}|MAP`,{pk:`TASKOWNER#${taskId}`,sk:"MAP"});
    }
    for(const eventId of eventIds)for(const candidate of candidates)
      keys.set(`EVENT#${candidate}#${eventId}|MAP`,{pk:`EVENT#${candidate}#${eventId}`,sk:"MAP"});
    for(const keyValue of keys.values()){
      const result=await this.db.send(new GetCommand({TableName:reviewTable(),Key:keyValue,ConsistentRead:true}));
      const row=result.Item as Record<string,unknown>|undefined;if(!row)continue;
      const taskId=typeof row.taskId==="string"?row.taskId:"",eventId=typeof row.eventId==="string"?row.eventId:"";
      if(![...taskIds].includes(taskId)||!eventIds.includes(eventId)||row.profile!==profile
        ||typeof row.updatedAt!=="string")throw new Error("cross_profile_or_foreign_task_mapping");
      rows.push({...keyValue,profile,taskId,eventId,updatedAt:row.updatedAt});
    }
    return rows;
  }
  /** Strongly consistent base-table identity scan used by fenced scoped
   * admission. A partial or over-limit scan can never authorize a writer. */
  async inventoryScopedIdentityRows(taskIds:string[],eventIds:string[]):Promise<{
    complete:boolean;rows:Array<{pk:string;sk:string;matchedTaskIds:string[];matchedEventIds:string[];
      profile?:unknown;status?:unknown;activeRepair?:unknown;excluded?:unknown;taskId?:unknown;eventId?:unknown;expiresAt?:unknown;fingerprint:string}>;
  }>{
    const identities=[...new Set([...taskIds,...eventIds])];
    if(!identities.length)return {complete:false,rows:[]};
    let cursor:Record<string,unknown>|undefined,pages=0,visited=0;
    const rows:Array<{pk:string;sk:string;matchedTaskIds:string[];matchedEventIds:string[];
      profile?:unknown;status?:unknown;activeRepair?:unknown;excluded?:unknown;taskId?:unknown;eventId?:unknown;expiresAt?:unknown;fingerprint:string}>= [];
    do{
      if(++pages>100)return {complete:false,rows:[]};
      const page=await this.db.send(new ScanCommand({TableName:reviewTable(),ConsistentRead:true,Limit:1000,
        ...(cursor?{ExclusiveStartKey:cursor}:{})}));
      visited+=(page.Items||[]).length;
      if(visited>100_000)return {complete:false,rows:[]};
      for(const raw of page.Items||[]){
        const item=raw as Record<string,unknown>;
        if(typeof item.pk!=="string"||typeof item.sk!=="string")return {complete:false,rows:[]};
        const serialized=JSON.stringify(item);
        const keyText=item.pk+"\u0000"+item.sk;
        const matches=(id:string)=>serialized.includes(JSON.stringify(id))||keyText.includes(id);
        const matchedTaskIds=taskIds.filter(matches),matchedEventIds=eventIds.filter(matches);
        if(matchedTaskIds.length||matchedEventIds.length)rows.push({pk:item.pk,sk:item.sk,matchedTaskIds,matchedEventIds,
          ...(item.profile!==undefined?{profile:item.profile}:{}),...(item.status!==undefined?{status:item.status}:{}),
          ...(item.activeRepair!==undefined?{activeRepair:item.activeRepair}:{}),...(item.excluded!==undefined?{excluded:item.excluded}:{}),
          ...(item.taskId!==undefined?{taskId:item.taskId}:{}),...(item.eventId!==undefined?{eventId:item.eventId}:{}),
          ...(item.expiresAt!==undefined?{expiresAt:item.expiresAt}:{}),
          fingerprint:createHash("sha256").update(serialized).digest("hex")});
      }
      cursor=page.LastEvaluatedKey as Record<string,unknown>|undefined;
    }while(cursor);
    return {complete:true,rows:rows.sort((a,b)=>`${a.pk}\u0000${a.sk}`.localeCompare(`${b.pk}\u0000${b.sk}`))};
  }
  /** Durable per-case progress with a short lease; retries resume only the same exact identity set. */
  async saveHistoricalCleanupCheckpoint(input:{caseId:string;profile:Profile;fingerprint:string;owner:string;
    patch:Record<string,unknown>;release?:boolean}):Promise<boolean>{
    const pk=`HISTORICAL_CLEANUP#${input.caseId}`;
    const now=Date.now();
    const current=(await this.db.send(new GetCommand({TableName:reviewTable(),Key:{pk,sk:"OP"},ConsistentRead:true}))).Item as Record<string,unknown>|undefined;
    if(current?.fingerprint!==undefined&&current.fingerprint!==input.fingerprint)return false;
    if(current?.status==="complete")return true;
    if(current&&typeof current.leaseUntil==="number"&&current.leaseUntil>now&&current.leaseOwner!==input.owner)return false;
    const updatedAt=new Date(now).toISOString();
    const next={...(current||{}),pk,sk:"OP",caseId:input.caseId,profile:input.profile,fingerprint:input.fingerprint,
      ...input.patch,leaseOwner:input.owner,leaseUntil:input.release?0:now+120_000,updatedAt,
      expiresAt:Math.floor(now/1000)+90*86400};
    try{
      await this.db.send(new PutCommand({TableName:reviewTable(),Item:next,
        ...(current?{ConditionExpression:"updatedAt = :version AND fingerprint = :fingerprint AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now OR leaseOwner = :owner)",
          ExpressionAttributeValues:{":version":current.updatedAt,":fingerprint":input.fingerprint,":now":now,":owner":input.owner}}
          :{ConditionExpression:"attribute_not_exists(pk)"})}));
      return true;
    }catch(error){if(conditional(error)||(error as {name?:string}).name==="TransactionCanceledException")return false;throw error;}
  }
  constructor(private readonly db: Pick<typeof client, "send"> = client) {}
  async get<T>(pk: string): Promise<T | undefined> {
    return (await this.db.send(new GetCommand({ TableName: reviewTable(), Key: key(pk), ConsistentRead: true }))).Item as T | undefined;
  }
  async observeDecision(decision: ManualDecision): Promise<void> {
    const context = decision.context || {};
    await assertManualDecisionReplayAdmission(decision);
    const taskId = decision.taskId || (typeof context.providerTaskId === "string" ? context.providerTaskId : undefined);
    const eventId = decision.eventId || (typeof context.providerEventId === "string" ? context.providerEventId : undefined);
    const id = decision.decisionId, existing = await this.getCase(id);
    const conflictKey = typeof decision.context?.conflictKey === "string" ? decision.context.conflictKey : undefined;
    if (existing) {
      if (existing.status === "open" && conflictKey && existing.conflictKey === conflictKey) {
        await this.coalesceConflictIncidents(existing.profile, conflictKey, id);
      }
      return;
    }
    const item: ReviewCase = {
      id, profile: decision.profile, title: decision.type.replaceAll("_", " "), reason: decision.sourceAuditAction || decision.type,
      status: decision.status === "resolved"
        ? dismissalResolutions.has(String(decision.resolution || "").toLowerCase()) ? "dismissed" : "resolved"
        : "open",
      decision, taskId: decision.taskId || (typeof context.providerTaskId === "string" ? context.providerTaskId : undefined),
      eventId: decision.eventId || (typeof context.providerEventId === "string" ? context.providerEventId : undefined),
      conflictKey,
      reconciliationGeneration: typeof context.reconciliationGeneration === "string" ? context.reconciliationGeneration : undefined,
      progressCheckpoint: context.progressCheckpoint && typeof context.progressCheckpoint === "object"
        ? context.progressCheckpoint as ReviewCase["progressCheckpoint"] : undefined,
      createdAt: decision.createdAt, updatedAt: new Date().toISOString(),
    };
    let winner: ReviewCase | undefined = item;
    try { await this.db.send(new PutCommand({ TableName: reviewTable(), Item: { ...item, ...key(`REVIEW_CASE#${id}`),
      lookupPk: `PROFILE#${item.profile}`, lookupSk: `REVIEW#${item.status === "open" ? "OPEN" : "CLOSED"}#${item.createdAt}#${id}` }, ConditionExpression: "attribute_not_exists(pk)" })); }
    catch (e) {
      if (!conditional(e)) throw e;
      // A competing writer may have stored a terminal case or a different
      // identity under this deterministic decision id. Never coalesce from
      // our stale local copy after losing the conditional put.
      winner = await this.getCase(id);
      if (!winner) throw new Error("Review case disappeared after a conditional write conflict");
    }
    const winnerKey = typeof winner.conflictKey === "string" ? winner.conflictKey : undefined;
    if (winner.status === "open" && conflictKey && winnerKey === conflictKey) {
      await this.coalesceConflictIncidents(winner.profile, winnerKey, id);
    }
  }
  async observeConflictIncident(profile: Profile, fingerprint: string, incidentId: string, audit: Record<string, unknown>): Promise<void> {
    const detail = audit.detail && typeof audit.detail === "object" ? audit.detail as Record<string, unknown> : {};
    await admitNestedReviewIdentities(detail,profile);
    const auditKey = typeof audit.pk === "string" ? audit.pk : `${profile}:${fingerprint}:${incidentId}`;
    const id = `incident-${reviewHash(auditKey).slice(0, 32)}`;
    const action = typeof audit.action === "string" ? audit.action : "active conflict";
    const createdAt = typeof audit.createdAt === "string" ? audit.createdAt : new Date().toISOString();
    const item: ReviewCase = {
      id, profile, title: action.replaceAll("_", " "), reason: action,
      status: "open", taskId: typeof detail.taskId === "string" ? detail.taskId : undefined,
      eventId: typeof detail.eventId === "string" ? detail.eventId : undefined,
      createdAt, updatedAt: new Date().toISOString(),
      conflictKey: reviewHash(fingerprint),
    };
    try {
      await this.db.send(new PutCommand({ TableName: reviewTable(), Item: { ...item, ...key(`REVIEW_CASE#${id}`), sourceAuditKey: auditKey,
        lookupPk: `PROFILE#${profile}`, lookupSk: `REVIEW#OPEN#${createdAt}#${id}` }, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) { if (!conditional(error)) throw error; }
    const stored = await this.getCase(id);
    if (stored?.status === "open" && stored.sourceAuditKey === auditKey
      && (!stored.conflictKey || stored.conflictKey === item.conflictKey)) {
      if (!stored.conflictKey) {
        try {
          await this.db.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`REVIEW_CASE#${id}`),
            UpdateExpression: "SET conflictKey = :conflictKey",
            ConditionExpression: "#s = :open AND attribute_not_exists(conflictKey) AND sourceAuditKey = :auditKey",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":open": "open", ":auditKey": auditKey, ":conflictKey": item.conflictKey } }));
        } catch (error) { if (!conditional(error)) throw error; }
      }
      // This base-table row is the strongly consistent lookup path used during
      // coalescing; it avoids depending on immediate GSI propagation.
      await this.db.send(new PutCommand({ TableName: reviewTable(), Item: {
        pk: `REVIEW_CONFLICT#${profile}#${item.conflictKey}`, sk: `INCIDENT#${id}`,
        incidentId: id, profile, conflictKey: item.conflictKey,
      } }));
    }
  }
  private async coalesceConflictIncidents(profile: Profile, conflictKey: string, keeperId: string): Promise<void> {
    const incidents: ReviewCase[] = [];
    const page = await this.db.send(new QueryCommand({ TableName: reviewTable(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `REVIEW_CONFLICT#${profile}#${conflictKey}`, ":prefix": "INCIDENT#" },
      ConsistentRead: true }));
    for (const pointer of (page.Items || []) as Array<{ incidentId?: string }>) {
      if (!pointer.incidentId) continue;
      const candidate = await this.getCase(pointer.incidentId);
      if (candidate?.status === "open" && candidate.conflictKey === conflictKey) incidents.push(candidate);
    }
    // One-time migration path for old rows that predate the durable pointer.
    // If GSI propagation lags, a later observeDecision retries this lookup;
    // newly written incidents never depend on that GSI.
    if (!incidents.length) {
      const legacyPage = await this.db.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
        KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)",
        ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": "REVIEW#OPEN#" }, Limit: 50 }));
      for (const candidate of (legacyPage.Items || []) as ReviewCase[]) {
        if (!candidate.id.startsWith("incident-") || candidate.conflictKey || !candidate.sourceAuditKey) continue;
        const audit = await this.get<Record<string, unknown>>(candidate.sourceAuditKey);
        const detail = audit?.detail && typeof audit.detail === "object" ? audit.detail as Record<string, unknown> : undefined;
        const action = typeof audit?.action === "string" ? audit.action : undefined;
        const identity = action && detail ? retainedConflictIdentity(action, detail) : undefined;
        if (identity && reviewHash(identity) === conflictKey) {
          await admitNestedReviewIdentities(detail!,profile);
          incidents.push(candidate);
        }
      }
    }
    for (const candidate of incidents) {
      await admitNestedReviewIdentities(candidate,profile);
      try {
        const condition = candidate.sourceAuditKey
          ? "#s = :open AND (conflictKey = :conflictKey OR attribute_not_exists(conflictKey)) AND sourceAuditKey = :sourceAuditKey"
          : "#s = :open AND conflictKey = :conflictKey";
        const values: Record<string, unknown> = { ":closed": "dismissed", ":open": "open", ":conflictKey": conflictKey,
          ":result": `Coalesced into review case ${keeperId}`, ":keeper": keeperId, ":now": new Date().toISOString(),
          ":lookup": `REVIEW#CLOSED#${candidate.createdAt}#${candidate.id}` };
        if (candidate.sourceAuditKey) values[":sourceAuditKey"] = candidate.sourceAuditKey;
        await this.db.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`REVIEW_CASE#${candidate.id}`),
          UpdateExpression: "SET #s = :closed, #r = :result, conflictKey = :conflictKey, coalescedInto = :keeper, updatedAt = :now, lookupSk = :lookup",
          ConditionExpression: condition,
          ExpressionAttributeNames: { "#s": "status", "#r": "result" },
          ExpressionAttributeValues: values }));
        if (candidate.sourceAuditKey) {
          await this.db.send(new PutCommand({ TableName: reviewTable(), Item: {
            pk: `REVIEW_CONFLICT#${profile}#${conflictKey}`, sk: `INCIDENT#${candidate.id}`,
            incidentId: candidate.id, profile, conflictKey,
          } }));
        }
      } catch (error) { if (!conditional(error)) throw error; }
    }
  }
  /**
   * Active deletion conflict guards are bounded pointers, not a permanent
   * per-provider tombstone. They are created only after a deletion notification
   * matched an existing actionable case, with a bounded expiry. The
   * pointed-to case must still be open/repairing and mention this exact ID.
   */
  async indexDeletedConflictCase(item: ReviewCase): Promise<void> {
    if (item.status !== "open" || !item.id || !item.profile) return;
    const evidence = reviewCaseEvidenceIds(item);
    if (!evidence.taskIds.length || !evidence.eventIds.length
      || evidence.taskIds.length + evidence.eventIds.length > 20) return;
    const expiry = Math.floor(Date.now() / 1000) + 90 * 86400;
    const refs = [
      ...evidence.taskIds.map(id => ({ side: "todoist", id })),
      ...evidence.eventIds.map(id => ({ side: "calendar", id })),
    ];
    for (const ref of refs) await admitReviewIdentity(item.profile,
      ref.side === "todoist" ? ref.id : undefined, ref.side === "calendar" ? ref.id : undefined);
    for (const ref of refs) {
      await this.db.send(new PutCommand({ TableName: reviewTable(),
        Item: { pk: `DELETION_REVIEW#${item.profile}#${ref.side}#${ref.id}`,
          sk: `CASE#${item.id}`, caseId: item.id, profile: item.profile,
          expiresAt: expiry },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
      })).catch(error => { if (!conditional(error)) throw error; });
    }
  }

  /**
   * Exact-ID lookup for deferred deletion rechecks. A dismissed case may
   * still own stale review evidence even though its active guard MUST stop
   * blocking normal provider writes immediately on dismissal.
   */
  async listDeletedConflictCaseIds(
    profile:Profile,side:"todoist"|"calendar",id:string,
  ):Promise<string[]> {
    if(!id)return [];
    const pk=`DELETION_REVIEW#${profile}#${side}#${id}`;
    const page=await this.db.send(new QueryCommand({TableName:reviewTable(),
      KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues:{":pk":pk,":prefix":"CASE#"},
      ConsistentRead:true,Limit:40,
    }));
    if(page.LastEvaluatedKey)
      throw new Error("Exact deletion review pointer inventory exceeded the safe limit");
    return [...new Set((page.Items||[]).filter(row=>
      row.pk===pk&&typeof row.caseId==="string"&&row.caseId.length>0
      &&row.sk===`CASE#${row.caseId}`&&row.profile===profile
      &&Number(row.expiresAt||0)>Date.now()/1000,
    ).map(row=>String(row.caseId)))];
  }

  /**
   * Versioned pending-refresh markers are already consumed by the worker's
   * reconciliation follow-up protocol. A deletion arriving after a generation
   * starts must have its own next pass, rather than coalescing silently.
   */
  async markDeletedReviewPendingRefresh(
    refs: Array<{ profile: Profile; side: "todoist" | "calendar"; id: string }>,
  ): Promise<Array<{ profile: Profile; side: "todoist" | "calendar"; id: string; pendingRefreshAt: string }>> {
    const marked: Array<{ profile: Profile; side: "todoist" | "calendar"; id: string; pendingRefreshAt: string }> = [];
    for (const ref of [...new Map(refs.map(item => [entityKey(item), item])).values()]) {
      await admitReviewIdentity(ref.profile,
        ref.side === "todoist" ? ref.id : undefined,
        ref.side === "calendar" ? ref.id : undefined);
      const pendingRefreshAt = randomUUID();
      await this.db.send(new UpdateCommand({ TableName: reviewTable(),
        Key: key(`SYNC_CONTROL#${entityKey(ref)}`),
        UpdateExpression: "SET pendingRefresh = :true, pendingRefreshAt = :at",
        ExpressionAttributeValues: { ":true": true, ":at": pendingRefreshAt },
      }));
      marked.push({ ...ref, pendingRefreshAt });
    }
    return marked;
  }

  /** True means an open case still claims this exact provider identity and
   * sync must not create a new counterpart until it is re-evaluated.
   */
  async hasActiveDeletionGuard(profile: Profile, side: "todoist" | "calendar", id: string): Promise<boolean> {
    if (!id) return false;
    const page = await this.db.send(new QueryCommand({ TableName: reviewTable(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DELETION_REVIEW#${profile}#${side}#${id}`,
        ":prefix": "CASE#" }, ConsistentRead: true, Limit: 40 }));
    if (page.LastEvaluatedKey) return true; // fail closed on suspiciously crowded identity
    for (const row of page.Items || []) {
      if (!row.caseId || Number(row.expiresAt || 0) <= Date.now() / 1000) continue;
      const item = await this.getCase(String(row.caseId));
      if (!item || item.profile !== profile || !["open", "repairing"].includes(item.status)) continue;
      const ids = reviewCaseEvidenceIds(item);
      if ((side === "todoist" ? ids.taskIds : ids.eventIds).includes(id)) return true;
    }
    return false;
  }

  getCase(id: string): Promise<ReviewCase | undefined> { return this.get(`REVIEW_CASE#${id}`); }
  async listCases(profile: Profile, cursor?: Record<string, unknown>, history = false, limit = 50) {
    const result = await this.db.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)",
      ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": history ? "REVIEW#" : "REVIEW#OPEN#" }, Limit: Math.min(50, Math.max(1, limit)),
      ExclusiveStartKey: cursor }));
    return { items: (result.Items || []) as ReviewCase[], cursor: result.LastEvaluatedKey };
  }
  /** Round-robin pagination across reconciliation generations; a hot first
   * page cannot starve newer deleted cases indefinitely. */
  async deletionSweepCursor(profile: Profile, history: boolean): Promise<Record<string, unknown> | undefined> {
    const marker = await this.get<{ cursor?: Record<string, unknown> }>(`DELETION_SWEEP#${profile}#${history ? "history" : "open"}`);
    return marker?.cursor;
  }
  async saveDeletionSweepCursor(profile: Profile, history: boolean, cursor?: Record<string, unknown>): Promise<void> {
    const pk = `DELETION_SWEEP#${profile}#${history ? "history" : "open"}`;
    // A null cursor restarts from the first page after a complete sweep.
    await this.db.send(new PutCommand({ TableName: reviewTable(),
      Item: { ...key(pk), ...(cursor ? { cursor } : {}), expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
    }));
  }
  async countActionableCases(profile: Profile): Promise<number> {
    let count = 0;
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.listCases(profile, cursor, false);
      count += page.items.filter(item => item.status === "open" || item.status === "repairing").length;
      cursor = page.cursor;
    } while (cursor);
    return count;
  }
  /** Dismissal acknowledges an alert; it never claims provider repair verification. */
  async dismissCase(id: string, result: string): Promise<ReviewCase> {
    const conflict = () => Object.assign(new Error("Alert or repair changed; refresh the case before dismissing"), { status:409 });
    const current = await this.getCase(id);
    if (!current) throw Object.assign(new Error("Conflict no longer exists"), {status:404});
    if (current.status === "dismissed") return current;
    await admitNestedReviewIdentities(current,current.profile);
    if (current.status !== "open") throw conflict();
    const operation = current.operationId ? await this.getOperation(current.operationId) : undefined;
    if (current.operationId && (!operation || operation.status !== "failed" || operationHasWriteEvidence(operation))) throw conflict();
    const manual = await this.get<ManualDecision>(`MANUAL#${id}`);
    const now = new Date().toISOString();
    const values: Record<string, unknown> = {":open":"open", ":dismissed":"dismissed", ":result":result, ":now":now,
      ":lookup":`REVIEW#CLOSED#${current.createdAt}#${id}`, ":version":current.updatedAt};
    const operationCondition = current.operationId ? "operationId = :op" : "attribute_not_exists(operationId) OR operationId = :empty";
    if (current.operationId) values[":op"] = current.operationId;
    else values[":empty"] = "";
    const items: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [{Update:{
      TableName:reviewTable(), Key:key(`REVIEW_CASE#${id}`),
      UpdateExpression:"SET #s = :dismissed, #r = :result, updatedAt = :now, lookupSk = :lookup",
      ConditionExpression:`#s = :open AND updatedAt = :version AND (${operationCondition})`,
      ExpressionAttributeNames:{"#s":"status", "#r":"result"}, ExpressionAttributeValues:values,
    }}];
    if (manual?.status === "pending" && manual.profile === current.profile
      && manual.decisionId === id && typeof manual.createdAt === "string") {
      items.push({Update:{
        TableName:reviewTable(), Key:key(`MANUAL#${id}`),
        UpdateExpression:"SET #s = :resolved, resolution = :result, resolvedAt = :now REMOVE lookupPk, lookupSk",
        ConditionExpression:"#s = :pending AND profile = :profile AND decisionId = :id AND createdAt = :createdAt",
        ExpressionAttributeNames:{"#s":"status"}, ExpressionAttributeValues:{
          ":pending":"pending", ":resolved":"resolved", ":profile":current.profile, ":id":id,
          ":createdAt":manual.createdAt, ":result":result, ":now":now,
        },
      }});
    }
    // Dismissing an alert never establishes provider deletion, but a future
    // deletion must be able to recheck this exact case. The expiring pointer
    // is not an active write barrier and is removed by verified cleanup.
    const deletionRecheck=current.decision?.type==="todoist_unmapped_conflict"
      || current.decision?.type?.includes("recurrence_task_deleted")===true
      || current.reason==="calendar_snapshot_recurring_identity_conflict";
    if(deletionRecheck){
      const ids=reviewCaseEvidenceIds(current);
      if(ids.taskIds.length&&ids.eventIds.length
        &&ids.taskIds.length+ids.eventIds.length<=20){
        const expiry=Math.floor(Date.now()/1000)+90*86400;
        for(const [side,providerIds] of [
          ["todoist",ids.taskIds],["calendar",ids.eventIds],
        ] as const){
          for(const providerId of providerIds)items.push({Put:{
            TableName:reviewTable(),Item:{
              pk:`DELETION_REVIEW#${current.profile}#${side}#${providerId}`,
              sk:`CASE#${id}`,profile:current.profile,caseId:id,expiresAt:expiry,
            },
          }});
        }
      }
    }
    if (operation) items.push({ConditionCheck:{TableName:reviewTable(),Key:key(`REPAIR#${operation.id}`),
      ConditionExpression:"#s = :failed AND updatedAt = :version AND attribute_not_exists(writeStarted)",
      ExpressionAttributeNames:{"#s":"status"}, ExpressionAttributeValues:{":failed":"failed", ":version":operation.updatedAt}}});
    try { await this.db.send(new TransactWriteCommand({TransactItems:items})); }
    catch (error) {
      const latest = await this.getCase(id);
      if (latest?.status === "dismissed") return latest;
      if (conditional(error) || (error as {name?:string}).name === "TransactionCanceledException") throw conflict();
      throw error;
    }
    return {...current,status:"dismissed",result,updatedAt:now};
  }
  /**
   * Close an obsolete conflict only after the caller has freshly verified that
   * every provider identity is deleted and no mapping, recurrence or repair
   * still owns it. Keep a small terminal case/decision receipt so replayed
   * audits and deterministic decision seeding cannot reopen the old case.
   *
   * Remove strictly attributable audit and incident pointers within the same
   * transaction, never records belonging to a live counterpart.
   */
  async resolveVerifiedDeletedCase(caseId: string, expected: VerifiedDeletionEvidence): Promise<boolean> {
    const items = await this.planVerifiedDeletion(caseId, expected, Date.now());
    return items ? this.commitVerifiedDeletion(items) : false;
  }

  /** Plan terminal retirement for the selected persisted case. The caller
   * must verify provider state and project tombstones before authorizing the
   * write. Rebuild the plan to detect drift, then CAS the original evidence. */
  async prepareHistoricalCaseRetirement(selected: ReviewCase, expected: VerifiedDeletionEvidence): Promise<{
    resourceKeys: string[];
    commit: (authorize: () => Promise<HistoricalRetirementAuthorization>) => Promise<boolean>;
  } | undefined> {
    const preparedAt = Date.now();
    const planFingerprint = (plan: VerifiedDeletionTransaction) => reviewHash(plan.map(reviewHash).sort());
    const items = await this.planVerifiedDeletion(selected.id, expected, preparedAt, selected);
    if (!items) return undefined;
    return {
      resourceKeys: items.flatMap(item => [item.Update?.Key, item.Delete?.Key]
        .filter(Boolean).map(key => `${key!.pk}|${key!.sk}`)),
      commit: async authorize => {
        const fresh = await this.planVerifiedDeletion(selected.id, expected, preparedAt, selected);
        if (!fresh) return false;
        if (planFingerprint(fresh) !== planFingerprint(items)) {
          this.lastVerifiedDeletionBlocker = "terminal_retirement_inventory_changed";
          return false;
        }
        const { checkpoint, scope } = await authorize();
        const guards: VerifiedDeletionTransaction = [{
          ConditionCheck: {
            TableName: reviewTable(), Key: { pk: `HISTORICAL_CLEANUP#${selected.id}`, sk: "OP" },
            ConditionExpression: "fingerprint=:fingerprint AND leaseOwner=:owner AND leaseUntil > :now",
            ExpressionAttributeValues: { ":fingerprint": checkpoint.fingerprint, ":owner": checkpoint.owner, ":now": Date.now() },
          },
        }];
        if (scope) {
          guards.push(
            { ConditionCheck: {
              TableName: reviewTable(), Key: { pk: `ERASURE#${expected.profile}`, sk: "SCOPED_ADMISSION" },
              ConditionExpression: "#version=:version AND contains(owners,:owner) AND leaseUntilByOwner.#owner > :now",
              ExpressionAttributeNames: { "#version": "version", "#owner": scope.owner },
              ExpressionAttributeValues: { ":version": scope.version, ":owner": scope.owner, ":now": Date.now() },
            } },
            { ConditionCheck: {
              TableName: reviewTable(), Key: { pk: `ERASURE#${expected.profile}`, sk: "FENCE" },
              ConditionExpression: "operationId=:operationId AND #state=:active",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: { ":operationId": scope.operationId, ":active": "active" },
            } },
            { ConditionCheck: {
              TableName: reviewTable(), Key: { pk: `ERASURE#${expected.profile}`, sk: "EPOCH" },
              ConditionExpression: "epoch=:epoch",
              ExpressionAttributeValues: { ":epoch": scope.epoch },
            } },
          );
        } else if (process.env.ERASURE_PROTOCOL_VERSION === "1") {
          guards.push({ ConditionCheck: {
            TableName: reviewTable(), Key: { pk: `ERASURE#${expected.profile}`, sk: "FENCE" },
            ConditionExpression: "attribute_not_exists(pk)",
          } });
        }
        return this.commitVerifiedDeletion([...items, ...guards]);
      },
    };
  }

  private async planVerifiedDeletion(
    caseId: string, expected: VerifiedDeletionEvidence, preparedAt: number, selected?: ReviewCase,
  ): Promise<VerifiedDeletionTransaction | undefined> {
    this.lastVerifiedDeletionBlocker = undefined;
    const blocked = (reason: string): undefined => { this.lastVerifiedDeletionBlocker = reason; return undefined; };
    const cleanupProfiles: Profile[] = ["home", "antonio", "work"];
    const current = await this.getCase(caseId);
    if (!current || current.profile !== expected.profile || !["open", "dismissed"].includes(current.status)
      || current.operationId || current.result?.startsWith("resolved_deleted")) return blocked("case_status_revision_or_operation_changed");
    if (selected && (current.updatedAt !== selected.updatedAt || current.status !== selected.status
      || reviewHash(current.decision ?? null) !== reviewHash(selected.decision ?? null)
      || current.taskId !== selected.taskId || current.eventId !== selected.eventId))
      return blocked("case_status_revision_or_operation_changed");
    if (!selected) await admitNestedReviewIdentities(current,current.profile);
    const withinVerifiedIdentities = (ref: EntityRef) => ref.profile === expected.profile
      && (ref.side === "todoist" ? expected.taskIds : expected.eventIds).includes(ref.id);
    const identityOptions = { seriesKeys: [...expected.taskIds, ...(expected.masterSeriesId ? [expected.masterSeriesId] : [])] };
    const attributableIdentities = (value: unknown) => nestedReviewIdentities(value, expected.profile, identityOptions)
      .every(withinVerifiedIdentities);
    if (selected) {
      const refs = nestedReviewIdentities(current, current.profile, identityOptions);
      if (!refs.every(withinVerifiedIdentities)) return blocked("nested_case_identity_unverified");
      for (const ref of refs) await assertReplayAdmissionIfEnabled({ profile: ref.profile,
        ...(ref.side === "todoist" ? { taskId: ref.id } : { eventIds: [ref.id] }) });
    }
    const { taskIds, eventIds } = reviewCaseEvidenceIds(current);
    if (!taskIds.length || !eventIds.length
      || taskIds.some(id => !expected.taskIds.includes(id))
      || eventIds.some(id => !expected.eventIds.includes(id))) return blocked("case_provider_identity_changed_or_incomplete");

    const manual = await this.get<ManualDecision>(`MANUAL#${caseId}`);
    if (manual && (!["pending", "resolved", "stale", "cancelled", "expired"].includes(manual.status)
      || manual.profile !== expected.profile || manual.decisionId !== caseId))
      return blocked("manual_decision_status_or_identity_changed");
    if (selected && manual && !attributableIdentities(manual)) return blocked("nested_manual_identity_unverified");
    const source = current.sourceAuditKey && current.sourceAuditKey.startsWith(`AUDIT#${expected.profile}#`)
      ? await this.get<Record<string, unknown>>(current.sourceAuditKey) : undefined;
    const detail = source?.detail && typeof source.detail === "object"
      ? source.detail as Record<string, unknown> : undefined;
    const attribution = detail ? retainedAuditProviderIds(detail) : { taskIds: [], eventIds: [] };
    const attributable = Boolean(source && detail && attribution.taskIds.length + attribution.eventIds.length > 0
      && attribution.taskIds.every(id => expected.taskIds.includes(id))
      && attribution.eventIds.every(id => expected.eventIds.includes(id))
      && (!selected || attributableIdentities(detail) && typeof source.action === "string"
        && !/(?:operational|dlq)/.test(source.action)));
    const pointerKey = current.conflictKey && current.id.startsWith("incident-")
      ? { pk: `REVIEW_CONFLICT#${expected.profile}#${current.conflictKey}`, sk: `INCIDENT#${caseId}` }
      : undefined;
    const pointer = pointerKey ? (await this.db.send(new GetCommand({
      TableName: reviewTable(), Key: pointerKey, ConsistentRead: true,
    }))).Item as { incidentId?: string } | undefined : undefined;
    if (pointerKey && pointer && pointer.incidentId !== caseId)
      return blocked("conflict_pointer_claimed_by_another_case");
    // This method is the final transaction authority, not the classifier.
    // A caller MUST provide the complete exact recurring identity and its
    // Calendar iCalUID recurrence key before closure of a recurring decision.
    const recurring = current.decision?.type?.includes("recurrence_task_deleted") === true;
    const recordedMaster = current.decision?.masterEventId || current.decision?.mappingSnapshot?.masterEventId;
    const recordedActive = current.decision?.activeInstanceId || current.decision?.mappingSnapshot?.activeInstanceId;
    // Legacy todoist-owned mappings can have no masterEventId even though
    // the cancelled active occurrence directly names its cancelled master.
    // Never accept the caller's boolean or an inferred ID as this proof:
    // independently verify both supplied direct provider readback objects.
    const proof=expected.legacyMasterProof;
    const verifiedLegacyMaster=Boolean(!recordedMaster && proof && expected.masterId
      && expected.activeInstanceId && expected.masterSeriesId
      && proof.master.id===expected.masterId
      && proof.occurrence.id===expected.activeInstanceId
      && verifyCancelledSeries(expected.masterId,expected.activeInstanceId,
        [expected.masterId,expected.activeInstanceId],
        new Map([[expected.masterId,proof.master],[expected.activeInstanceId,proof.occurrence]])).masterSeriesId
          ===expected.masterSeriesId);
    const seriesKeys = [...new Set(expected.seriesKeys || [...expected.taskIds, ...expected.eventIds])];
    if (!seriesKeys.length || seriesKeys.length > 20
      || [...expected.taskIds, ...expected.eventIds].some(id => !seriesKeys.includes(id))) return blocked("exact_identity_inventory_incomplete_or_over_limit");
    if (recurring && (!expected.masterId || !expected.activeInstanceId || !expected.masterSeriesId
      || (recordedMaster ? recordedMaster !== expected.masterId : !verifiedLegacyMaster)
      || recordedActive !== expected.activeInstanceId
      || expected.masterId === expected.activeInstanceId
      || !expected.eventIds.includes(expected.masterId)
      || !expected.eventIds.includes(expected.activeInstanceId)
      || !seriesKeys.includes(expected.masterSeriesId)
      || !seriesKeys.includes(expected.masterId)
      || !seriesKeys.includes(expected.activeInstanceId)
      || current.decision?.seriesId && !seriesKeys.includes(current.decision.seriesId)
      || current.decision?.mappingSnapshot?.seriesId && !seriesKeys.includes(current.decision.mappingSnapshot.seriesId)))
      return blocked("recurrence_ownership_proof_incomplete_or_changed");
    const staleLinks = expected.staleLinks || [];
    const seenLinks = new Set<string>();
    for (const link of staleLinks) {
      const identity = `${link.profile}/${link.seriesId}`;
      if (seenLinks.has(identity) || link.profile !== expected.profile || link.owner !== "todoist"
        || link.seriesId !== link.taskId || !expected.taskIds.includes(link.taskId)
        || !expected.eventIds.includes(link.eventId)
        || (!link.masterEventId && !(recurring && verifiedLegacyMaster
          && link.eventId===expected.activeInstanceId))
        || (link.masterEventId && !expected.eventIds.includes(link.masterEventId))
        || !link.activeInstanceId || !expected.eventIds.includes(link.activeInstanceId)
        || link.activeInstanceId === link.masterEventId
        || recurring && (link.masterEventId !== expected.masterId
          && !(verifiedLegacyMaster && !link.masterEventId
            && link.eventId===expected.activeInstanceId)
          || link.activeInstanceId !== expected.activeInstanceId)
        || !seriesKeys.includes(link.seriesId) || !link.updatedAt) return blocked("recurrence_link_ownership_or_revision_changed");
      seenLinks.add(identity);
    }
    const staleMappings=expected.staleMappings||[];
    const mappingKeys=new Set<string>(),mappingTasks=new Set<string>();
    for(const mapping of staleMappings){
      const identity=`${mapping.profile}/${mapping.taskId}/${mapping.eventId}`;
      if(mappingKeys.has(identity)||mappingTasks.has(mapping.taskId)||mapping.profile!==expected.profile||!expected.taskIds.includes(mapping.taskId)
        ||!expected.eventIds.includes(mapping.eventId)||!mapping.updatedAt)
        return blocked("stale_mapping_identity_or_revision_changed");
      mappingKeys.add(identity);mappingTasks.add(mapping.taskId);
    }
    const staleMappingRows=expected.staleMappingRows||[],mappingDeleteKeys=new Set<string>();
    for(const row of staleMappingRows){
      const exactKey=row.pk===`TASK#${expected.profile}#${row.taskId}`&&row.sk==="MAP"
        ||row.pk===`EVENT#${expected.profile}#${row.eventId}`&&row.sk==="MAP"
        ||row.pk===`TASKOWNER#${row.taskId}`&&row.sk==="MAP";
      const keyId=`${row.pk}|${row.sk}`;
      if(!exactKey||mappingDeleteKeys.has(keyId)||row.profile!==expected.profile||!expected.taskIds.includes(row.taskId)
        ||!expected.eventIds.includes(row.eventId)||!row.updatedAt)return blocked("stale_mapping_identity_or_revision_changed");
      mappingDeleteKeys.add(keyId);
    }
    const now = new Date(preparedAt).toISOString();
    const resolution = "resolved_deleted: both provider objects verified absent; stale conflict retired";
    const items: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
      { Update: { TableName: reviewTable(), Key: key(`REVIEW_CASE#${caseId}`),
        UpdateExpression: "SET #status = :resolved, #result = :result, #title = :title, #reason = :reason, updatedAt = :now, expiresAt = :expiry REMOVE decision, taskId, eventId, sourceAuditKey, lookupPk, lookupSk, conflictKey, reconciliationGeneration, progressCheckpoint, coalescedInto",
        ConditionExpression: "#status = :old AND updatedAt = :version AND attribute_not_exists(operationId)",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#title": "title", "#reason": "reason" },
        ExpressionAttributeValues: { ":resolved": "resolved", ":result": resolution, ":title": "Verified deletion", ":reason": "verified_deletion",
          ":now": now, ":old": current.status, ":version": current.updatedAt,
          ":expiry": Math.floor(preparedAt / 1000) + 30 * 86400 },
      } },
    ];
    if (manual) items.push({ Update: { TableName: reviewTable(), Key: key(`MANUAL#${caseId}`),
      UpdateExpression: "SET #status = :resolved, resolution = :result, resolvedAt = :now REMOVE lookupPk, lookupSk, #context, taskId, eventId, masterEventId, activeInstanceId, seriesId, mappingSnapshot",
      ConditionExpression: "#status = :old AND profile = :profile AND decisionId = :id AND createdAt = :createdAt",
      ExpressionAttributeNames: { "#status": "status", "#context": "context" },
      ExpressionAttributeValues: { ":old": manual.status, ":resolved": "resolved", ":profile": expected.profile,
        ":id": caseId, ":createdAt": manual.createdAt, ":result": resolution, ":now": now },
    } });
    if (selected && manual) {
      // Manual context can change while the decision remains pending with the
      // same createdAt. Fence every identity-bearing field that will be removed.
      const update = items[1].Update!;
      for (const field of ["context", "taskId", "eventId", "masterEventId", "activeInstanceId", "seriesId", "mappingSnapshot"] as const) {
        const name = `#manual_${field}`, value = `:manual_${field}`;
        update.ExpressionAttributeNames![name] = field;
        const previous = manual[field];
        if (previous === undefined) update.ConditionExpression += ` AND attribute_not_exists(${name})`;
        else {
          update.ConditionExpression += ` AND ${name} = ${value}`;
          update.ExpressionAttributeValues![value] = previous;
        }
      }
    } else if (selected) {
      items.push({ ConditionCheck: { TableName: reviewTable(), Key: key(`MANUAL#${caseId}`),
        ConditionExpression: "attribute_not_exists(pk)" } });
    }
    // Retire only a mapping whose exact task/event pair is in this case and
    // whose version is unchanged. All three lookup rows are deleted in the
    // same transaction as terminal case closure.
    for(const row of staleMappingRows){
      const values={":profile":row.profile,":task":row.taskId,":event":row.eventId,":updated":row.updatedAt};
      items.push({Delete:{TableName:reviewTable(),Key:{pk:row.pk,sk:row.sk},
        ConditionExpression:"#profile = :profile AND #task = :task AND #event = :event AND updatedAt = :updated",
        ExpressionAttributeNames:{"#profile":"profile","#task":"taskId","#event":"eventId"},ExpressionAttributeValues:values}});
    }
    if(!expected.staleMappingRows)for(const mapping of staleMappings){
      const values={":profile":mapping.profile,":task":mapping.taskId,":event":mapping.eventId,":updated":mapping.updatedAt};
      const names={"#profile":"profile","#task":"taskId","#event":"eventId"};
      const condition="#profile = :profile AND #task = :task AND #event = :event AND updatedAt = :updated";
      items.push({Delete:{TableName:reviewTable(),Key:{pk:`TASK#${mapping.profile}#${mapping.taskId}`,sk:"MAP"},
        ConditionExpression:condition,ExpressionAttributeNames:names,ExpressionAttributeValues:values}});
      items.push({Delete:{TableName:reviewTable(),Key:{pk:`EVENT#${mapping.profile}#${mapping.eventId}`,sk:"MAP"},
        ConditionExpression:condition,ExpressionAttributeNames:names,ExpressionAttributeValues:values}});
      items.push({Delete:{TableName:reviewTable(),Key:{pk:`TASKOWNER#${mapping.taskId}`,sk:"MAP"},
        ConditionExpression:condition,ExpressionAttributeNames:names,ExpressionAttributeValues:values}});
    }
    // Retire the stale active link inside the same transaction as the case and
    // pending manual decision. All identity/ownership/version fields are CAS
    // fenced; a revived or re-owned series cancels the entire operation.
    for (const link of staleLinks) {
      const values: Record<string, unknown> = {
        ":profile": link.profile, ":owner": "todoist", ":series": link.seriesId,
        ":task": link.taskId, ":event": link.eventId, ":updated": link.updatedAt,
      };
      const conditions = [
        "#profile = :profile", "#owner = :owner", "seriesId = :series",
        "taskId = :task", "eventId = :event", "updatedAt = :updated",
      ];
      for (const field of ["masterEventId", "activeInstanceId"] as const) {
        if (link[field]) { conditions.push(`${field} = :${field}`); values[`:${field}`] = link[field]; }
        else conditions.push(`attribute_not_exists(${field})`);
      }
      items.push({ Delete: { TableName: reviewTable(),
        Key: key(`RECURRENCE#${link.profile}#${link.seriesId}`),
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: { "#profile": "profile", "#owner": "owner" },
        ExpressionAttributeValues: values,
      } });
    }
    // Remove exact case-scoped deletion-review guards. Their unique case sort
    // key means this cannot remove guards owned by other unresolved cases.
    const refs = [
      ...expected.taskIds.map(id => ({ side: "todoist", id })),
      ...expected.eventIds.map(id => ({ side: "calendar", id })),
    ];
    for(const ref of refs)for(const candidateProfile of cleanupProfiles){
      const pk=`DELETION_REVIEW#${candidateProfile}#${ref.side}#${ref.id}`;
      const page=await this.db.send(new QueryCommand({TableName:reviewTable(),ConsistentRead:true,Limit:50,
        KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues:{":pk":pk,":prefix":"CASE#"}}));
      if(page.LastEvaluatedKey)return blocked("deletion_review_guard_inventory_over_limit");
      for(const row of page.Items||[]){
        if(typeof row.sk!=="string"||!row.sk.startsWith("CASE#")||typeof row.caseId!=="string")
          return blocked("deletion_review_guard_identity_inconsistent");
        if(candidateProfile!==expected.profile||row.caseId!==caseId)
          return blocked("another_review_case_owns_verified_identity");
      }
    }
    for (const ref of refs) items.push({ Delete: { TableName: reviewTable(),
      Key: { pk: `DELETION_REVIEW#${expected.profile}#${ref.side}#${ref.id}`,
        sk: `CASE#${caseId}` },
    } });
    if (pointer?.incidentId === caseId && pointerKey) items.push({ Delete: {
      TableName: reviewTable(), Key: pointerKey,
      ConditionExpression: "incidentId = :id", ExpressionAttributeValues: { ":id": caseId },
    } });
    if (attributable && source && current.sourceAuditKey) {
      items.push({ Delete: {
        TableName: reviewTable(), Key: key(current.sourceAuditKey),
        ConditionExpression: "createdAt = :createdAt AND #action = :action",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: { ":createdAt": source.createdAt, ":action": source.action },
      } });
      const parsed = /^AUDIT#[^#]+#CONFLICT#([a-f0-9]{64})#(.+)$/.exec(current.sourceAuditKey);
      const entity = detail && retainedConflictEntity(detail);
      if (parsed && entity) {
        const entityHash = createHash("sha256").update(entity).digest("hex");
        const conflictStateKey = key(`CONFLICT_STATE#${expected.profile}#${entityHash}`);
        const lifecycle = (await this.db.send(new GetCommand({
          TableName: reviewTable(), Key: conflictStateKey, ConsistentRead: true,
        }))).Item as { fingerprint?: string; incidentId?: string } | undefined;
        if (lifecycle?.fingerprint === parsed[1] && lifecycle.incidentId === parsed[2]) {
          items.push({ Delete: {
            TableName: reviewTable(), Key: conflictStateKey,
            ConditionExpression: "fingerprint = :fingerprint AND incidentId = :incident",
            ExpressionAttributeValues: { ":fingerprint": parsed[1], ":incident": parsed[2] },
          } });
        }
      }
    }
    // Older conflicts may have generated several review incidents before a
    // deterministic manual decision became the keeper. Retiring only the
    // keeper leaves closed incident pointers and audit rows in the review
    // history, and retained state can seed those stale incidents again.
    // Clean ONLY closed children that explicitly point to this exact keeper,
    // with their own fully attributable audit. Never follow a conflict
    // fingerprint into another active or unrelated case.
    if (current.conflictKey) {
      const conflictPk=`REVIEW_CONFLICT#${expected.profile}#${current.conflictKey}`;
      const page=await this.db.send(new QueryCommand({
        TableName:reviewTable(),ConsistentRead:true,Limit:20,
        KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues:{":pk":conflictPk,":prefix":"INCIDENT#"},
      }));
      if(page.LastEvaluatedKey)return blocked("audit_pointer_inventory_exceeds_safe_bound"); // never perform a partial cleanup
      const visited=new Set<string>();
      const auditDeletes=new Set(items.filter(op=>op.Delete).map(op=>op.Delete?.Key?.pk));
      for(const entry of page.Items || []){
        const pointer=entry as {pk?:string;sk?:string;incidentId?:string;profile?:string;conflictKey?:string};
        const id=pointer.incidentId;
        if(!id||!id.startsWith("incident-")||visited.has(id)
          ||pointer.pk!==conflictPk||pointer.sk!==`INCIDENT#${id}`
          ||pointer.profile!==expected.profile||pointer.conflictKey!==current.conflictKey)
          return blocked("coalesced_case_pointer_inconsistent"); // an inconsistent pointer must not be orphaned
        visited.add(id);
        if(id===caseId)continue; // the original case pointer is handled above
        const child=await this.getCase(id);
        if(!child||child.profile!==expected.profile||child.status!=="dismissed"
          ||child.coalescedInto!==caseId||child.operationId
          ||child.conflictKey!==current.conflictKey
          ||!child.sourceAuditKey?.startsWith(`AUDIT#${expected.profile}#`)
          ||await this.get<ManualDecision>(`MANUAL#${id}`))continue;
        const childIds=reviewCaseEvidenceIds(child);
        if(selected && !attributableIdentities(child))continue;
        if(childIds.taskIds.length+childIds.eventIds.length===0
          ||childIds.taskIds.some(id=>!expected.taskIds.includes(id))
          ||childIds.eventIds.some(id=>!expected.eventIds.includes(id)))continue;
        const audit=await this.get<Record<string,unknown>>(child.sourceAuditKey);
        const auditDetail=audit?.detail&&typeof audit.detail==="object"
          ?audit.detail as Record<string,unknown>:undefined;
        const auditIds=auditDetail?retainedAuditProviderIds(auditDetail):undefined;
        if(!audit||typeof audit.action!=="string"||typeof audit.createdAt!=="string"
          ||/(?:operational|dlq)/.test(audit.action)||!auditIds
          ||selected && !attributableIdentities(auditDetail)
          ||auditIds.taskIds.length+auditIds.eventIds.length===0
          ||auditIds.taskIds.some(id=>!expected.taskIds.includes(id))
          ||auditIds.eventIds.some(id=>!expected.eventIds.includes(id)))continue;
        // Conditional child receipt, pointer and audit deletion are part of the
        // SAME DynamoDB transaction as the keeper and stale recurrence link.
        // A concurrent reopen, ownership change or case coalescing cancels all.
        items.push({Update:{TableName:reviewTable(),Key:key(`REVIEW_CASE#${id}`),
          UpdateExpression:"SET #status = :resolved, #result = :result, #title = :title, #reason = :reason, updatedAt = :now, expiresAt = :expiry REMOVE sourceAuditKey, lookupPk, lookupSk, conflictKey, coalescedInto, taskId, eventId, decision, reconciliationGeneration, progressCheckpoint",
          ConditionExpression:"#status = :dismissed AND updatedAt = :version AND coalescedInto = :keeper AND sourceAuditKey = :audit AND conflictKey = :conflict AND attribute_not_exists(operationId)",
          ExpressionAttributeNames:{"#status":"status","#result":"result","#title":"title","#reason":"reason"},
          ExpressionAttributeValues:{":resolved":"resolved",":result":resolution,":title":"Verified deletion",
            ":reason":"verified_deletion",":dismissed":"dismissed",":version":child.updatedAt,
            ":keeper":caseId,":audit":child.sourceAuditKey,":conflict":current.conflictKey,
            ":now":now,":expiry":Math.floor(preparedAt/1000)+30*86400},
        }});
        items.push({Delete:{TableName:reviewTable(),
          Key:{pk:conflictPk,sk:`INCIDENT#${id}`},
          ConditionExpression:"incidentId = :id AND #profile = :profile AND conflictKey = :conflict",
          ExpressionAttributeNames:{"#profile":"profile"},
          ExpressionAttributeValues:{":id":id,":profile":expected.profile,":conflict":current.conflictKey},
        }});
        if(!auditDeletes.has(child.sourceAuditKey)){
          items.push({Delete:{TableName:reviewTable(),Key:key(child.sourceAuditKey),
            ConditionExpression:"createdAt = :created AND #action = :action",
            ExpressionAttributeNames:{"#action":"action"},
            ExpressionAttributeValues:{":created":audit.createdAt,":action":audit.action},
          }});
          auditDeletes.add(child.sourceAuditKey);
        }
      }
    }
    // Delivery receipts are shared replay evidence and have no reverse GSI.
    // Enumerate them strongly and scrub only exact verified-deleted IDs while
    // retaining receipt identity, expiry, idempotency data, and unrelated refs.
    let receiptCursor:Record<string,unknown>|undefined,receiptPages=0,receiptRows=0;
    const targetTaskIds=new Set(expected.taskIds),targetEventIds=new Set(expected.eventIds),targetSeriesIds=new Set(seriesKeys);
    do{
      const page=await this.db.send(new ScanCommand({TableName:reviewTable(),ConsistentRead:true,Limit:1000,
        ...(receiptCursor?{ExclusiveStartKey:receiptCursor}:{})}));
      receiptPages++;receiptRows+=(page.Items||[]).length;
      if(receiptPages>100||receiptRows>100_000)return blocked("delivery_receipt_inventory_over_limit");
      for(const raw of page.Items||[]){
        const row=raw as Record<string,unknown>,refs=row.identityRefs as Record<string,unknown>|undefined;
        if(typeof row.pk!=="string"||!row.pk.startsWith("DELIVERY#")||row.sk!=="COMPLETED"||!refs)continue;
        const tasks=refs.taskIds,events=refs.eventIds,series=refs.seriesIds;
        if(!Array.isArray(tasks)&&!Array.isArray(events)&&!Array.isArray(series))continue;
        const arrays=[tasks,events,series].filter(Array.isArray) as unknown[][];
        if(arrays.some(list=>list.some(id=>typeof id!=="string")||new Set(list).size!==list.length))
          return blocked("delivery_receipt_identity_inventory_malformed");
        const touches=(tasks as unknown[]|undefined)?.some(id=>targetTaskIds.has(id as string))
          ||(events as unknown[]|undefined)?.some(id=>targetEventIds.has(id as string))
          ||(series as unknown[]|undefined)?.some(id=>targetSeriesIds.has(id as string));
        if(!touches)continue;
        if(row.profile!==expected.profile)return blocked("cross_profile_delivery_receipt_identity_reference");
        if(typeof row.profile!=="string"||typeof row.kind!=="string"||typeof row.completedAt!=="string"
          ||typeof row.expiresAt!=="number")return blocked("delivery_receipt_identity_owner_or_version_incomplete");
        const nextRefs={...refs,
          ...(Array.isArray(tasks)?{taskIds:tasks.filter(id=>!targetTaskIds.has(id as string))}:{}),
          ...(Array.isArray(events)?{eventIds:events.filter(id=>!targetEventIds.has(id as string))}:{}),
          ...(Array.isArray(series)?{seriesIds:series.filter(id=>!targetSeriesIds.has(id as string))}:{})};
        if(!Array.isArray(tasks)||!Array.isArray(events))return blocked("delivery_receipt_identity_owner_or_version_incomplete");
        const names:Record<string,string>={"#refs":"identityRefs","#tasks":"taskIds","#events":"eventIds",
          "#profile":"profile","#kind":"kind"};
        const values:Record<string,unknown>={":profile":row.profile,":kind":row.kind,":completedAt":row.completedAt,
          ":expiresAt":row.expiresAt,":taskCount":Array.isArray(tasks)?tasks.length:0,":eventCount":Array.isArray(events)?events.length:0,
          ":newTasks":nextRefs.taskIds??[],":newEvents":nextRefs.eventIds??[]};
        const conditions=["#profile = :profile","#kind = :kind","completedAt = :completedAt","expiresAt = :expiresAt",
          "size(#refs.#tasks) = :taskCount","size(#refs.#events) = :eventCount"];
        const expressions=["#refs.#tasks = :newTasks","#refs.#events = :newEvents"];
        for(const[id,index]of (tasks as string[]).map((id,index)=>[id,index] as const))if(targetTaskIds.has(id)){
          const token=`:receiptTask${index}`;conditions.push(`contains(#refs.#tasks, ${token})`);values[token]=id;
        }
        for(const[id,index]of (events as string[]).map((id,index)=>[id,index] as const))if(targetEventIds.has(id)){
          const token=`:receiptEvent${index}`;conditions.push(`contains(#refs.#events, ${token})`);values[token]=id;
        }
        if(Array.isArray(series)){
          names["#series"]="seriesIds";values[":seriesCount"]=series.length;values[":newSeries"]=nextRefs.seriesIds;
          conditions.push("size(#refs.#series) = :seriesCount");expressions.push("#refs.#series = :newSeries");
          for(const[id,index]of (series as string[]).map((id,index)=>[id,index] as const))if(targetSeriesIds.has(id)){
            const token=`:receiptSeries${index}`;conditions.push(`contains(#refs.#series, ${token})`);values[token]=id;
          }
        }
        items.push({Update:{TableName:reviewTable(),Key:{pk:row.pk,sk:"COMPLETED"},
          UpdateExpression:`SET ${expressions.join(", ")}`,
          ConditionExpression:conditions.join(" AND "),ExpressionAttributeNames:names,ExpressionAttributeValues:values}});
        if(items.length>95)return blocked("transaction_item_limit_exceeded");
      }
      receiptCursor=page.LastEvaluatedKey as Record<string,unknown>|undefined;
    }while(receiptCursor);
    // Keep the seven-day completion lifecycle. After that window, retire only
    // exact task/event projection rows in this verified pair; terminal series
    // certificates remain as immutable replay guards.
    const completedCutoff=Date.now()-7*86400_000,completedSeen=new Set<string>();
    for(const eventId of expected.eventIds)for(const candidateProfile of cleanupProfiles){
      const result=await this.db.send(new GetCommand({TableName:reviewTable(),Key:key(`COMPLETED_EVENT#${candidateProfile}#${eventId}`),ConsistentRead:true}));
      const row=result.Item as Record<string,unknown>|undefined;
      if(!row)continue;
      if(row.profile!==candidateProfile||row.eventId!==eventId||typeof row.taskId!=="string")return blocked("completed_history_identity_inconsistent");
      if(candidateProfile!==expected.profile||!expected.taskIds.includes(row.taskId))return blocked("completed_history_has_foreign_owner");
      const completedAt=typeof row.completedAt==="string"?Date.parse(row.completedAt):NaN;
      if(!Number.isFinite(completedAt)||completedAt>completedCutoff)return blocked("completed_task_seven_day_guard_active");
      const pk=`COMPLETED_EVENT#${candidateProfile}#${eventId}`;
      if(!completedSeen.has(pk))items.push({Delete:{TableName:reviewTable(),Key:key(pk),
        ConditionExpression:"profile = :profile AND taskId = :task AND eventId = :event AND completedAt = :completedAt",
        ExpressionAttributeValues:{":profile":candidateProfile,":task":row.taskId,":event":eventId,":completedAt":row.completedAt}}});
      completedSeen.add(pk);
    }
    for(const taskId of expected.taskIds)for(const candidateProfile of cleanupProfiles){
      let cursor:Record<string,unknown>|undefined,pages=0;
      do{
        const page=await this.db.send(new QueryCommand({TableName:reviewTable(),ConsistentRead:true,Limit:100,
          KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":`COMPLETED_TASK#${candidateProfile}#${taskId}`,":prefix":"EVENT#"},
          ...(cursor?{ExclusiveStartKey:cursor}:{})}));
        pages++;if(pages>20)return blocked("completed_history_inventory_over_limit");
        for(const raw of page.Items||[]){
          const row=raw as Record<string,unknown>,eventId=typeof row.eventId==="string"?row.eventId:undefined;
          if(!eventId||!expected.eventIds.includes(eventId))continue;
          if(row.profile!==candidateProfile||row.taskId!==taskId)return blocked("completed_history_identity_inconsistent");
          if(candidateProfile!==expected.profile)return blocked("completed_history_has_foreign_owner");
          const completedAt=typeof row.completedAt==="string"?Date.parse(row.completedAt):NaN;
          if(!Number.isFinite(completedAt)||completedAt>completedCutoff)return blocked("completed_task_seven_day_guard_active");
          const pk=`COMPLETED_TASK#${candidateProfile}#${taskId}`,sk=typeof row.sk==="string"?row.sk:`EVENT#${eventId}`;
          const unique=`${pk}|${sk}`;
          if(!completedSeen.has(unique))items.push({Delete:{TableName:reviewTable(),Key:{pk,sk},
            ConditionExpression:"profile = :profile AND taskId = :task AND eventId = :event AND completedAt = :completedAt",
            ExpressionAttributeValues:{":profile":candidateProfile,":task":taskId,":event":eventId,":completedAt":row.completedAt}}});
          completedSeen.add(unique);
        }
        cursor=page.LastEvaluatedKey as Record<string,unknown>|undefined;
      }while(cursor);
    }
    // Retire only canonical identity and reconciliation baseline snapshots
    // scoped to the fully absent provider IDs. Every delete is version-fenced:
    // a concurrent new provider identity or repair aborts the whole transaction
    // instead of stripping a newer baseline or live canonical pointer.
    const canonicalRefs = [
      ...expected.taskIds.map(id => ({ side: "todoist", id })),
      ...expected.eventIds.map(id => ({ side: "calendar", id })),
    ];
    for (const ref of canonicalRefs) for(const candidateProfile of cleanupProfiles) {
      const pk = `CANONICAL#${candidateProfile}#${ref.side}#${ref.id}`;
      const currentIdentity = await this.get<Record<string, unknown>>(pk);
      if (!currentIdentity) continue;
      if (candidateProfile!==expected.profile||currentIdentity.profile !== expected.profile || currentIdentity.side !== ref.side
        || currentIdentity.providerId !== ref.id
        || typeof currentIdentity.updatedAt !== "string" || !currentIdentity.identity) return blocked("canonical_identity_record_inconsistent_or_foreign");
      items.push({ Delete: { TableName: reviewTable(), Key: key(pk),
        ConditionExpression: "#profile = :profile AND #side = :side AND providerId = :id AND updatedAt = :updated AND #identity = :identity",
        ExpressionAttributeNames: { "#profile": "profile", "#side": "side", "#identity": "identity" },
        ExpressionAttributeValues: { ":profile": expected.profile, ":side": ref.side, ":id": ref.id,
          ":updated": currentIdentity.updatedAt, ":identity": currentIdentity.identity },
      } });
    }
    for (const taskId of expected.taskIds) {
      for(const candidateProfile of ["home","antonio","work"] as Profile[])if(candidateProfile!==expected.profile){
        const foreign=(await this.db.send(new GetCommand({TableName:reviewTable(),Key:{pk:`BASELINE#${candidateProfile}#TASK#${taskId}`,sk:"RECONCILE"},ConsistentRead:true}))).Item;
        if(foreign)return blocked("cross_profile_reconciliation_baseline_reference");
      }
      const baselineKey = { pk: `BASELINE#${expected.profile}#TASK#${taskId}`, sk: "RECONCILE" };
      const currentBaseline = (await this.db.send(new GetCommand({
        TableName: reviewTable(), Key: baselineKey, ConsistentRead: true,
      }))).Item;
      if (!currentBaseline) continue;
      if (typeof currentBaseline.updatedAt !== "string" || !currentBaseline.baseline) return blocked("reconciliation_baseline_inconsistent");
      items.push({ Delete: { TableName: reviewTable(), Key: baselineKey,
        ConditionExpression: "updatedAt = :updated AND baseline = :baseline",
        ExpressionAttributeValues: { ":updated": currentBaseline.updatedAt, ":baseline": currentBaseline.baseline },
      } });
    }
    // Query only exact-provider reverse indexes. Do not scan the audit table:
    // older records without these pointers retain their original 7-day TTL.
    // Every candidate audit is re-read and deleted only when *all* its
    // recorded provider IDs are within this verified-deleted fixture.
    const auditDeletes = new Set(items.filter(x => x.Delete)
      .map(x => x.Delete?.Key?.pk).filter((value): value is string => typeof value === "string"));
    const referenceKeys = cleanupProfiles.flatMap(candidate=>[
      ...expected.taskIds.map(id => `AUDIT_REF#${candidate}#todoist#${id}`),
      ...expected.eventIds.map(id => `AUDIT_REF#${candidate}#calendar#${id}`),
    ]);
    const referencedAudits = new Map<string, Record<string, unknown>>();
    const auditPointers = new Map<string, { key: { pk: string; sk: string }; auditKey: string }>();
    for (const pk of referenceKeys) {
      const page = await this.db.send(new QueryCommand({ TableName: reviewTable(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "AUDIT#" },
        ConsistentRead: true, Limit: 50 }));
      if (page.LastEvaluatedKey) return blocked("audit_pointer_inventory_exceeds_safe_bound"); // no partially attributed cleanup
      for (const row of page.Items || []) {
        if(typeof row.auditKey!=="string"||typeof row.sk!=="string")return blocked("audit_pointer_identity_incomplete");
        if(!pk.startsWith(`AUDIT_REF#${expected.profile}#`))return blocked("cross_profile_audit_identity_reference");
        if(!row.auditKey.startsWith(`AUDIT#${expected.profile}#`))return blocked("audit_pointer_owner_mismatch");
        const pointerKey = { pk, sk: row.sk };
        auditPointers.set(`${pk}|${row.sk}`, { key: pointerKey, auditKey: row.auditKey });
        if (!referencedAudits.has(row.auditKey)) {
          const record = await this.get<Record<string, unknown>>(row.auditKey);
          if (record) referencedAudits.set(row.auditKey, record);
        }
      }
    }
    const safeAudits = new Set<string>();
    for (const [auditKey, record] of referencedAudits) {
      const auditDetail = record.detail && typeof record.detail === "object"
        ? record.detail as Record<string, unknown> : undefined;
      if (!auditDetail || typeof record.action !== "string"
        || /(?:operational|dlq)/.test(record.action)) continue;
      const identities = retainedAuditProviderIds(auditDetail);
      if (!identities.taskIds.length && !identities.eventIds.length) continue;
      if (identities.taskIds.every(id => expected.taskIds.includes(id))
        && identities.eventIds.every(id => expected.eventIds.includes(id))
        && (!selected || attributableIdentities(auditDetail))) safeAudits.add(auditKey);
    }
    for (const auditKey of safeAudits) {
      if (auditDeletes.has(auditKey)) continue;
      const record = referencedAudits.get(auditKey)!;
      items.push({ Delete: { TableName: reviewTable(), Key: key(auditKey),
        ConditionExpression: "createdAt = :createdAt AND #action = :action",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: { ":createdAt": record.createdAt, ":action": record.action },
      } });
    }
    for (const pointer of auditPointers.values()) {
      if (!safeAudits.has(pointer.auditKey) && referencedAudits.has(pointer.auditKey)) continue;
      items.push({ Delete: { TableName: reviewTable(), Key: pointer.key,
        ConditionExpression: "auditKey = :auditKey",
        ExpressionAttributeValues: { ":auditKey": pointer.auditKey },
      } });
    }
    // The earlier provider/state reads are only a preflight. Fence the shared
    // DynamoDB ownership and repair/completion indexes in the SAME atomic
    // transaction as the terminal case update. A concurrent sync or repair
    // that claims any verified identity must cancel the entire retirement.
    const absence = new Map<string, { pk: string; sk: string }>();
    const checkAbsent = (pk: string, sk = "MAP"): void => {
      absence.set(`${pk}|${sk}`, { pk, sk });
    };
    for (const taskId of expected.taskIds) {
      if(!mappingDeleteKeys.has(`TASKOWNER#${taskId}|MAP`)&&!staleMappings.some(mapping=>mapping.taskId===taskId))checkAbsent(`TASKOWNER#${taskId}`);
      for (const candidateProfile of cleanupProfiles) {
        if(!mappingDeleteKeys.has(`TASK#${candidateProfile}#${taskId}|MAP`)
          &&!staleMappings.some(mapping=>mapping.profile===candidateProfile&&mapping.taskId===taskId))checkAbsent(`TASK#${candidateProfile}#${taskId}`);
        // Every recurrence identity is fenced together below, including
        // the Calendar iCalUID key rather than only task-ID keys.
      }
    }
    for (const eventId of expected.eventIds) {
      for (const candidateProfile of cleanupProfiles) {
        if(!mappingDeleteKeys.has(`EVENT#${candidateProfile}#${eventId}|MAP`)
          &&!staleMappings.some(mapping=>mapping.profile===candidateProfile&&mapping.eventId===eventId))checkAbsent(`EVENT#${candidateProfile}#${eventId}`);
        // Completed task/event projections remain untouched and are not
        // considered live ownership of a deleted recurrence.
      }
    }
    for (const seriesId of seriesKeys) for (const candidateProfile of cleanupProfiles) {
      checkAbsent(`RECURRENCE#${candidateProfile}#${seriesId}`, "STATE");
    }
    // Never ConditionCheck a key that is also deleted in this transaction.
    // Such a duplicate would invalidate all DynamoDB transactions.
    const modified = new Set(items.flatMap(x =>
      [x.Update?.Key, x.Delete?.Key, x.Put?.Item].filter(Boolean)
        .map(key => `${key!.pk}|${key!.sk}`)));
    for (const [k, Key] of absence) {
      if (modified.has(k)) continue;
      items.push({ ConditionCheck: { TableName: reviewTable(), Key,
        ConditionExpression: "attribute_not_exists(pk)" } });
    }
    for (const ref of refs) for(const candidateProfile of cleanupProfiles) {
      items.push({ ConditionCheck: { TableName: reviewTable(),
        Key: key(`SYNC_CONTROL#${candidateProfile}:${ref.side}:${ref.id}`),
        ConditionExpression: "attribute_not_exists(activeRepair) AND (attribute_not_exists(excluded) OR excluded = :no)",
        ExpressionAttributeValues: { ":no": false },
      } });
    }
    if (items.length > 95) return blocked("transaction_item_limit_exceeded");
    return items;
  }

  private async commitVerifiedDeletion(items: VerifiedDeletionTransaction): Promise<boolean> {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditional(error) || (error as { name?: string }).name === "TransactionCanceledException") {
        const cancellationReasons=(error as { CancellationReasons?: Array<{Code?:string}> }).CancellationReasons;
        const failedIndex=cancellationReasons?.findIndex(reason=>reason.Code&&reason.Code!=="None")??-1;
        const failedItem=failedIndex>=0?items[failedIndex]:undefined;
        const failedKey=failedItem?.ConditionCheck?.Key||failedItem?.Delete?.Key||failedItem?.Update?.Key;
        const pk=typeof failedKey?.pk==="string"?failedKey.pk:"";
        const category=pk.startsWith("REVIEW_CASE#")?"case_revision_or_status_changed"
          :pk.startsWith("MANUAL#")?"manual_decision_revision_or_status_changed"
          :pk.startsWith("RECURRENCE#")?"recurrence_link_revision_or_owner_changed"
          :pk.startsWith("AUDIT")?"audit_or_pointer_revision_changed"
          :pk.startsWith("SYNC_CONTROL#")?"repair_or_exclusion_guard_changed"
          :pk.startsWith("ERASURE#")?"fence_or_scoped_admission_changed"
          :pk.startsWith("HISTORICAL_CLEANUP#")?"historical_cleanup_checkpoint_changed"
          :pk.startsWith("TASK")||pk.startsWith("EVENT")?"live_mapping_or_owner_appeared"
          :"conditional_state_changed";
        this.lastVerifiedDeletionBlocker = `${category}_retry_required`;
        return false;
      }
      throw error;
    }
  }

  async noteVerifiedDeletionCleanupDeferred(caseId: string, expectedUpdatedAt: string, blocker = "provider_or_state_precondition_unavailable"): Promise<void> {
    const current = await this.getCase(caseId);
    if (!current) return;
    await admitNestedReviewIdentities(current,current.profile);
    try {
      await this.db.send(new UpdateCommand({ TableName: reviewTable(),
        Key: key(`REVIEW_CASE#${caseId}`),
        UpdateExpression: "SET #result = :message, updatedAt = :now",
        ConditionExpression: "#status = :open AND updatedAt = :version AND attribute_not_exists(operationId)",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" },
        ExpressionAttributeValues: { ":open": "open", ":version": expectedUpdatedAt,
          ":message": `deletion_cleanup_deferred: ${blocker}; automatic_retry=not_scheduled; next_action=${blocker.endsWith("_retry_required")?"retry_after_fresh_recheck":"inspect_exact_blocking_state"}`,
          ":now": new Date().toISOString() },
      }));
    } catch (error) {
      // A changed case is not ours to update; preserve newer review/repair state.
      if (!conditional(error)) throw error;
    }
  }

  async updateCase(id: string, status: ReviewCase["status"], result: string, operationId?: string): Promise<void> {
    const current = await this.getCase(id); if (!current) throw new Error("Conflict no longer exists");
    await admitNestedReviewIdentities(current,current.profile);
    const terminal = ["resolved", "excluded", "dismissed"].includes(status);
    const condition = status === "repairing"
      ? "#s = :open OR (#s = :dismissed AND (attribute_not_exists(operationId) OR operationId = :empty)) OR (#s = :repairing AND operationId = :op)"
      : status === "open"
        ? "#s = :repairing AND operationId = :op"
        : "#s = :current AND (attribute_not_exists(operationId) OR operationId = :op)";
    const values: Record<string, unknown> = { ":s":status, ":r":result, ":now":new Date().toISOString(), ":op":operationId || "",
      ":lookup":`REVIEW#${terminal ? "CLOSED" : "OPEN"}#${current.createdAt}#${id}` };
    if (status === "repairing") Object.assign(values,{ ":open":"open", ":dismissed":"dismissed", ":empty":"", ":repairing":"repairing" });
    else if (status === "open") values[":repairing"]="repairing";
    else values[":current"]=current.status;
    await this.db.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`REVIEW_CASE#${id}`),
      UpdateExpression: "SET #s = :s, #r = :r, updatedAt = :now, operationId = :op, lookupSk = :lookup",
      ConditionExpression: condition,
      ExpressionAttributeNames: { "#s": "status", "#r": "result" }, ExpressionAttributeValues: values }));
  }
  async putPreview(preview: RepairPreview): Promise<void> {
    await assertRepairPreviewReplayAdmission(preview);
    await this.db.send(new PutCommand({ TableName: reviewTable(), Item: { ...preview, ...key(`REPAIR_PREVIEW#${preview.id}`) }, ConditionExpression: "attribute_not_exists(pk)" }));
  }
  getPreview(id: string): Promise<RepairPreview | undefined> { return this.get(`REPAIR_PREVIEW#${id}`); }
  getOperation(id: string): Promise<RepairOperation | undefined> { return this.get(`REPAIR#${id}`); }
  async submit(preview: RepairPreview, actor: ReviewActor, idempotencyKey: string): Promise<RepairOperation> {
    await assertRepairPreviewReplayAdmission(preview);
    if (preview.actor.subject !== actor.subject || preview.expiresAt * 1000 <= Date.now()) throw new Error("Preview expired or belongs to another operator");
    const id = reviewHash([actor.subject, preview.id, idempotencyKey]).slice(0, 32);
    const old = await this.getOperation(id); if (old) return old;
    const caseStatus = preview.case?.status;
    const terminalCase = ["resolved", "excluded", "dismissed"].includes(caseStatus || "");
    const superseded = preview.case?.operationId && (caseStatus === "repairing" || terminalCase)
      ? await this.getOperation(preview.case.operationId) : undefined;
    const safelyAbandoned = superseded?.status === "failed" && superseded.abandoned === true
      && !operationHasWriteEvidence(superseded);
    const priorSucceeded = terminalCase && superseded?.status === "succeeded";
    if (preview.case?.operationId && (caseStatus === "repairing" || terminalCase)
      && !safelyAbandoned && !priorSucceeded) {
      throw Object.assign(new Error("This case already has an active repair; refresh it and resume that operation"), { status:409 });
    }
    const operation: RepairOperation = { id, preview, actor, attempt: 1, status: "queued", steps: {}, notificationPending: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try { await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: reviewTable(), Key: key(`REPAIR_PREVIEW#${preview.id}`), UpdateExpression: "SET submittedOperation = :id",
        ConditionExpression: "attribute_not_exists(submittedOperation) OR submittedOperation = :id", ExpressionAttributeValues: { ":id": id } } },
      { Put: { TableName: reviewTable(), Item: { ...operation, ...key(`REPAIR#${id}`) }, ConditionExpression: "attribute_not_exists(pk)" } },
      // Reserve the case together with its queued operation. A fresh preview may
      // deliberately replace a terminal disposition, but only the exact case
      // revision it displayed; concurrent or stale submissions cannot steal it.
      { Update: { TableName:reviewTable(), Key:key(`REVIEW_CASE#${preview.intent.caseId}`),
        UpdateExpression:"SET #status = :repairing, operationId = :id, updatedAt = :now, lookupSk = :lookup",
        ConditionExpression:"#status = :expectedStatus AND " + (preview.case.operationId === undefined ? "attribute_not_exists(operationId)" : "operationId = :expectedOperation") + (preview.case.updatedAt ? " AND updatedAt = :expectedUpdatedAt" : ""),
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":repairing":"repairing",":id":id,":now":operation.createdAt,
          ":lookup":`REVIEW#OPEN#${preview.case.createdAt}#${preview.case.id}`,":expectedStatus":preview.case.status,
          ...(preview.case.operationId === undefined ? {} : {":expectedOperation":preview.case.operationId}),
          ...(preview.case.updatedAt ? {":expectedUpdatedAt":preview.case.updatedAt} : {})} } },
      ...(safelyAbandoned ? [{ ConditionCheck:{ TableName:reviewTable(), Key:key(`REPAIR#${superseded.id}`),
        ConditionExpression:"#status = :failed AND abandoned = :yes AND (attribute_not_exists(writeStarted) OR writeStarted = :no)",
        ExpressionAttributeNames:{"#status":"status"}, ExpressionAttributeValues:{":failed":"failed",":yes":true,":no":false} } }] : []),
    ] })); } catch (e) {
      const current = await this.getOperation(id); if (current) return current;
      const claimed = await this.getPreview(preview.id) as (RepairPreview & { submittedOperation?:string }) | undefined;
      if (claimed?.submittedOperation && claimed.submittedOperation !== id) {
        throw Object.assign(new Error("This preview was already submitted with a different idempotency key; create a fresh preview"), { status:409 });
      }
      const latestSuperseded = superseded ? await this.getOperation(superseded.id) : undefined;
      if (safelyAbandoned && (!latestSuperseded?.abandoned || latestSuperseded.status !== "failed" || operationHasWriteEvidence(latestSuperseded))) {
        throw Object.assign(new Error("This case already has an active repair; refresh it and resume that operation"), { status:409 });
      }
      const currentCase = await this.getCase(preview.intent.caseId);
      if (!currentCase || currentCase.status !== preview.case.status || currentCase.operationId !== preview.case.operationId
        || preview.case.updatedAt && currentCase.updatedAt !== preview.case.updatedAt) {
        throw Object.assign(new Error("This case changed after preview; refresh the case and create a fresh preview"), { status:409 });
      }
      if (conditional(e) || (e as { name?:string }).name === "TransactionCanceledException") {
        throw Object.assign(new Error("This case or repair changed while submitting; refresh the case and try again"), { status:409 });
      }
      throw e;
    }
    return operation;
  }
  async saveOperation(operation: RepairOperation): Promise<void> {
    await assertRepairPreviewReplayAdmission(operation.preview);
    operation.updatedAt = new Date().toISOString();
    await this.db.send(new PutCommand({ TableName: reviewTable(), Item: { ...operation, ...key(`REPAIR#${operation.id}`),
      lookupPk: `PROFILE#${operation.preview.intent.profile}`, lookupSk: `REPAIR#${operation.notificationPending ? "NOTIFY" : "HISTORY"}#${operation.id}` },
      ConditionExpression:operation.status === "succeeded" ? "#status = :succeeded AND attribute_not_exists(abandoned)"
        : operation.abandoned ? "#status = :failed AND abandoned = :yes"
        : "(attribute_not_exists(pk) OR #status <> :succeeded) AND attribute_not_exists(abandoned)",
      ExpressionAttributeNames:{"#status":"status"}, ExpressionAttributeValues:operation.status === "succeeded"
        ? {":succeeded":"succeeded"}
        : operation.abandoned ? {":failed":"failed",":yes":true} : {":succeeded":"succeeded"} }));
  }
  async completeNotification(operationId: string, replyTs?: string): Promise<void> {
    await this.db.send(new UpdateCommand({ TableName:reviewTable(), Key:key(`REPAIR#${operationId}`),
      UpdateExpression:"SET notificationPending = :false, updatedAt = :now, lookupSk = :lookup" + (replyTs ? ", notificationReplyTs = :reply" : ""),
      ConditionExpression:"#status IN (:succeeded, :needsReview, :failed)",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":false":false,":now":new Date().toISOString(),":lookup":"REPAIR#HISTORY#"+operationId,":succeeded":"succeeded",":needsReview":"needs_review",":failed":"failed",...(replyTs?{":reply":replyTs}:{})} }));
  }
  async finalizeOperation(operation: RepairOperation, releases: RepairRelease[]): Promise<RepairOperation> {
    await assertRepairPreviewReplayAdmission(operation.preview);
    for (const release of releases) await admitReviewIdentity(release.ref.profile,
      release.ref.side === "todoist" ? release.ref.id : undefined,
      release.ref.side === "calendar" ? release.ref.id : undefined);
    const current = await this.getCase(operation.preview.intent.caseId);
    if (!current) throw new Error("Conflict no longer exists");
    const now = new Date().toISOString();
    const completed: RepairOperation = { ...operation, status:"succeeded", updatedAt:now, error:undefined, nextAction:undefined,
      notificationPending:true, notificationText:operation.notificationText || "Succeeded: repair verified" };
    // ReviewCase stores a snapshot of its source ManualDecision. The worker
    // resolves that decision before finalizing this transaction; carry the
    // same terminal state into the snapshot so the API cannot return a closed
    // case with an apparently pending embedded decision.
    const completedDecision = current.decision?.status === "pending"
      ? { ...current.decision, status:"resolved" as const,
        resolution:"Resolved and verified in the review page", resolvedAt:now }
      : current.decision;
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        ...[...new Map(releases.map(item => [entityKey(item.ref), item])).values()].map(item => ({ Update: {
          TableName:reviewTable(), Key:key(`SYNC_CONTROL#${entityKey(item.ref)}`),
          UpdateExpression:item.preserveControlState ? "REMOVE activeRepair" : `SET fencedAt = :now, providerUpdatedAt = :version${item.clearExclusion ? ", excluded = :false" : ""} REMOVE activeRepair`,
          ConditionExpression:"activeRepair = :id", ExpressionAttributeValues:item.preserveControlState ? { ":id":operation.id } : { ":id":operation.id, ":now":now, ":version":item.providerUpdatedAt || "", ...(item.clearExclusion ? {":false":false} : {}) },
        } })),
        { Put:{ TableName:reviewTable(), Item:{ ...completed, ...key(`REPAIR#${operation.id}`),
          lookupPk:`PROFILE#${operation.preview.intent.profile}`, lookupSk:`REPAIR#NOTIFY#${operation.id}` },
          ConditionExpression:"#status <> :succeeded", ExpressionAttributeNames:{"#status":"status"}, ExpressionAttributeValues:{":succeeded":"succeeded"} } },
        { Update:{ TableName:reviewTable(), Key:key(`REVIEW_CASE#${current.id}`),
          UpdateExpression:"SET #status = :status, #result = :result, updatedAt = :now, operationId = :id, lookupSk = :lookup" + (completedDecision ? ", decision = :decision" : ""),
          ConditionExpression:"#status = :repairing AND operationId = :id",
          ExpressionAttributeNames:{"#status":"status","#result":"result"}, ExpressionAttributeValues:{
            ":repairing":"repairing",
            ":status":operation.preview.intent.action === "exclude" ? "excluded" : "resolved", ":result":"Repair verified against current provider state",
            ":now":now, ":id":operation.id, ":lookup":`REVIEW#CLOSED#${current.createdAt}#${current.id}`,
            ...(completedDecision ? { ":decision":completedDecision } : {}),
          } } },
      ] }));
      return completed;
    } catch (error) {
      // A lost response must not turn an already committed success into a
      // failed run that reclaims its freshly released barriers.
      const saved = await this.getOperation(operation.id);
      if (saved?.status === "succeeded") return saved;
      throw error;
    }
  }
  async pendingNotifications(profile: Profile): Promise<RepairOperation[]> {
    const items: RepairOperation[] = []; let cursor: Record<string, unknown> | undefined;
    do { const page = await this.db.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)", ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": "REPAIR#NOTIFY#" }, ExclusiveStartKey: cursor }));
      items.push(...(page.Items || []) as RepairOperation[]); cursor = page.LastEvaluatedKey;
    } while (cursor); return items;
  }
}
export interface SyncControl { excluded?: boolean; activeRepair?: string; pendingRefresh?: boolean; pendingRefreshAt?: string; fencedAt?: string; providerUpdatedAt?: string }
export class SyncControls {
  control(ref: EntityRef): Promise<SyncControl | undefined> { return new ReviewStore().get(`SYNC_CONTROL#${entityKey(ref)}`); }
  async rejected(profile: Profile, taskId: string, eventId: string): Promise<boolean> {
    return Boolean(await new ReviewStore().get(`REJECTED_PAIR#${profile}#${taskId}#${eventId}`));
  }
  async reject(profile: Profile, taskId: string, eventId: string, operationId: string): Promise<void> {
    await admitReviewIdentity(profile, taskId, eventId);
    await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...key(`REJECTED_PAIR#${profile}#${taskId}#${eventId}`), operationId, createdAt: new Date().toISOString() } }));
  }
  async allow(profile: Profile, taskId: string, eventId: string): Promise<void> {
    await admitReviewIdentity(profile, taskId, eventId);
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await client.send(new DeleteCommand({ TableName: reviewTable(), Key: key(`REJECTED_PAIR#${profile}#${taskId}#${eventId}`) }));
  }
  async blocked(profile: Profile, ids: { taskId?: string; eventId?: string }, operationId?: string): Promise<boolean> {
    await admitReviewIdentity(profile, ids.taskId, ids.eventId);
    for (const side of ["todoist", "calendar"] as const) {
      const id = side === "todoist" ? ids.taskId : ids.eventId; if (!id) continue;
      const ref = { profile, side, id }, control = await this.control(ref);
      if (control?.activeRepair && control.activeRepair !== operationId) {
        await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET pendingRefresh = :true, pendingRefreshAt = :at", ExpressionAttributeValues: { ":true": true, ":at": randomUUID() } }));
        return true;
      }
      if (control?.excluded && (!operationId || control.activeRepair !== operationId)) return true;
    }
    if (ids.taskId && ids.eventId) {
      const rejection = await new ReviewStore().get<{ operationId?: string }>(`REJECTED_PAIR#${profile}#${ids.taskId}#${ids.eventId}`);
      if (rejection && rejection.operationId !== operationId) return true;
    }
    return false;
  }
  async claim(refs: EntityRef[], operationId: string): Promise<void> {
    if (!refs.length) return;
    for (const ref of [...new Map(refs.map(item => [entityKey(item), item])).values()]) await admitEntityRef(ref);
    await client.send(new TransactWriteCommand({ TransactItems: [...new Map(refs.map(ref => [entityKey(ref), ref])).values()].map(ref => ({ Update: {
      TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET activeRepair = :id",
      ConditionExpression: "attribute_not_exists(activeRepair) OR activeRepair = :id", ExpressionAttributeValues: { ":id": operationId },
    } })) }));
  }
  // Atomically release an unapplied failed repair, checking the controls from its preview.
  async releaseUnapplied(
    refs: EntityRef[], operationId: string, snapshots: ReviewSnapshot[], failure: { error: string; nextAction: string },
    queuedRefresh: Array<EntityRef & {pendingRefreshAt: string}> = [],
  ): Promise<void> {
    const previous = new Map(snapshots.map(s => [entityKey(s.ref), s.control || {}]));
    const queued = new Map(queuedRefresh.map(ref => [entityKey(ref), ref.pendingRefreshAt]));
    const unique = [...new Map(refs.map(ref => [entityKey(ref), ref])).values()];
    if (!unique.length) return;
    for (const ref of unique) await admitEntityRef(ref);
    const items = unique.map(ref => {
      const before = previous.get(entityKey(ref));
      if (!before) throw new Error(`No preview control snapshot for ${entityKey(ref)}; cannot release its repair barrier`);
      const values: Record<string, unknown> = { ':id': operationId, ':now': new Date().toISOString() };
      const conditions = ['activeRepair = :id'];
      for (const name of ['excluded', 'fencedAt', 'providerUpdatedAt'] as const) {
        const value = before[name];
        if (value === undefined) conditions.push(`attribute_not_exists(${name})`);
        else { values[`:${name}`] = value; conditions.push(`${name} = :${name}`); }
      }
      // A webhook arriving after pendingRefreshRefs() but before this transaction
      // changes the token and rejects the entire release. No refresh is lost.
      if (queued.has(entityKey(ref))) {
        values[':pendingTrue'] = true;
        values[':pendingAt'] = queued.get(entityKey(ref));
        conditions.push('pendingRefresh = :pendingTrue', 'pendingRefreshAt = :pendingAt');
      } else {
        values[':pendingFalse'] = false;
        conditions.push('(attribute_not_exists(pendingRefresh) OR pendingRefresh = :pendingFalse)',
          'attribute_not_exists(pendingRefreshAt)');
      }
      return { Update: { TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`),
        UpdateExpression: 'SET fencedAt = :now REMOVE activeRepair',
        ConditionExpression: conditions.join(' AND '), ExpressionAttributeValues: values } };
    });
    // Include the terminal operation marker in the SAME transaction as lock release.
    // A crash or lost response cannot replay a previously validated preview.
    const operationMarker = { Update: { TableName: reviewTable(), Key: key(`REPAIR#${operationId}`),
      UpdateExpression: 'SET abandoned = :yes, #status = :failed, #error = :error, nextAction = :next, updatedAt = :now, notificationPending = :yes, notificationText = :notice, lookupSk = :lookup',
      // A concurrently retried operation may have passed read-only validation
      // after the preview inspected it. Its next execution step persists this
      // marker before doing work, so abandonment cannot release its barrier.
      ConditionExpression: 'attribute_exists(pk) AND #status <> :succeeded AND attribute_not_exists(abandoned) AND attribute_not_exists(writeStarted)',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: { ':yes': true, ':failed': 'failed', ':succeeded': 'succeeded', ':error': failure.error, ':next': failure.nextAction, ':now': new Date().toISOString(),
        ':notice': `Failed: ${failure.error}`, ':lookup': `REPAIR#NOTIFY#${operationId}` }
    } };
    await client.send(new TransactWriteCommand({ TransactItems: [...items, operationMarker] }));
  }
  async exclude(ref: EntityRef, excluded: boolean, operationId: string): Promise<void> {
    await admitEntityRef(ref);
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET excluded = :excluded",
      ConditionExpression: "activeRepair = :id", ExpressionAttributeValues: { ":excluded": excluded, ":id": operationId } }));
  }
  // Release both identities in one DynamoDB transaction. A partial release
  // would permit task-only retries while the Calendar master remains blocked.
  async releasePair(refs: EntityRef[], operationId: string): Promise<void> {
    const unique = [...new Map(refs.map(ref=>[entityKey(ref),ref])).values()];
    if (unique.length !== 2 || !operationId) throw new Error("Exact two-identity Phase B release required");
    for (const ref of unique) await admitEntityRef(ref);
    const at = new Date().toISOString();
    await client.send(new TransactWriteCommand({ TransactItems: unique.map(ref=>({ Update:{
      TableName: reviewTable(), Key:key(`SYNC_CONTROL#${entityKey(ref)}`),
      UpdateExpression:"SET fencedAt = :now, providerUpdatedAt = :version REMOVE activeRepair",
      ConditionExpression:"activeRepair = :id",
      ExpressionAttributeValues:{":id":operationId,":now":at,":version":""},
    } })) }));
  }
  async release(ref: EntityRef, operationId: string, providerUpdatedAt?: string): Promise<void> {
    await admitEntityRef(ref);
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`),
      UpdateExpression: "SET fencedAt = :now, providerUpdatedAt = :version REMOVE activeRepair",
      ConditionExpression: "activeRepair = :id", ExpressionAttributeValues: { ":id": operationId, ":now": new Date().toISOString(), ":version": providerUpdatedAt || "" } }));
  }
  async pendingRefreshRefs(refs: EntityRef[]): Promise<Array<EntityRef & {pendingRefreshAt:string}>> {
    const pending: Array<EntityRef & {pendingRefreshAt:string}> = [];
    for (const ref of [...new Map(refs.map(item=>[entityKey(item),item])).values()]) {
      const control = await this.control(ref);
      if (control?.pendingRefresh && control.pendingRefreshAt) pending.push({...ref,pendingRefreshAt:control.pendingRefreshAt});
    }
    return pending;
  }
  async clearPendingRefresh(refs: Array<EntityRef & {pendingRefreshAt:string}>): Promise<void> {
    for (const ref of refs) {
      await admitEntityRef(ref);
      try {
        await client.send(new UpdateCommand({TableName:reviewTable(),Key:key(`SYNC_CONTROL#${entityKey(ref)}`),
          UpdateExpression:"REMOVE pendingRefresh, pendingRefreshAt",
          ConditionExpression:"pendingRefresh = :true AND pendingRefreshAt = :at AND attribute_not_exists(activeRepair)",
          ExpressionAttributeValues:{":true":true,":at":ref.pendingRefreshAt}}));
      } catch (error) { if (!conditional(error)) throw error; }
    }
  }
}
export const newPreviewId = () => randomUUID();

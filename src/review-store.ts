import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient as client } from "./dynamodb-capacity.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { Profile, RecurrenceLink } from "./types.js";
import { retainedAuditProviderIds, retainedConflictEntity, retainedConflictIdentity } from "./audit-policy.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { entityKey, operationHasWriteEvidence, type EntityRef, type RepairOperation, type RepairPreview, type RepairRelease, type ReviewActor, type ReviewCase, type ReviewSnapshot } from "./review-types.js";
import { assertReplayAdmissionIfEnabled, REPLAY_PROFILES } from "./erasure-replay-barrier.js";
export function reviewTable(): string { if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required"); return process.env.STATE_TABLE_NAME; }
export function reviewHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
const key = (pk: string) => ({ pk, sk: "STATE" });
const conditional = (e: unknown) => (e as { name?: string }).name === "ConditionalCheckFailedException";
const dismissalResolutions = new Set(["acknowledge","keep_separate","ignore","dismiss","dismissed"]);
async function admitReviewIdentity(profile: Profile, taskId?: string, eventId?: string): Promise<void> {
  if (taskId || eventId) await assertReplayAdmissionIfEnabled({ profile,
    ...(taskId ? { taskId } : {}), ...(eventId ? { eventIds: [eventId] } : {}) });
}
async function admitEntityRef(ref: EntityRef): Promise<void> {
  await admitReviewIdentity(ref.profile,
    ref.side === "todoist" ? ref.id : undefined,
    ref.side === "calendar" ? ref.id : undefined);
}
async function admitNestedReviewIdentities(value: unknown, defaultProfile: Profile): Promise<void> {
  const refs = new Map<string, EntityRef>();
  const taskFields = new Set(["taskId","providerTaskId","linkedTaskId","ownerTaskId","discardedTaskId","retainedTaskId","masterTaskId"]);
  const eventFields = new Set(["eventId","providerEventId","masterEventId","recurringMasterId","masterId","activeInstanceId","occurrenceId","selectedEventId","seriesId"]);
  const taskArrayFields = new Set(["taskIds","candidateTaskIds"]);
  const eventArrayFields = new Set(["eventIds","candidateEventIds"]);
  const add = (profile: Profile, side: EntityRef["side"], id: string) => {
    const ref = {profile,side,id}; refs.set(entityKey(ref),ref);
  };
  const collect = (item: unknown, profile: Profile, field = ""): void => {
    if (Array.isArray(item)) {
      if (taskArrayFields.has(field)) for (const id of item) if (typeof id === "string" && id) add(profile,"todoist",id);
      if (eventArrayFields.has(field)) for (const id of item) if (typeof id === "string" && id) add(profile,"calendar",id);
      for (const child of item) collect(child,profile,field);
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item as Record<string,unknown>;
    const selectedProfile = typeof object.profile === "string" && REPLAY_PROFILES.includes(object.profile as Profile)
      ? object.profile as Profile : profile;
    for (const [name,child] of Object.entries(object)) {
      if (typeof child === "string" && child && taskFields.has(name)) add(selectedProfile,"todoist",child);
      if (typeof child === "string" && child && eventFields.has(name)) add(selectedProfile,"calendar",child);
      collect(child,selectedProfile,name);
    }
  };
  collect(value,defaultProfile);
  for (const ref of refs.values()) await admitEntityRef(ref);
}
export async function assertRepairPreviewReplayAdmission(preview: RepairPreview): Promise<void> {
  const refs = new Map<string, EntityRef>();
  await admitNestedReviewIdentities(preview,preview.intent.profile);
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
  for (const ref of [...refs.values(), ...intent]) await admitReviewIdentity(ref.profile,
    ref.side === "todoist" ? ref.id : undefined, ref.side === "calendar" ? ref.id : undefined);
}
export class ReviewStore {
  constructor(private readonly db: Pick<typeof client, "send"> = client) {}
  async get<T>(pk: string): Promise<T | undefined> {
    return (await this.db.send(new GetCommand({ TableName: reviewTable(), Key: key(pk), ConsistentRead: true }))).Item as T | undefined;
  }
  async observeDecision(decision: ManualDecision): Promise<void> {
    const context = decision.context || {};
    await admitNestedReviewIdentities(decision,decision.profile);
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
  async resolveVerifiedDeletedCase(
    caseId: string,
    expected: {
      profile: Profile; taskIds: string[]; eventIds: string[];
      staleLinks?: RecurrenceLink[]; seriesKeys?: string[];
      masterId?: string; activeInstanceId?: string; masterSeriesId?: string;
    },
  ): Promise<boolean> {
    const current = await this.getCase(caseId);
    if (!current || current.profile !== expected.profile || !["open", "dismissed"].includes(current.status)
      || current.operationId || current.result?.startsWith("resolved_deleted")) return false;
    await admitNestedReviewIdentities(current,current.profile);
    const { taskIds, eventIds } = reviewCaseEvidenceIds(current);
    if (!taskIds.length || !eventIds.length
      || taskIds.some(id => !expected.taskIds.includes(id))
      || eventIds.some(id => !expected.eventIds.includes(id))) return false;

    const manual = await this.get<ManualDecision>(`MANUAL#${caseId}`);
    if (manual && (!["pending", "resolved"].includes(manual.status) || manual.profile !== expected.profile
      || manual.decisionId !== caseId)) return false;
    const source = current.sourceAuditKey && current.sourceAuditKey.startsWith(`AUDIT#${expected.profile}#`)
      ? await this.get<Record<string, unknown>>(current.sourceAuditKey) : undefined;
    const detail = source?.detail && typeof source.detail === "object"
      ? source.detail as Record<string, unknown> : undefined;
    const attribution = detail ? retainedAuditProviderIds(detail) : { taskIds: [], eventIds: [] };
    const attributable = Boolean(source && detail && attribution.taskIds.length + attribution.eventIds.length > 0
      && attribution.taskIds.every(id => expected.taskIds.includes(id))
      && attribution.eventIds.every(id => expected.eventIds.includes(id)));
    const pointerKey = current.conflictKey && current.id.startsWith("incident-")
      ? { pk: `REVIEW_CONFLICT#${expected.profile}#${current.conflictKey}`, sk: `INCIDENT#${caseId}` }
      : undefined;
    const pointer = pointerKey ? (await this.db.send(new GetCommand({
      TableName: reviewTable(), Key: pointerKey, ConsistentRead: true,
    }))).Item as { incidentId?: string } | undefined : undefined;
    // This method is the final transaction authority, not the classifier.
    // A caller MUST provide the complete exact recurring identity and its
    // Calendar iCalUID recurrence key before closure of a recurring decision.
    const recurring = current.decision?.type?.includes("recurrence_task_deleted") === true;
    const recordedMaster = current.decision?.masterEventId || current.decision?.mappingSnapshot?.masterEventId;
    const recordedActive = current.decision?.activeInstanceId || current.decision?.mappingSnapshot?.activeInstanceId;
    const seriesKeys = [...new Set(expected.seriesKeys || [...expected.taskIds, ...expected.eventIds])];
    if (!seriesKeys.length || seriesKeys.length > 20
      || [...expected.taskIds, ...expected.eventIds].some(id => !seriesKeys.includes(id))) return false;
    if (recurring && (!expected.masterId || !expected.activeInstanceId || !expected.masterSeriesId
      || recordedMaster !== expected.masterId || recordedActive !== expected.activeInstanceId
      || expected.masterId === expected.activeInstanceId
      || !expected.eventIds.includes(expected.masterId)
      || !expected.eventIds.includes(expected.activeInstanceId)
      || !seriesKeys.includes(expected.masterSeriesId)
      || !seriesKeys.includes(expected.masterId)
      || !seriesKeys.includes(expected.activeInstanceId)
      || current.decision?.seriesId && !seriesKeys.includes(current.decision.seriesId)
      || current.decision?.mappingSnapshot?.seriesId && !seriesKeys.includes(current.decision.mappingSnapshot.seriesId)))
      return false;
    const staleLinks = expected.staleLinks || [];
    const seenLinks = new Set<string>();
    for (const link of staleLinks) {
      const identity = `${link.profile}/${link.seriesId}`;
      if (seenLinks.has(identity) || link.profile !== expected.profile || link.owner !== "todoist"
        || link.seriesId !== link.taskId || !expected.taskIds.includes(link.taskId)
        || !expected.eventIds.includes(link.eventId)
        || !link.masterEventId || !expected.eventIds.includes(link.masterEventId)
        || !link.activeInstanceId || !expected.eventIds.includes(link.activeInstanceId)
        || link.activeInstanceId === link.masterEventId
        || recurring && (link.masterEventId !== expected.masterId
          || link.activeInstanceId !== expected.activeInstanceId)
        || !seriesKeys.includes(link.seriesId) || !link.updatedAt) return false;
      seenLinks.add(identity);
    }
    const now = new Date().toISOString();
    const resolution = "resolved_deleted: both provider objects verified absent; stale conflict retired";
    const items: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
      { Update: { TableName: reviewTable(), Key: key(`REVIEW_CASE#${caseId}`),
        UpdateExpression: "SET #status = :resolved, #result = :result, #title = :title, #reason = :reason, updatedAt = :now, expiresAt = :expiry REMOVE decision, taskId, eventId, sourceAuditKey, lookupPk, lookupSk, conflictKey, reconciliationGeneration, progressCheckpoint, coalescedInto",
        ConditionExpression: "#status = :old AND updatedAt = :version AND attribute_not_exists(operationId)",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#title": "title", "#reason": "reason" },
        ExpressionAttributeValues: { ":resolved": "resolved", ":result": resolution, ":title": "Verified deletion", ":reason": "verified_deletion",
          ":now": now, ":old": current.status, ":version": current.updatedAt,
          ":expiry": Math.floor(Date.now() / 1000) + 30 * 86400 },
      } },
    ];
    if (manual) items.push({ Update: { TableName: reviewTable(), Key: key(`MANUAL#${caseId}`),
      UpdateExpression: "SET #status = :resolved, resolution = :result, resolvedAt = :now REMOVE lookupPk, lookupSk, #context, taskId, eventId, masterEventId, activeInstanceId, seriesId, mappingSnapshot",
      ConditionExpression: "#status = :old AND profile = :profile AND decisionId = :id AND createdAt = :createdAt",
      ExpressionAttributeNames: { "#status": "status", "#context": "context" },
      ExpressionAttributeValues: { ":old": manual.status, ":resolved": "resolved", ":profile": expected.profile,
        ":id": caseId, ":createdAt": manual.createdAt, ":result": resolution, ":now": now },
    } });
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
    // Retire only canonical identity and reconciliation baseline snapshots
    // scoped to the fully absent provider IDs. Every delete is version-fenced:
    // a concurrent new provider identity or repair aborts the whole transaction
    // instead of stripping a newer baseline or live canonical pointer.
    const canonicalRefs = [
      ...expected.taskIds.map(id => ({ side: "todoist", id })),
      ...expected.eventIds.map(id => ({ side: "calendar", id })),
    ];
    for (const ref of canonicalRefs) {
      const pk = `CANONICAL#${expected.profile}#${ref.side}#${ref.id}`;
      const currentIdentity = await this.get<Record<string, unknown>>(pk);
      if (!currentIdentity) continue;
      if (currentIdentity.profile !== expected.profile || currentIdentity.side !== ref.side
        || currentIdentity.providerId !== ref.id
        || typeof currentIdentity.updatedAt !== "string" || !currentIdentity.identity) return false;
      items.push({ Delete: { TableName: reviewTable(), Key: key(pk),
        ConditionExpression: "#profile = :profile AND #side = :side AND providerId = :id AND updatedAt = :updated AND #identity = :identity",
        ExpressionAttributeNames: { "#profile": "profile", "#side": "side", "#identity": "identity" },
        ExpressionAttributeValues: { ":profile": expected.profile, ":side": ref.side, ":id": ref.id,
          ":updated": currentIdentity.updatedAt, ":identity": currentIdentity.identity },
      } });
    }
    for (const taskId of expected.taskIds) {
      const baselineKey = { pk: `BASELINE#${expected.profile}#TASK#${taskId}`, sk: "RECONCILE" };
      const currentBaseline = (await this.db.send(new GetCommand({
        TableName: reviewTable(), Key: baselineKey, ConsistentRead: true,
      }))).Item;
      if (!currentBaseline) continue;
      if (typeof currentBaseline.updatedAt !== "string" || !currentBaseline.baseline) return false;
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
    const referenceKeys = [
      ...expected.taskIds.map(id => `AUDIT_REF#${expected.profile}#todoist#${id}`),
      ...expected.eventIds.map(id => `AUDIT_REF#${expected.profile}#calendar#${id}`),
    ];
    const referencedAudits = new Map<string, Record<string, unknown>>();
    const auditPointers = new Map<string, { key: { pk: string; sk: string }; auditKey: string }>();
    for (const pk of referenceKeys) {
      const page = await this.db.send(new QueryCommand({ TableName: reviewTable(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "AUDIT#" },
        ConsistentRead: true, Limit: 50 }));
      if (page.LastEvaluatedKey) return false; // no partially attributed cleanup
      for (const row of page.Items || []) {
        if (typeof row.auditKey !== "string" || !row.auditKey.startsWith(`AUDIT#${expected.profile}#`)
          || typeof row.sk !== "string") continue;
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
        && identities.eventIds.every(id => expected.eventIds.includes(id))) safeAudits.add(auditKey);
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
    const profiles: Profile[] = ["home", "antonio", "work"];
    const absence = new Map<string, { pk: string; sk: string }>();
    const checkAbsent = (pk: string, sk = "MAP"): void => {
      absence.set(`${pk}|${sk}`, { pk, sk });
    };
    for (const taskId of expected.taskIds) {
      checkAbsent(`TASKOWNER#${taskId}`);
      for (const candidateProfile of profiles) {
        checkAbsent(`TASK#${candidateProfile}#${taskId}`);
        // Every recurrence identity is fenced together below, including
        // the Calendar iCalUID key rather than only task-ID keys.
      }
    }
    for (const eventId of expected.eventIds) {
      for (const candidateProfile of profiles) {
        checkAbsent(`EVENT#${candidateProfile}#${eventId}`);
        // Completed task/event projections remain untouched and are not
        // considered live ownership of a deleted recurrence.
      }
    }
    for (const seriesId of seriesKeys) for (const candidateProfile of profiles) {
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
    for (const ref of refs) {
      items.push({ ConditionCheck: { TableName: reviewTable(),
        Key: key(`SYNC_CONTROL#${expected.profile}:${ref.side}:${ref.id}`),
        ConditionExpression: "attribute_not_exists(activeRepair) AND (attribute_not_exists(excluded) OR excluded = :no)",
        ExpressionAttributeValues: { ":no": false },
      } });
    }
    if (items.length > 95) return false; // leave open for safe bounded retry
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (conditional(error) || (error as { name?: string }).name === "TransactionCanceledException") return false;
      throw error;
    }
  }

  async noteVerifiedDeletionCleanupDeferred(caseId: string, expectedUpdatedAt: string): Promise<void> {
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
          ":message": "deletion_cleanup_deferred: current provider, mapping or audit state changed; retry is required",
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

import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient as client } from "./dynamodb-capacity.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { Profile } from "./types.js";
import { retainedConflictIdentity } from "./audit-policy.js";
import { entityKey, operationHasWriteEvidence, type EntityRef, type RepairOperation, type RepairPreview, type RepairRelease, type ReviewActor, type ReviewCase, type ReviewSnapshot } from "./review-types.js";
export function reviewTable(): string { if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required"); return process.env.STATE_TABLE_NAME; }
export function reviewHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
const key = (pk: string) => ({ pk, sk: "STATE" });
const conditional = (e: unknown) => (e as { name?: string }).name === "ConditionalCheckFailedException";
const dismissalResolutions = new Set(["acknowledge","keep_separate","ignore","dismiss","dismissed"]);
export class ReviewStore {
  constructor(private readonly db: Pick<typeof client, "send"> = client) {}
  async get<T>(pk: string): Promise<T | undefined> {
    return (await this.db.send(new GetCommand({ TableName: reviewTable(), Key: key(pk), ConsistentRead: true }))).Item as T | undefined;
  }
  async observeDecision(decision: ManualDecision): Promise<void> {
    const id = decision.decisionId, existing = await this.getCase(id);
    const conflictKey = typeof decision.context?.conflictKey === "string" ? decision.context.conflictKey : undefined;
    if (existing) {
      if (existing.status === "open" && conflictKey && existing.conflictKey === conflictKey) {
        await this.coalesceConflictIncidents(existing.profile, conflictKey, id);
      }
      return;
    }
    const context = decision.context || {};
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
    const auditKey = typeof audit.pk === "string" ? audit.pk : `${profile}:${fingerprint}:${incidentId}`;
    const id = `incident-${reviewHash(auditKey).slice(0, 32)}`;
    const detail = audit.detail && typeof audit.detail === "object" ? audit.detail as Record<string, unknown> : {};
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
        if (identity && reviewHash(identity) === conflictKey) incidents.push(candidate);
      }
    }
    for (const candidate of incidents) {
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
  getCase(id: string): Promise<ReviewCase | undefined> { return this.get(`REVIEW_CASE#${id}`); }
  async listCases(profile: Profile, cursor?: Record<string, unknown>, history = false) {
    const result = await this.db.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)",
      ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": history ? "REVIEW#" : "REVIEW#OPEN#" }, Limit: 50,
      ExclusiveStartKey: cursor }));
    return { items: (result.Items || []) as ReviewCase[], cursor: result.LastEvaluatedKey };
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
  async updateCase(id: string, status: ReviewCase["status"], result: string, operationId?: string): Promise<void> {
    const current = await this.getCase(id); if (!current) throw new Error("Conflict no longer exists");
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
    await this.db.send(new PutCommand({ TableName: reviewTable(), Item: { ...preview, ...key(`REPAIR_PREVIEW#${preview.id}`) }, ConditionExpression: "attribute_not_exists(pk)" }));
  }
  getPreview(id: string): Promise<RepairPreview | undefined> { return this.get(`REPAIR_PREVIEW#${id}`); }
  getOperation(id: string): Promise<RepairOperation | undefined> { return this.get(`REPAIR#${id}`); }
  async submit(preview: RepairPreview, actor: ReviewActor, idempotencyKey: string): Promise<RepairOperation> {
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
    await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...key(`REJECTED_PAIR#${profile}#${taskId}#${eventId}`), operationId, createdAt: new Date().toISOString() } }));
  }
  async allow(profile: Profile, taskId: string, eventId: string): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await client.send(new DeleteCommand({ TableName: reviewTable(), Key: key(`REJECTED_PAIR#${profile}#${taskId}#${eventId}`) }));
  }
  async blocked(profile: Profile, ids: { taskId?: string; eventId?: string }, operationId?: string): Promise<boolean> {
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
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET excluded = :excluded",
      ConditionExpression: "activeRepair = :id", ExpressionAttributeValues: { ":excluded": excluded, ":id": operationId } }));
  }
  async release(ref: EntityRef, operationId: string, providerUpdatedAt?: string): Promise<void> {
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

import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient as client } from "./dynamodb-capacity.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { Profile } from "./types.js";
import { entityKey, type EntityRef, type RepairOperation, type RepairPreview, type RepairRelease, type ReviewActor, type ReviewCase } from "./review-types.js";
export function reviewTable(): string { if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required"); return process.env.STATE_TABLE_NAME; }
export function reviewHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
const key = (pk: string) => ({ pk, sk: "STATE" });
const conditional = (e: unknown) => (e as { name?: string }).name === "ConditionalCheckFailedException";
export class ReviewStore {
  async get<T>(pk: string): Promise<T | undefined> {
    return (await client.send(new GetCommand({ TableName: reviewTable(), Key: key(pk), ConsistentRead: true }))).Item as T | undefined;
  }
  async observeDecision(decision: ManualDecision): Promise<void> {
    const id = decision.decisionId, existing = await this.getCase(id);
    if (existing) return;
    const item: ReviewCase = {
      id, profile: decision.profile, title: decision.type.replaceAll("_", " "), reason: decision.sourceAuditAction || decision.type,
      status: decision.status === "resolved" ? "dismissed" : "open", decision, taskId: decision.taskId, eventId: decision.eventId,
      createdAt: decision.createdAt, updatedAt: new Date().toISOString(),
    };
    try { await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...item, ...key(`REVIEW_CASE#${id}`),
      lookupPk: `PROFILE#${item.profile}`, lookupSk: `REVIEW#${item.status === "dismissed" ? "CLOSED" : "OPEN"}#${item.createdAt}#${id}` }, ConditionExpression: "attribute_not_exists(pk)" })); }
    catch (e) { if (!conditional(e)) throw e; }
  }
  async observeConflictIncident(profile: Profile, fingerprint: string, incidentId: string, audit: Record<string, unknown>): Promise<void> {
    const auditKey = typeof audit.pk === "string" ? audit.pk : `${profile}:${fingerprint}:${incidentId}`;
    const id = `incident-${reviewHash(auditKey).slice(0, 32)}`;
    if (await this.getCase(id)) return;
    const detail = audit.detail && typeof audit.detail === "object" ? audit.detail as Record<string, unknown> : {};
    const action = typeof audit.action === "string" ? audit.action : "active conflict";
    const createdAt = typeof audit.createdAt === "string" ? audit.createdAt : new Date().toISOString();
    const item: ReviewCase = {
      id, profile, title: action.replaceAll("_", " "), reason: action,
      status: "open", taskId: typeof detail.taskId === "string" ? detail.taskId : undefined,
      eventId: typeof detail.eventId === "string" ? detail.eventId : undefined,
      createdAt, updatedAt: new Date().toISOString(),
    };
    try {
      await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...item, ...key(`REVIEW_CASE#${id}`), sourceAuditKey: auditKey,
        lookupPk: `PROFILE#${profile}`, lookupSk: `REVIEW#OPEN#${createdAt}#${id}` }, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) { if (!conditional(error)) throw error; }
  }
  getCase(id: string): Promise<ReviewCase | undefined> { return this.get(`REVIEW_CASE#${id}`); }
  async listCases(profile: Profile, cursor?: Record<string, unknown>, history = false) {
    const result = await client.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)",
      ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": history ? "REVIEW#" : "REVIEW#OPEN#" }, Limit: 50,
      ExclusiveStartKey: cursor }));
    return { items: (result.Items || []) as ReviewCase[], cursor: result.LastEvaluatedKey };
  }
  async updateCase(id: string, status: ReviewCase["status"], result: string, operationId?: string): Promise<void> {
    const current = await this.getCase(id); if (!current) throw new Error("Conflict no longer exists");
    const terminal = ["resolved", "excluded", "dismissed"].includes(status);
    const condition = status === "repairing"
      ? "#s = :open OR (#s = :repairing AND operationId = :op)"
      : status === "open"
        ? "#s = :repairing AND operationId = :op"
        : "#s = :current AND (attribute_not_exists(operationId) OR operationId = :op)";
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`REVIEW_CASE#${id}`),
      UpdateExpression: "SET #s = :s, #r = :r, updatedAt = :now, operationId = :op, lookupSk = :lookup",
      ConditionExpression: condition,
      ExpressionAttributeNames: { "#s": "status", "#r": "result" }, ExpressionAttributeValues: { ":s": status, ":r": result,
        ":now": new Date().toISOString(), ":op": operationId || "", ":current": current.status, ":open":"open", ":repairing":"repairing",
        ":lookup": `REVIEW#${terminal ? "CLOSED" : "OPEN"}#${current.createdAt}#${id}` } }));
  }
  async putPreview(preview: RepairPreview): Promise<void> {
    await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...preview, ...key(`REPAIR_PREVIEW#${preview.id}`) }, ConditionExpression: "attribute_not_exists(pk)" }));
  }
  getPreview(id: string): Promise<RepairPreview | undefined> { return this.get(`REPAIR_PREVIEW#${id}`); }
  getOperation(id: string): Promise<RepairOperation | undefined> { return this.get(`REPAIR#${id}`); }
  async submit(preview: RepairPreview, actor: ReviewActor, idempotencyKey: string): Promise<RepairOperation> {
    if (preview.actor.subject !== actor.subject || preview.expiresAt * 1000 <= Date.now()) throw new Error("Preview expired or belongs to another operator");
    const id = reviewHash([actor.subject, preview.id, idempotencyKey]).slice(0, 32);
    const old = await this.getOperation(id); if (old) return old;
    const operation: RepairOperation = { id, preview, actor, attempt: 1, status: "queued", steps: {}, notificationPending: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try { await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: reviewTable(), Key: key(`REPAIR_PREVIEW#${preview.id}`), UpdateExpression: "SET submittedOperation = :id",
        ConditionExpression: "attribute_not_exists(submittedOperation) OR submittedOperation = :id", ExpressionAttributeValues: { ":id": id } } },
      { Put: { TableName: reviewTable(), Item: { ...operation, ...key(`REPAIR#${id}`) }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] })); } catch (e) { const current = await this.getOperation(id); if (current) return current; throw e; }
    return operation;
  }
  async saveOperation(operation: RepairOperation): Promise<void> {
    operation.updatedAt = new Date().toISOString();
    await client.send(new PutCommand({ TableName: reviewTable(), Item: { ...operation, ...key(`REPAIR#${operation.id}`),
      lookupPk: `PROFILE#${operation.preview.intent.profile}`, lookupSk: `REPAIR#${operation.notificationPending ? "NOTIFY" : "HISTORY"}#${operation.id}` },
      ConditionExpression:operation.status === "succeeded" ? "#status = :succeeded" : "attribute_not_exists(pk) OR #status <> :succeeded",
      ExpressionAttributeNames:{"#status":"status"}, ExpressionAttributeValues:{":succeeded":"succeeded"} }));
  }
  async completeNotification(operationId: string, replyTs?: string): Promise<void> {
    await client.send(new UpdateCommand({ TableName:reviewTable(), Key:key(`REPAIR#${operationId}`),
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
      notificationPending:true, notificationText:"Succeeded: repair verified" };
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        ...[...new Map(releases.map(item => [entityKey(item.ref), item])).values()].map(item => ({ Update: {
          TableName:reviewTable(), Key:key(`SYNC_CONTROL#${entityKey(item.ref)}`),
          UpdateExpression:`SET fencedAt = :now, providerUpdatedAt = :version${item.clearExclusion ? ", excluded = :false" : ""} REMOVE activeRepair, pendingRefresh`,
          ConditionExpression:"activeRepair = :id", ExpressionAttributeValues:{ ":id":operation.id, ":now":now, ":version":item.providerUpdatedAt || "", ...(item.clearExclusion ? {":false":false} : {}) },
        } })),
        { Put:{ TableName:reviewTable(), Item:{ ...completed, ...key(`REPAIR#${operation.id}`),
          lookupPk:`PROFILE#${operation.preview.intent.profile}`, lookupSk:`REPAIR#NOTIFY#${operation.id}` },
          ConditionExpression:"#status <> :succeeded", ExpressionAttributeNames:{"#status":"status"}, ExpressionAttributeValues:{":succeeded":"succeeded"} } },
        { Update:{ TableName:reviewTable(), Key:key(`REVIEW_CASE#${current.id}`),
          UpdateExpression:"SET #status = :status, #result = :result, updatedAt = :now, operationId = :id, lookupSk = :lookup",
          ExpressionAttributeNames:{"#status":"status","#result":"result"}, ExpressionAttributeValues:{
            ":status":operation.preview.intent.action === "exclude" ? "excluded" : "resolved", ":result":"Repair verified against current provider state",
            ":now":now, ":id":operation.id, ":lookup":`REVIEW#CLOSED#${current.createdAt}#${current.id}`,
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
    do { const page = await client.send(new QueryCommand({ TableName: reviewTable(), IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :pk AND begins_with(lookupSk, :prefix)", ExpressionAttributeValues: { ":pk": `PROFILE#${profile}`, ":prefix": "REPAIR#NOTIFY#" }, ExclusiveStartKey: cursor }));
      items.push(...(page.Items || []) as RepairOperation[]); cursor = page.LastEvaluatedKey;
    } while (cursor); return items;
  }
}
export interface SyncControl { excluded?: boolean; activeRepair?: string; pendingRefresh?: boolean; fencedAt?: string; providerUpdatedAt?: string }
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
        await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET pendingRefresh = :true", ExpressionAttributeValues: { ":true": true } }));
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
  async exclude(ref: EntityRef, excluded: boolean, operationId: string): Promise<void> {
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`), UpdateExpression: "SET excluded = :excluded",
      ConditionExpression: "activeRepair = :id", ExpressionAttributeValues: { ":excluded": excluded, ":id": operationId } }));
  }
  async release(ref: EntityRef, operationId: string, providerUpdatedAt?: string): Promise<void> {
    await client.send(new UpdateCommand({ TableName: reviewTable(), Key: key(`SYNC_CONTROL#${entityKey(ref)}`),
      UpdateExpression: "SET fencedAt = :now, providerUpdatedAt = :version REMOVE activeRepair, pendingRefresh",
      ConditionExpression: "activeRepair = :id", ExpressionAttributeValues: { ":id": operationId, ":now": new Date().toISOString(), ":version": providerUpdatedAt || "" } }));
  }
}
export const newPreviewId = () => randomUUID();

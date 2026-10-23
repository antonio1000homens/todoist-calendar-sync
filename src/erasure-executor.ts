/** Reusable lifecycle and durable async contract for per-item erasure jobs. */
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

export type ErasureOperationStatus = "previewed" | "queued" | "fencing" | "deleting" | "verifying" | "succeeded" | "partial_failure";
export interface ErasureOperation {
  operationId: string;
  profile: Profile;
  target: { taskId: string; eventId?: string; deleteCalendar: boolean };
  previewFingerprint: string;
  confirmationFingerprint: string;
  confirmationId: string;
  selectedActions: { deleteTodoist: boolean; deleteCalendar: boolean };
  inventory: Array<{ type: string; key: { pk: string; sk: string }; digest: string; classification: string }>;
  status: ErasureOperationStatus;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  result?: Record<string, unknown>;
  error?: string;
}

const transitions: Record<ErasureOperationStatus, ErasureOperationStatus[]> = {
  previewed: ["queued"], queued: ["fencing", "partial_failure"], fencing: ["deleting", "partial_failure"],
  deleting: ["verifying", "partial_failure"], verifying: ["succeeded", "partial_failure"],
  succeeded: [], partial_failure: ["queued"],
};

export function advanceErasureOperation(current: ErasureOperation, status: ErasureOperationStatus,
  patch: Partial<Pick<ErasureOperation, "result" | "error" | "requestId">> = {}, now = new Date().toISOString()): ErasureOperation {
  if (!transitions[current.status].includes(status)) throw new Error(`Invalid erasure operation transition ${current.status} -> ${status}`);
  return { ...current, ...patch, status, updatedAt: now };
}

function operationKey(id: string) { return { pk: `ERASURE_OPERATION#${id}`, sk: "STATE" }; }
function confirmationKey(operationId: string) { return { pk: `ERASURE_CONFIRMATION#${operationId}`, sk: "STATE" }; }
type ErasurePreview = Pick<ErasureOperation, "operationId" | "profile" | "target" | "selectedActions" | "inventory">;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function erasurePreviewFingerprint(preview: Omit<ErasurePreview, "operationId">): string {
  const content={version:1,profile:preview.profile,target:preview.target,selectedActions:preview.selectedActions,inventory:preview.inventory};
  return createHash("sha256").update(canonical(content)).digest("hex");
}
function stateTable(): string {
  const value = process.env.STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}

/** Exact preview is immutable after submission; workers use conditional status changes. */
export class ErasureOperationStore {
  constructor(private readonly db = documentClient, private readonly newConfirmationId = randomUUID) {}

  async issueConfirmation(preview: ErasurePreview, now = Date.now(), lifetimeMs = 5 * 60_000): Promise<{
    confirmationId: string; previewFingerprint: string; expiresAt: number;
  }> {
    if (!preview.operationId || preview.selectedActions.deleteTodoist !== true
      || preview.selectedActions.deleteCalendar !== preview.target.deleteCalendar
      || (preview.target.deleteCalendar && !preview.target.eventId)) throw new Error("Invalid erasure operation preview");
    const confirmationId=this.newConfirmationId();
    const previewFingerprint=erasurePreviewFingerprint(preview);
    const expiresAt=now+lifetimeMs;
    await this.db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:stateTable(),Item:{
      ...confirmationKey(preview.operationId),operationId:preview.operationId,confirmationId,previewFingerprint,
      status:"issued",expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk)"}}]}));
    return {confirmationId,previewFingerprint,expiresAt};
  }

  async create(operation: ErasureOperation, now = Date.now()): Promise<void> {
    if (operation.status !== "previewed" || !operation.operationId || !operation.previewFingerprint
      || operation.confirmationFingerprint !== operation.previewFingerprint
      || operation.selectedActions.deleteTodoist !== true
      || operation.selectedActions.deleteCalendar !== operation.target.deleteCalendar
      || (operation.target.deleteCalendar && !operation.target.eventId)
      || operation.previewFingerprint !== erasurePreviewFingerprint(operation)) throw new Error("Invalid erasure operation preview");
    await this.db.send(new TransactWriteCommand({TransactItems:[
      {Put:{TableName:stateTable(),Item:{...operation,...operationKey(operation.operationId)},ConditionExpression:"attribute_not_exists(pk)"}},
      {Update:{TableName:stateTable(),Key:confirmationKey(operation.operationId),
        UpdateExpression:"SET #status=:consumed, consumedAt=:now, consumedBy=:operationId",
        ConditionExpression:"#status=:issued AND confirmationId=:confirmationId AND previewFingerprint=:fingerprint AND expiresAt>:now",
        ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":issued":"issued",":consumed":"consumed",
          ":confirmationId":operation.confirmationId,":fingerprint":operation.previewFingerprint,":operationId":operation.operationId,":now":now}}},
    ]}));
  }

  async get(id: string): Promise<ErasureOperation | undefined> {
    const result=await this.db.send(new GetCommand({TableName:stateTable(),Key:operationKey(id),ConsistentRead:true}));
    return result.Item as ErasureOperation|undefined;
  }

  async transition(id: string, expected: ErasureOperationStatus, next: ErasureOperationStatus,
    patch: Partial<Pick<ErasureOperation,"requestId"|"result"|"error">> = {}): Promise<void> {
    const current=await this.get(id);
    if(!current||current.status!==expected) throw new Error("Erasure operation state changed; refresh before continuing");
    const updated=advanceErasureOperation(current,next,patch);
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:next, updatedAt=:updatedAt"+(patch.error!==undefined?", error=:error":"")
        +(patch.result!==undefined?", #result=:result":"")+(patch.requestId!==undefined?", requestId=:requestId":""),
      ConditionExpression:"#status=:expected AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status",...(patch.result!==undefined?{"#result":"result"}:{})},
      ExpressionAttributeValues:{":expected":expected,":next":next,":updatedAt":updated.updatedAt,":fingerprint":current.previewFingerprint,
        ...(patch.error!==undefined?{":error":patch.error}:{}),...(patch.result!==undefined?{":result":patch.result}:{}),
        ...(patch.requestId!==undefined?{":requestId":patch.requestId}:{})}}));
  }
}

export async function enterFencedErasure(input: {
  profile: string; operationId: string; mappings: unknown[]; timeoutSeconds: number;
  disableMappings(mappings: unknown[]): Promise<void>;
  waitForLeaseDrain(): Promise<void>;
  beginFence(profile: string, operationId: string): Promise<void>;
  pause(ms: number): Promise<void>;
}): Promise<void> {
  await input.disableMappings(input.mappings);
  await input.waitForLeaseDrain();
  await input.beginFence(input.profile, input.operationId);
  await input.pause(input.timeoutSeconds * 1000 + 2000);
  await input.waitForLeaseDrain();
}

export async function finishFencedErasure(input: {
  enabledMappingIds: string[];
  restoreMappings(ids: string[]): Promise<void>;
  finishFence(): Promise<void>;
}): Promise<void> {
  // Keep the fence and journal until the original event sources are verified restored.
  await input.restoreMappings(input.enabledMappingIds);
  await input.finishFence();
}

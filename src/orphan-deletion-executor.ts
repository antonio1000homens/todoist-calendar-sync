/**
 * #287: durable, provider-singleton orphan deletion state machine.
 *
 * This core has no HTTP or SQS entrypoint. It must not be wired to production
 * until the trusted proof inventory, worker drain, replay barrier and lifecycle
 * adapters have passed destructive E2E acceptance. Never reuse the generic
 * task-first erasure endpoint for Calendar-only orphan deletion.
 */
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { reviewHash } from "./review-store.js";
import type { Profile, TodoistTask, CalendarEvent } from "./types.js";
import type { Side } from "./review-types.js";

export const ORPHAN_REQUIRED_CHECKS = [
  "case_open_unchanged",
  "exact_target_live",
  "all_recorded_counterparts_absent",
  "complete_provider_enumeration",
  "no_reverse_provider_links",
  "cross_profile_mapping_indexes_clear",
  "canonical_records_clear",
  "recurrence_ownership_clear",
  "completed_history_safe",
  "project_and_task_comments_clear",
  "sync_controls_clear",
  "no_active_repair_or_erasure",
  "scope_standalone",
] as const;
export type OrphanProofCheck = typeof ORPHAN_REQUIRED_CHECKS[number];
export type OrphanPhase = "confirmed" | "fenced" | "delete_started" | "provider_absent"
  | "state_cleaned" | "workers_resume_started" | "observing" | "succeeded" | "needs_review";
export type ProviderTarget = { side: "todoist"; item: TodoistTask } | { side: "calendar"; item: CalendarEvent };
export interface VerifiedOrphanProof {
  caseId: string;
  profile: Profile;
  caseUpdatedAt: string;
  side: Side;
  targetId: string;
  checkedAt: string;
  /** Every check must be supplied by a trusted, complete server-side reader. */
  checks: Record<OrphanProofCheck, boolean>;
  blockers: string[];
  /** Digest of the provider target, not a title or a cached UI snapshot. */
  providerDigest: string;
  /** Mandatory for Calendar deletion; checks must also reject recurrence. */
  providerEtag?: string;
}
export interface OrphanDeletionOperation {
  id: string;
  caseId: string;
  profile: Profile;
  caseUpdatedAt: string;
  side: Side;
  targetId: string;
  providerDigest: string;
  providerEtag?: string;
  /** An authenticated confirmation belongs to this exact provider object. */
  actorSubject: string;
  confirmedAt: string;
  confirmationExpiresAt: string;
  phase: OrphanPhase;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastCheckpoint?: string;
  lastError?: string;
}
export interface OrphanJournal {
  get(id: string): Promise<OrphanDeletionOperation | undefined>;
  create(operation: OrphanDeletionOperation): Promise<void>;
  advance(operation: OrphanDeletionOperation, to: OrphanPhase, checkpoint: string): Promise<OrphanDeletionOperation>;
  /** Mark ambiguous errors for operator-led recovery, never auto-release a fence. */
  requireReview(operation: OrphanDeletionOperation, reason: string): Promise<OrphanDeletionOperation>;
}
export interface GuardedOrphanAdapters {
  /** Trusted independent proof; never accept a proof object from the browser. */
  verifyProof(operation: OrphanDeletionOperation): Promise<VerifiedOrphanProof>;
  /** Disable all affected worker mappings, drain in-flight work, acquire
   * profile fence and confirm no admission/writer leases; idempotent. */
  establishQuiescence(operation: OrphanDeletionOperation): Promise<void>;
  /** Every external operation must recheck the same fence and drained workers. */
  assertQuiescent(operation: OrphanDeletionOperation): Promise<void>;
  /** Persist a replay/reconciliation suppression guard BEFORE provider write. */
  installReplayBarrier(operation: OrphanDeletionOperation): Promise<void>;
  assertReplayBarrier(operation: OrphanDeletionOperation): Promise<void>;
  /** Fresh direct provider read: throw on 429/403/5xx and ambiguous 404.
   * Return null only on independently verified absence/cancelled state. */
  readTarget(operation: OrphanDeletionOperation): Promise<ProviderTarget | null>;
  /** Exactly one provider DELETE. No linked-pair cascading. Calendar must
   * use If-Match / expected ETag; Todoist requires fenced digest recheck. */
  deleteTodoist(taskId: string): Promise<void>;
  deleteCalendar(eventId: string, etag: string): Promise<void>;
  /** Attributable conditional DynamoDB cleanup; no history or shared rows. */
  cleanupOwnedState(operation: OrphanDeletionOperation): Promise<void>;
  /** Must independently prove the target absent, no dangling state, and no
   * re-created counterpart. Failure must retain fence/barrier and journal. */
  verifyPostflight(operation: OrphanDeletionOperation): Promise<void>;
  /** Resume workers only AFTER the replay barrier is durable; keep barrier. */
  resumeWorkersWithBarrier(operation: OrphanDeletionOperation): Promise<void>;
  /** Requires two distinct completed full reconciliation generations AND
   * both webhook replay cases, no recreate, no reopened review alert. */
  verifyTwoPassesAndReplay(operation: OrphanDeletionOperation): Promise<void>;
  /** Conditional case-version and ownership CAS: write orphan_removed only
   * after independent postflight and replay checks. */
  retireCaseAsOrphanRemoved(operation: OrphanDeletionOperation): Promise<void>;
}
export class OrphanSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanSafetyError";
  }
}
const knownPhases: ReadonlySet<string> = new Set([
  "confirmed","fenced","delete_started","provider_absent","state_cleaned","workers_resume_started","observing","succeeded","needs_review",
]);
const graph: Record<Exclude<OrphanPhase,"succeeded"|"needs_review">,OrphanPhase> = {
  confirmed:"fenced",
  fenced:"delete_started",
  delete_started:"provider_absent",
  provider_absent:"state_cleaned",
  state_cleaned:"workers_resume_started",
  workers_resume_started:"observing",
  observing:"succeeded",
};
const validId = (id: unknown): id is string => typeof id === "string" && !!id && id.length <= 1024
  && !/[\u0000-\u001f]/.test(id);
function assertIdentity(operation: OrphanDeletionOperation): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operation.id) || !validId(operation.caseId)
    || !["home","antonio","work"].includes(operation.profile)
    || !["todoist","calendar"].includes(operation.side) || !validId(operation.targetId)
    || !validId(operation.actorSubject) || !validId(operation.caseUpdatedAt)
    || !/^[a-f0-9]{64}$/.test(operation.providerDigest)
    || operation.side === "calendar" && !validId(operation.providerEtag)
    || !Number.isInteger(operation.version) || operation.version < 0
    || !knownPhases.has(operation.phase)) throw new OrphanSafetyError("Incomplete immutable orphan operation identity");
}
export function assertTrustedProof(operation: OrphanDeletionOperation, proof: VerifiedOrphanProof): void {
  const age=Date.now()-Date.parse(proof.checkedAt);
  if (proof.caseId!==operation.caseId || proof.profile!==operation.profile
    || proof.caseUpdatedAt!==operation.caseUpdatedAt
    || proof.side!==operation.side || proof.targetId!==operation.targetId
    || proof.providerDigest!==operation.providerDigest
    || proof.providerEtag!==operation.providerEtag
    || !Number.isFinite(age) || age < -10_000 || age > 120_000
    || !Array.isArray(proof.blockers) || proof.blockers.length
    || !proof.checks || ORPHAN_REQUIRED_CHECKS.some(check=>proof.checks[check]!==true))
    throw new OrphanSafetyError("Current direct-provider/ownership proof is incomplete, blocked or changed");
}
function assertLiveTarget(operation: OrphanDeletionOperation, target: ProviderTarget | null): void {
  if (!target || target.side!==operation.side || target.item.id!==operation.targetId
    || reviewHash(target.item)!==operation.providerDigest)
    throw new OrphanSafetyError("Exact provider target disappeared, changed or is not verified live");
  if (target.side==="calendar") {
    if (target.item.status!=="confirmed" || !target.item.etag
      || target.item.etag!==operation.providerEtag
      || target.item.recurringEventId || target.item.recurrence?.length)
      throw new OrphanSafetyError("Calendar ETag, live state or standalone scope changed");
    if (target.item.extendedProperties?.shared?.taskId)
      throw new OrphanSafetyError("Calendar target has a linked task");
  } else if (target.item.is_completed!==false || target.item.is_deleted!==false
    || target.item.due?.is_recurring===true)
    throw new OrphanSafetyError("Todoist item is not an active standalone task");
}
function assertionEnabled(): void {
  // Two independent opt-ins; neither can be set by a user HTTP payload.
  if (process.env.ORPHAN_DELETION_EXECUTION_ENABLED!=="true" || process.env.ERASURE_PROTOCOL_VERSION!=="1")
    throw new OrphanSafetyError("Orphan execution is disabled by deployment configuration");
}
function deadlineValid(operation: OrphanDeletionOperation): boolean {
  const expiry=Date.parse(operation.confirmationExpiresAt);
  const confirmed=Date.parse(operation.confirmedAt);
  return Number.isFinite(expiry) && Number.isFinite(confirmed)
    && expiry > confirmed && expiry-confirmed <= 5*60_000
    && Date.now()<=expiry;
}
export function validateOrphanConfirmation(input: {
  operation: OrphanDeletionOperation; actorSubject: string; exactId: string; phrase: string;
}): void {
  assertIdentity(input.operation);
  if (input.operation.phase!=="confirmed" || input.actorSubject!==input.operation.actorSubject
    || input.exactId!==input.operation.targetId
    || input.phrase!=="PERMANENTLY ERASE" || !deadlineValid(input.operation))
    throw new OrphanSafetyError("Expired, mismatched or incomplete exact-target confirmation");
}

/** A single idempotent step, never a loop through all destructive stages.
 * Journal transition to delete_started MUST commit before a provider DELETE. */
export async function advanceGuardedOrphanDeletion(
  id: string, journal: OrphanJournal, adapters: GuardedOrphanAdapters,
): Promise<OrphanDeletionOperation> {
  assertionEnabled();
  const operation=await journal.get(id);
  if(!operation || operation.id!==id) throw new OrphanSafetyError("Orphan operation was not found");
  assertIdentity(operation);
  if(operation.phase==="succeeded"||operation.phase==="needs_review") return operation;
  if(operation.phase==="confirmed") {
    if(!deadlineValid(operation)) throw new OrphanSafetyError("Deletion confirmation expired before worker fencing");
    assertTrustedProof(operation,await adapters.verifyProof(operation));
    await adapters.establishQuiescence(operation);
    await adapters.assertQuiescent(operation);
    return journal.advance(operation,"fenced","workers_drained_fence_verified");
  }
  // Reconciliation observation runs after the exclusive fence is released.
  if(operation.phase!=="observing" && operation.phase!=="workers_resume_started") await adapters.assertQuiescent(operation);
  if(operation.phase==="fenced") {
    assertTrustedProof(operation,await adapters.verifyProof(operation));
    assertLiveTarget(operation,await adapters.readTarget(operation));
    await adapters.installReplayBarrier(operation);
    await adapters.assertReplayBarrier(operation);
    // The durable checkpoint is written BEFORE invoking a provider DELETE.
    return journal.advance(operation,"delete_started","replay_barrier_installed_delete_intent_persisted");
  }
  await adapters.assertReplayBarrier(operation);
  if(operation.phase==="delete_started") {
    const target=await adapters.readTarget(operation);
    if(target) {
      assertTrustedProof(operation,await adapters.verifyProof(operation));
      assertLiveTarget(operation,target);
      if(operation.side==="todoist") await adapters.deleteTodoist(operation.targetId);
      else await adapters.deleteCalendar(operation.targetId,operation.providerEtag!);
    }
    // On a retry after an ambiguous network timeout, a missing target is
    // accepted ONLY after the durable delete_started checkpoint and direct
    // readback. Never repeat a DELETE blindly.
    if(await adapters.readTarget(operation)!==null)
      throw new OrphanSafetyError("Target remains live or provider readback could not verify deletion");
    return journal.advance(operation,"provider_absent","single_provider_delete_readback_verified");
  }
  if(operation.phase==="provider_absent") {
    if(await adapters.readTarget(operation)!==null)
      throw new OrphanSafetyError("Previously deleted target reappeared before conditional cleanup");
    await adapters.cleanupOwnedState(operation);
    await adapters.verifyPostflight(operation);
    return journal.advance(operation,"state_cleaned","conditional_state_cleanup_postflight_verified");
  }
  if(operation.phase==="state_cleaned") {
    await adapters.verifyPostflight(operation);
    await adapters.assertReplayBarrier(operation);
    // Durable before resuming: a retry cannot assume the exclusive fence is
    // still held if the external resume succeeded but our CAS acknowledgement failed.
    return journal.advance(operation,"workers_resume_started","replay_barrier_verified_before_worker_resume");
  }
  if(operation.phase==="workers_resume_started") {
    await adapters.assertReplayBarrier(operation);
    await adapters.resumeWorkersWithBarrier(operation);
    return journal.advance(operation,"observing","workers_resumed_with_replay_barrier");
  }
  if(operation.phase==="observing") {
    // Workers must be live for full reconciliation; the replay barrier must
    // remain valid, but the original exclusive fence has been relinquished.
    await adapters.assertReplayBarrier(operation);
    await adapters.verifyTwoPassesAndReplay(operation);
    await adapters.verifyPostflight(operation);
    await adapters.retireCaseAsOrphanRemoved(operation);
    return journal.advance(operation,"succeeded","orphan_removed_after_two_passes_and_webhook_replay");
  }
  throw new OrphanSafetyError("Unsupported guarded orphan lifecycle phase");
}

function tableName(): string {
  const table=process.env.STATE_TABLE_NAME?.trim();
  if(!table) throw new Error("STATE_TABLE_NAME is required");
  return table;
}
const key=(id:string)=>({pk:"ORPHAN_DELETE#"+id,sk:"STATE"});
/** All writes use strongly consistent reads + conditional state/version CAS.
 * No mutation can retarget an existing journal to another case or provider ID. */
export class DynamoOrphanJournal implements OrphanJournal {
  constructor(private readonly db:Pick<DynamoDBDocumentClient,"send">=documentClient) {}
  async get(id:string):Promise<OrphanDeletionOperation|undefined> {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new OrphanSafetyError("Invalid operation ID");
    const result=await this.db.send(new GetCommand({
      TableName:tableName(),Key:key(id),ConsistentRead:true,
    }));
    return result.Item as OrphanDeletionOperation|undefined;
  }
  async create(operation:OrphanDeletionOperation):Promise<void> {
    assertIdentity(operation);
    if(operation.phase!=="confirmed" || operation.version!==0 || !deadlineValid(operation))
      throw new OrphanSafetyError("Only a fresh confirmed singleton may be recorded");
    await this.db.send(new PutCommand({TableName:tableName(),
      Item:{...operation,...key(operation.id)},
      ConditionExpression:"attribute_not_exists(pk)",
    }));
  }
  async advance(operation:OrphanDeletionOperation,to:OrphanPhase,checkpoint:string):Promise<OrphanDeletionOperation> {
    assertIdentity(operation);
    if(graph[operation.phase as keyof typeof graph]!==to || !checkpoint || checkpoint.length>256)
      throw new OrphanSafetyError("Invalid guarded orphan transition");
    return this.write(operation,to,checkpoint);
  }
  async requireReview(operation:OrphanDeletionOperation,reason:string):Promise<OrphanDeletionOperation> {
    assertIdentity(operation);
    if(operation.phase==="succeeded"||operation.phase==="needs_review"||!reason)
      throw new OrphanSafetyError("Terminal orphan operation cannot be changed");
    return this.write(operation,"needs_review","operator_attention_required",reason.slice(0,512));
  }
  private async write(operation:OrphanDeletionOperation,to:OrphanPhase,checkpoint:string,lastError?:string):Promise<OrphanDeletionOperation> {
    const now=new Date().toISOString();
    const next={...operation,phase:to,version:operation.version+1,updatedAt:now,
      lastCheckpoint:checkpoint,...(lastError?{lastError}:{})};
    // Attribute aliases avoid reserved-word errors (e.g. version/status).
    const names:Record<string,string>={"#phase":"phase","#version":"version","#updated":"updatedAt",
      "#checkpoint":"lastCheckpoint","#profile":"profile","#case":"caseId",
      "#side":"side","#target":"targetId","#caseVersion":"caseUpdatedAt",
      "#digest":"providerDigest","#actor":"actorSubject","#etag":"providerEtag"};
    const values:Record<string,unknown>={":old":operation.phase,":oldVersion":operation.version,
      ":new":to,":newVersion":next.version,":updated":now,":checkpoint":checkpoint,
      ":profile":operation.profile,":case":operation.caseId,":side":operation.side,":target":operation.targetId,
      ":caseVersion":operation.caseUpdatedAt,":digest":operation.providerDigest,":actor":operation.actorSubject};
    if(operation.side==="calendar")values[":etag"]=operation.providerEtag!;
    if(lastError){names["#error"]="lastError";values[":error"]=lastError;}
    await this.db.send(new UpdateCommand({TableName:tableName(),Key:key(operation.id),
      UpdateExpression:"SET #phase = :new, #version = :newVersion, #updated = :updated, #checkpoint = :checkpoint"
        +(lastError?", #error = :error":""),
      ConditionExpression:"#phase = :old AND #version = :oldVersion AND #profile = :profile AND #case = :case"
        +" AND #side = :side AND #target = :target AND #caseVersion = :caseVersion"
        +" AND #digest = :digest AND #actor = :actor"
        +(operation.side==="calendar"?" AND #etag = :etag":" AND attribute_not_exists(#etag)"),
      ExpressionAttributeNames:names,ExpressionAttributeValues:values,
    }));
    return next;
  }
}

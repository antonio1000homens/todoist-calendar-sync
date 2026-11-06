/**
 * #351, phase 2: an exact, read-only, whole-series retirement effect preview.
 *
 * This is deliberately NOT an Apply authorisation. The transaction/receipt,
 * replay exclusion and verified Undo work must exist before issuing one.
 */
import { reviewHash } from "./review-store.js";
import { inspectRecurrenceRetirement, type InventoryRow,
  type RecurrenceRetirementInspection, type RetirementDiagnosticTarget,
  type RetirementInspectionDependencies } from "./recurrence-retirement-inspection.js";
import { retainedAuditProviderIds } from "./audit-policy.js";

export type RetirementRecord = {
  pk: string;
  sk: string;
  recordFingerprint: string;
  rationale: string;
};
export type RetirementPreview = {
  target: RetirementDiagnosticTarget;
  scope: "whole_ended_calendar_series";
  mode: "keep_provider_items";
  inspectedAt: string;
  inspectionFingerprint: string;
  planFingerprint: string;
  status: "blocked" | "reviewable";
  blockers: string[];
  /** Candidate records, not writes. Future Apply must recheck every full revision. */
  indexRemovalCandidates: RetirementRecord[];
  conditionalCleanupCandidates: RetirementRecord[];
  incidentEvidenceForSeparateReview: RetirementRecord[];
  protectedRecords: RetirementRecord[];
  futureSuppressionIdentityKeys: string[];
  providerMetadataHazards: string[];
  providerWrites: false;
  stateWrites: false;
  applyAvailable: false;
};

function record(row: InventoryRow, rationale: string): RetirementRecord {
  return {
    pk: String(row.pk), sk: String(row.sk),
    recordFingerprint: reviewHash(row), rationale,
  };
}
function stable(rows: RetirementRecord[]): RetirementRecord[] {
  return rows.sort((a,b)=>a.pk.localeCompare(b.pk)
    || a.sk.localeCompare(b.sk)
    || a.recordFingerprint.localeCompare(b.recordFingerprint));
}
function exactReference(row: unknown, identities: ReadonlySet<string>, depth = 0): boolean {
  if (typeof row === "string") return identities.has(row);
  if (!row || typeof row !== "object" || depth > 6) return false;
  return Object.values(row).some(value=>exactReference(value,identities,depth+1));
}
function belongsToTargetAudit(row: InventoryRow, inspection: RecurrenceRetirementInspection,
  ids: ReadonlySet<string>): boolean {
  const detail = row.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  const fields = detail as Record<string,unknown>;
  const refs = retainedAuditProviderIds(fields);
  if (!refs.taskIds.includes(inspection.target.taskId) && !refs.eventIds.includes(inspection.target.eventId))
    return false;
  return [...refs.taskIds,...refs.eventIds].every(id=>ids.has(id));
}

/**
 * Classifies exact state records without mutating them. Unknown or shared
 * evidence is preserved; old incident/audit pointers are NEVER silently
 * scheduled for deletion based on just matching an ID somewhere in the row.
 */
export function planRecurrenceRetirement(
  inspection: RecurrenceRetirementInspection, inventory: readonly InventoryRow[],
): RetirementPreview {
  const {target,mapping,recurrenceLink:link} = inspection;
  const identities=new Set([
    target.taskId,target.eventId,target.seriesId,
    mapping?.masterEventId,mapping?.activeInstanceId,
  ].filter((id):id is string=>Boolean(id)));
  const expected=new Map<string,string>([
    ["TASK#"+target.profile+"#"+target.taskId,"MAP"],
    ["TASKOWNER#"+target.taskId,"MAP"],
    ["EVENT#"+target.profile+"#"+target.eventId,"MAP"],
    ["RECURRENCE#"+target.profile+"#"+target.seriesId,"STATE"],
  ]);
  const canonicalKeys=new Map<string,{side:string;providerId:string}>([
    ["CANONICAL#"+target.profile+"#todoist#"+target.taskId,{side:"todoist",providerId:target.taskId}],
    ["CANONICAL#"+target.profile+"#calendar#"+target.eventId,{side:"calendar",providerId:target.eventId}],
  ]);
  const comparable = (value: Record<string,unknown>): Record<string,unknown> =>
    Object.fromEntries(Object.entries(value).filter(([name]) =>
      !["pk","sk","lookupPk","lookupSk"].includes(name)));
  const baselineKey="BASELINE#"+target.profile+"#TASK#"+target.taskId;
  const controls=[
    "SYNC_CONTROL#"+target.profile+":todoist:"+target.taskId,
    ...[target.eventId,mapping?.masterEventId,mapping?.activeInstanceId]
      .filter((id):id is string=>Boolean(id))
      .map(id=>"SYNC_CONTROL#"+target.profile+":calendar:"+id),
  ];
  const suppression=[
    "RETIREMENT#"+target.profile+"#TASK#"+target.taskId,
    "RETIREMENT#"+target.profile+"#SERIES#"+target.seriesId,
    ...[target.eventId,mapping?.masterEventId,mapping?.activeInstanceId]
      .filter((id):id is string=>Boolean(id))
      .map(id=>"RETIREMENT#"+target.profile+"#EVENT#"+id),
  ];
  const blockers=inspection.blockers.slice();
  const indexRemovalCandidates: RetirementRecord[]=[];
  const conditionalCleanupCandidates: RetirementRecord[]=[];
  const incidentEvidenceForSeparateReview: RetirementRecord[]=[];
  const protectedRecords: RetirementRecord[]=[];
  const seen=new Set<string>();
  for(const row of inventory){
    if(typeof row.pk!=="string" || typeof row.sk!=="string") {
      blockers.push("State inventory contains a row without both DynamoDB keys");
      continue;
    }
    // Pending approval/operation receipts are protected outside this plan.
    // Including them in planFingerprint would make every issued token stale
    // immediately after the approval Put, so they are never cleanup targets.
    if(row.pk.startsWith("RETIREMENT_OPERATION#"))continue;
    const rowKey=row.pk+"|"+row.sk;
    if(seen.has(rowKey)) {
      blockers.push("State inventory returned duplicate keys: "+row.pk);
      continue;
    }
    seen.add(rowKey);
    if(expected.has(row.pk)){
      if(expected.get(row.pk)!==row.sk)
        blockers.push("Unexpected index sort key for "+row.pk);
      else {
        // The inventory may have changed between the strongly consistent Get
        // operations and the complete scan. Both must agree on full revision.
        const expectedPayload=row.pk.startsWith("RECURRENCE#") ? link : mapping;
        if(!expectedPayload || reviewHash(comparable(row))
          !==reviewHash(comparable(expectedPayload as unknown as Record<string,unknown>)))
          blockers.push("Indexed mapping/link changed between direct read and state inventory: "+row.pk);
        else indexRemovalCandidates.push(record(row,
          "Whole-series mapping/link: future Apply must conditionally remove this exact revision"));
      }
      continue;
    }
    if(row.pk===baselineKey && row.sk!=="RECONCILE") {
      blockers.push("Unexpected reconciliation baseline sort key: "+row.pk);
      continue;
    }
    if(row.pk===baselineKey && row.sk==="RECONCILE"){
      if(!row.baseline || typeof row.updatedAt!=="string")
        blockers.push("Task baseline has no verified snapshot/version");
      else conditionalCleanupCandidates.push(record(row,
        "Task-specific reconciliation baseline; delete only if the same snapshot still exists"));
      continue;
    }
    const canonical=canonicalKeys.get(row.pk);
    if(canonical && row.sk!=="STATE") {
      blockers.push("Unexpected canonical identity sort key: "+row.pk);
      continue;
    }
    if(canonical && row.sk==="STATE"){
      if(row.profile!==target.profile || row.side!==canonical.side || row.providerId!==canonical.providerId
        || typeof row.updatedAt!=="string" || !row.identity || typeof row.identity!=="object")
        blockers.push("Canonical identity is malformed or belongs to a different provider owner: "+row.pk);
      else conditionalCleanupCandidates.push(record(row,
        "Exact canonical identity; future Apply must verify profile, side, provider ID and version"));
      continue;
    }
    if(row.pk.startsWith("COMPLETED_EVENT#") || row.pk.startsWith("COMPLETED_SERIES#")
      || row.pk.startsWith("COMPLETED_HISTORY#") || row.pk.startsWith("REPLAY#")
      || row.pk.startsWith("DELIVERY#") || row.pk.startsWith("RETIREMENT#")){
      if(exactReference(row,identities)
        || row.pk==="COMPLETED_SERIES#"+target.profile+"#"+target.seriesId
        || row.pk.startsWith("RETIREMENT#"+target.profile+"#"))
        protectedRecords.push(record(row,"Immutable completion, replay, delivery or retirement history must be retained"));
      continue;
    }
    if(controls.includes(row.pk)){
      protectedRecords.push(record(row,"Sync control cannot be deleted as stale audit; future Apply must fence it"));
      continue;
    }
    if(row.pk.startsWith("AUDIT#"+target.profile+"#")){
      if(belongsToTargetAudit(row,inspection,identities))incidentEvidenceForSeparateReview.push(record(row,
        "Possible exclusively attributable audit; review reverse pointers, incident ownership and TTL before cleanup"));
      else if(exactReference(row,identities))protectedRecords.push(record(row,
        "Ambiguous or shared audit reference; preserve unless independently proved exclusive"));
      continue;
    }
    const incidentPrefixes=["REVIEW_CASE#","REVIEW_CONFLICT#","CONFLICT_STATE#",
      "AUDIT_REF#","MANUAL#","REPAIR#","REPAIR_PREVIEW#","RECONCILE_DIAGNOSTIC#"];
    if(incidentPrefixes.some(prefix=>row.pk?.startsWith(prefix))){
      if(exactReference(row,identities)
        || row.pk.startsWith("AUDIT_REF#"+target.profile+"#todoist#"+target.taskId)
        || row.pk.startsWith("AUDIT_REF#"+target.profile+"#calendar#"+target.eventId)) {
        incidentEvidenceForSeparateReview.push(record(row,
          "Incident/reverse-index evidence requires exact case linkage and separate CAS cleanup"));
      }
      continue;
    }
    if(exactReference(row,identities)){
      protectedRecords.push(record(row,
        "Unknown or independently managed reference; not safe to delete without a dedicated contract"));
    }
  }
  for(const [pk,sk] of expected){
    if(!seen.has(pk+"|"+sk))
      blockers.push("Expected mapping/link state key missing from the complete inventory: "+pk);
  }
  if(mapping && (mapping.eventId!==target.eventId || mapping.activeInstanceId!==target.eventId
    || mapping.seriesId!==target.seriesId || link?.eventId!==target.eventId))
    blockers.push("Selected event, active instance and recurrence link do not have one exact whole-series identity");
  const metadataHazards:string[]=[];
  if(mapping?.projectCommentId || mapping?.taskCommentId || mapping?.commentId)
    metadataHazards.push("Existing Todoist mapping comment is retained; durable exclusion must prevent its future re-import");
  const providerEvent=inspection.calendar.occurrence;
  const masterEvent=inspection.calendar.master;
  if([providerEvent,masterEvent].some(event=>
    event?.extendedProperties?.shared?.taskId===target.taskId))
    metadataHazards.push("Calendar shared taskId remains on provider objects; re-ingestion must honour the tombstone");
  metadataHazards.push("Todoist and Calendar provider objects are preserved without ANY metadata edits");
  const uniqueBlockers=[...new Set(blockers)];
  const plan={
    target,scope:"whole_ended_calendar_series" as const,mode:"keep_provider_items" as const,
    inspectedAt:inspection.checkedAt,inspectionFingerprint:inspection.previewFingerprint,
    status:uniqueBlockers.length?"blocked" as const:"reviewable" as const,
    blockers:uniqueBlockers,
    indexRemovalCandidates:stable(indexRemovalCandidates),
    conditionalCleanupCandidates:stable(conditionalCleanupCandidates),
    incidentEvidenceForSeparateReview:stable(incidentEvidenceForSeparateReview),
    protectedRecords:stable(protectedRecords),
    futureSuppressionIdentityKeys:[...new Set(suppression)].sort(),
    providerMetadataHazards:metadataHazards,
    providerWrites:false as const,stateWrites:false as const,applyAvailable:false as const,
  };
  return {...plan,planFingerprint:reviewHash({
    target,inspectionFingerprint:plan.inspectionFingerprint,status:plan.status,
    blockers:plan.blockers,indexes:plan.indexRemovalCandidates,
    cleanup:plan.conditionalCleanupCandidates,
    incidentEvidence:plan.incidentEvidenceForSeparateReview,
    protectedRecords:plan.protectedRecords,
    suppression:plan.futureSuppressionIdentityKeys,hazards:plan.providerMetadataHazards,
  })};
}

/** A new direct provider + full strongly consistent state read on EVERY preview. */
export async function previewRecurrenceRetirement(
  target: RetirementDiagnosticTarget, dependencies: RetirementInspectionDependencies = {},
): Promise<{inspection:RecurrenceRetirementInspection;preview:RetirementPreview}> {
  let rows: readonly InventoryRow[] | undefined;
  const inspection=await inspectRecurrenceRetirement(target,{
    ...dependencies,
    onInventory:items=>{
      rows=items;
      dependencies.onInventory?.(items);
    },
  });
  if(!rows)throw new Error("Retirement preview requires a complete strongly consistent inventory");
  return {inspection,preview:planRecurrenceRetirement(inspection,rows)};
}

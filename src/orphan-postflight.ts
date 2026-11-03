/**
 * #287: conservative, read-only postflight checks for a previously confirmed
 * singleton orphan operation. This is a pure evidence evaluator, not an
 * executor, queue adapter, deletion endpoint or proof of webhook replay.
 *
 * The caller must acquire fresh direct provider readbacks and complete
 * cross-profile inventory independently. Missing/partial evidence fails closed.
 * Acceptance still requires two full reconciliations, webhook replay checks
 * and a separately implemented conditional case retirement.
 */
import {reviewCaseEvidenceIds} from "./deleted-review-identities.js";
import type {OrphanDeletionOperation} from "./orphan-deletion-executor.js";
import type {OrphanEvidenceInventory} from "./orphan-proof-reader.js";
import type {Profile} from "./types.js";

const PROFILES:readonly Profile[]=["home","antonio","work"];
const POSTWRITE_PHASES=new Set(["provider_absent","state_cleaned","workers_resume_started","observing"]);

export interface OrphanPostflightAssessment {
  caseId:string;
  profile:Profile;
  operationId:string;
  checkedAt:string;
  verified:boolean;
  blockers:string[];
}

/** A completed or unknown Todoist object is not evidence of deletion. A
 * cancelled Calendar tombstone and explicitly deleted Todoist item are absent. */
function providerObjectAbsent(side:"todoist"|"calendar",object:Record<string,unknown>):boolean {
  return side==="todoist" ? object.is_deleted===true : object.status==="cancelled";
}
function refers(value:unknown,id:string):boolean {
  if(typeof value==="string")return value.includes(id);
  if(Array.isArray(value))return value.some(entry=>refers(entry,id));
  return Boolean(value && typeof value==="object" &&
    Object.values(value).some(entry=>refers(entry,id)));
}
function exemptEvidenceRow(row:Record<string,unknown>,op:OrphanDeletionOperation,
  sourceAuditKey?:string):boolean {
  if(row.pk==="REVIEW_CASE#"+op.caseId && row.sk==="STATE")return true;
  if(row.pk==="ORPHAN_DELETE#"+op.id && row.sk==="STATE")
    return row.caseId===op.caseId && row.profile===op.profile &&
      row.side===op.side && row.targetId===op.targetId;
  if(row.pk==="ORPHAN_CASE_LOCK#"+op.caseId && row.sk==="STATE")
    return row.operationId===op.id && row.profile===op.profile &&
      row.targetId===op.targetId;
  if(typeof row.pk==="string" && row.pk.startsWith("ORPHAN_PREVIEW#") && row.sk==="STATE")
    return row.caseId===op.caseId && row.profile===op.profile &&
      row.side===op.side && row.targetId===op.targetId &&
      row.actorSubject===op.actorSubject;
  if(row.pk===sourceAuditKey && typeof sourceAuditKey==="string" &&
    sourceAuditKey.startsWith("AUDIT#"+op.profile+"#"))return true;
  if(typeof row.pk==="string" && row.pk.startsWith("REVIEW_CONFLICT#") &&
    row.incidentId===op.caseId)return true;
  return false;
}

/** A postflight result cannot authorize deletion, fence release or case
 * retirement in isolation; the worker must perform independent replay checks. */
export function evaluateOrphanPostflight(op:OrphanDeletionOperation,
  evidence:OrphanEvidenceInventory,checkedAt=new Date().toISOString()):OrphanPostflightAssessment {
  const blockers:string[]=[];
  const item=evidence.item;
  if(!POSTWRITE_PHASES.has(op.phase))
    blockers.push("Operation has not reached a provider-absent phase");
  if(!item || item.id!==op.caseId || item.profile!==op.profile ||
    item.status!=="open" || item.updatedAt!==op.caseUpdatedAt ||
    (item.operationId!==undefined && item.operationId!==op.id))
    blockers.push("Review case identity, profile or version changed");
  if(evidence.target!==null)
    blockers.push("Exact target direct readback is not verified absent");
  const ids=item?reviewCaseEvidenceIds(item):{taskIds:[],eventIds:[]};
  const own=op.side==="todoist"?ids.taskIds:ids.eventIds;
  const other=op.side==="todoist"?ids.eventIds:ids.taskIds;
  const oppositeSide=op.side==="todoist"?"calendar":"todoist";
  if(own.length!==1 || own[0]!==op.targetId || other.length>20)
    blockers.push("Recorded case identities are incomplete or ambiguous");
  if(evidence.counterparts.length!==other.length ||
    other.some(id=>evidence.counterparts.filter(x=>
      x.side===oppositeSide && x.id===id && x.object===null).length!==1))
    blockers.push("Recorded counterpart direct readback is incomplete");

  const complete=Array.isArray(evidence.providers) &&
    evidence.providers.length===PROFILES.length &&
    PROFILES.every(profile=>evidence.providers.filter(p=>p.profile===profile).length===1) &&
    evidence.providers.every(p=>Array.isArray(p.tasks) &&
      Array.isArray(p.events) && Array.isArray(p.comments));
  if(!complete)blockers.push("Complete three-profile provider inventory is unavailable");
  else {
    for(const profile of evidence.providers) {
      const targetObjects=op.side==="todoist"?profile.tasks:profile.events;
      if(targetObjects.some(obj=>obj.id===op.targetId &&
        !providerObjectAbsent(op.side,obj as unknown as Record<string,unknown>)))
        blockers.push("Target remains present or has reappeared in profile "+profile.profile);
      const oppositeObjects=oppositeSide==="todoist"?profile.tasks:profile.events;
      for(const id of other) if(oppositeObjects.some(obj=>obj.id===id &&
        !providerObjectAbsent(oppositeSide,obj as unknown as Record<string,unknown>)))
        blockers.push("Recorded counterpart remains present in profile "+profile.profile+": "+id);
    }
  }
  if(!Array.isArray(evidence.stateRows) ||
    evidence.stateRows.some(row=>!row || typeof row.pk!=="string" || typeof row.sk!=="string"))
    blockers.push("Complete, well-formed state inventory is unavailable");
  else {
    const keys=new Set<string>();
    for(const row of evidence.stateRows) {
      const key=String(row.pk)+"\u0000"+String(row.sk);
      if(keys.has(key))blockers.push("Duplicate state identity in postflight inventory: "+String(row.pk));
      keys.add(key);
      if(![op.targetId,...other].some(id=>refers(row,id)))continue;
      if(!exemptEvidenceRow(row,op,item?.sourceAuditKey))
        blockers.push("Dangling or unattributed state reference: "+String(row.pk)+"/"+String(row.sk));
    }
  }
  return {caseId:op.caseId,profile:op.profile,operationId:op.id,checkedAt,
    verified:blockers.length===0,blockers};
}

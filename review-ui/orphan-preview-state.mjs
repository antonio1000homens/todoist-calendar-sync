/**
 * #287 client-only presentation of an operator's selected alert identity.
 *
 * This module never authorizes a provider DELETE. Only the authenticated API
 * can issue a current case-bound safety preview after authoritative reads.
 * Preview status is never converted into a browser-side execution permission.
 */
const exactId = value => typeof value==="string"&&value.length>0&&value.length<=1024
  && !/[\u0000-\u001f]/.test(value);

/** A blocked but live case-recorded identity may request a server assessment.
 * Ineligible remains ineligible for deletion even when this returns an item. */
export function previewCandidate(items, caseItem, selectedKey) {
  if(!caseItem || caseItem.status!=="open" || !exactId(caseItem.id)
    || !exactId(caseItem.profile) || !Array.isArray(items))return undefined;
  const candidate=items.find(value=>value.key===selectedKey);
  if(!candidate||candidate.profile!==caseItem.profile
    ||!["todoist","calendar"].includes(candidate.side)||!exactId(candidate.id)
    ||candidate.key!==[candidate.profile,candidate.side,candidate.id].join(":")
    ||candidate.live!==true) return undefined;
  return candidate;
}
export function previewBelongsToCase(preview, caseItem, candidate, nowMs=Date.now()) {
  if(!preview||!candidate||!caseItem||caseItem.status!=="open")return false;
  const expires=Date.parse(preview.expiresAt);
  return preview.caseId===caseItem.id && preview.profile===caseItem.profile
    && preview.side===candidate.side && preview.targetId===candidate.id
    && preview.caseUpdatedAt===caseItem.updatedAt
    && exactId(preview.previewId) && exactId(preview.confirmationId)
    && preview.executionQueued===false && preview.stateCleanupPlanned===false
    && Number.isFinite(expires) && expires>nowMs && expires<=nowMs+5*60_000+30_000;
}
/** Invalidates in-flight preview readback whenever direct case evidence is
 * refreshed or the case version changes, even if selection remained the same. */
export function orphanCaseEvidenceVersion(item,snapshots=[]) {
  const refs=Array.isArray(snapshots)?snapshots:[];
  return JSON.stringify([item?.id,item?.profile,item?.updatedAt,refs.map(snapshot=>[
    snapshot?.ref?.profile,snapshot?.ref?.side,snapshot?.ref?.id,
    snapshot?.checkedAt,snapshot?.lookupError,
    snapshot?.object?.id,snapshot?.object?.etag,snapshot?.object?.updated_at,
    snapshot?.mapping?.eventId,snapshot?.mapping?.taskId,
  ])]);
}

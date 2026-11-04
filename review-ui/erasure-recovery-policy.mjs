/** Front-end confirmation is advisory; API and durable worker gates are authoritative. */
export function canApplyRecovery(preview,confirmation,typed,operation) {
  return Boolean(preview?.allowed===true && preview.classification==="pre_write"
    && preview.operationId===operation?.operationId
    && preview.profile===operation?.profile
    && confirmation?.confirmationId
    && Number(confirmation.expiresAt)>Date.now()
    && typed.phrase==="RESTORE SYNC"
    && typed.operationId===preview.operationId
    && typed.profile===preview.profile);
}
export function recoveryNeedsDispatch(status) {
  return ["queued","restoring","verifying"].includes(status);
}

/** This acknowledges evidence only; it cannot approve any post-write release. */
export function canAcknowledgeFencedPostWrite(assessment,token,typed,operation){
  return Boolean(assessment?.reviewEnabled===true
    &&assessment?.classification==="fully_deleted_candidate"
    &&assessment?.releaseAllowed===false
    &&assessment?.onlyAvailableAction==="keep_fenced"
    &&assessment?.reviewStatus!=="reviewed_fenced"
    &&assessment?.operationId===operation?.operationId
    &&assessment?.profile===operation?.profile
    &&token?.confirmationId
    &&token?.operationId===assessment.operationId
    &&token?.profile===assessment.profile
    &&token?.releaseAllowed===false
    &&Number(token.expiresAt)>Date.now()
    &&typed?.phrase==="REVIEW AND KEEP FENCED"
    &&typed?.operationId===assessment.operationId
    &&typed?.profile===assessment.profile);
}

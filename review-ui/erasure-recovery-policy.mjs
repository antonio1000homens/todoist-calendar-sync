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

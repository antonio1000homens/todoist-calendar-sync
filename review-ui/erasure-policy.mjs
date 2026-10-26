/** Client-side guardrails supplement (never replace) authenticated API checks. */
export const profileOptions = ["home", "antonio", "work"];
export const backupNotice = "DynamoDB point-in-time recovery can retain deleted data for up to 35 days. Purging the live table is not backup erasure.";
export function erasurePreviewMatchesSelection(preview, selection) {
  return Boolean(preview && profileOptions.includes(selection.profile)
    && preview.profile === selection.profile
    && preview.target?.taskId === selection.taskId.trim()
    && (preview.target?.eventId || "") === selection.eventId.trim()
    && preview.selectedActions?.deleteTodoist === true
    && preview.selectedActions?.deleteCalendar === selection.deleteCalendar);
}
export function erasureConfirmationReady(preview, selection, typed) {
  return erasurePreviewMatchesSelection(preview, selection)
    && preview.blockers?.length === 0
    && preview.executionEnabled === true
    && typeof preview.operationId === "string"
    && Boolean(preview.confirmation?.confirmationId)
    && Number(preview.confirmation.expiresAt) > Date.now()
    && typed.phrase === "PERMANENTLY ERASE"
    && typed.taskId === selection.taskId.trim()
    && (!selection.deleteCalendar || typed.eventId === selection.eventId.trim());
}
export function erasureCanStart(operation) {
  return operation?.status === "previewed"
    && operation?.providerDeletionReady === true
    && operation?.queueReady === true;
}

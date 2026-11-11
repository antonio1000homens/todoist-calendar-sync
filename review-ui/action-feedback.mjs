// A provider read and a profile-wide request are not evidence of successful cleanup.
export function providerRecheckFeedback(result,checkedAt){
  const prefix=`Provider recheck completed at ${checkedAt}.`;
  const evidence=result?.unmappedDeletion??result?.deletionCleanup;
  if(evidence?.bothGone)return {phase:"success",message:`${prefix} Todoist is missing; Calendar is cancelled/deleted. This was read-only; guarded cleanup is still pending.`};
  if(["partial","unverified","mapping_blocked"].includes(evidence?.state))
    return {phase:"warning",message:`${prefix} Deletion is not fully verified: ${evidence.reason||"current provider or mapping evidence is incomplete"}. No cleanup was performed.`};
  return {phase:"warning",message:`${prefix} Provider evidence refreshed, but deletion is not fully verified. No cleanup was performed.`};
}
export function reconciliationRequestFeedback(profile,result,at){
  const generation=result?.run?.generation?` Generation ${result.run.generation}.`:"";
  const admission=result?.reconciliation?.created===true?"New run requested.":result?.reconciliation?.created===false?"Existing run retained.":"Request accepted.";
  return {phase:"success",message:`Reconciliation request accepted for ${profile} at ${at}. ${admission}${generation} Worker completion and deletion cleanup are not yet verified; check the profile run status and alert.`};
}

/**
 * #372: A held repair lock can be a candidate for an explicitly verified
 * recovery, not a blanket signal to discard its source webhook. This ROUTES
 * work; it does not grant permission to mutate mappings or provider objects.
 * The final Synchronizer and its recovery transaction must revalidate ALL
 * provider identities and controls. No other blocked workflows bypass guards.
 */
import { profileForTodoistProject } from "./config.js";
import type { Mapping, Profile, TodoistTask } from "./types.js";

export type GuardedRecoveryCandidate = {
  profile:Profile;
  mapping:Mapping|undefined;
  sourceTask:TodoistTask;
  action:string|undefined;
  getExactRepairLock:(profile:Profile,taskId:string)=>Promise<string|undefined>;
};

export async function hasGuardedRecoveryDispatchCandidate({
  profile,mapping,sourceTask,action,getExactRepairLock,
}:GuardedRecoveryCandidate):Promise<boolean> {
  if(action!=="upsert" || !mapping || mapping.profile!==profile
    || mapping.taskId!==sourceTask.id || !sourceTask.id
    || !sourceTask.project_id || profileForTodoistProject(sourceTask.project_id)!==profile
    || sourceTask.is_completed || sourceTask.is_deleted) return false;
  // Only the exact currently held task repair may be considered by the
  // downstream guard. An exclusion, pair rejection, completed history marker,
  // different profile or stale provider source still fails closed THERE.
  const owner=await getExactRepairLock(profile,sourceTask.id);
  return typeof owner==="string" && owner.length>0;
}

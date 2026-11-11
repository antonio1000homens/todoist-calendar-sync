/** Privacy-safe, read-only interpretation of exact erasure evidence.
 * These results are intentionally NOT used by recoveryMode or any write guard. */
import {parseDeletionTombstoneComment,type TodoistCommentRecord} from "./mapping-comments.js";
import type {ErasureOperation} from "./erasure-executor.js";
import type {ErasurePreviewResult} from "./erasure-preview.js";

export type InspectionOutcome =
  "unchanged" | "expected_lifecycle_change" | "missing_evidence" | "unexpected_drift";
export type InspectionKey =
  "todoistTask" | "calendarEvent" | "comments" | "projectCommentIds" | "calendarAliases" | "stateInventory";
export interface InspectionComparison {
  expected:string;
  observed:string;
  result:InspectionOutcome;
  explanation:string;
}
export type InspectionComparisons=Record<InspectionKey,InspectionComparison>;
export interface ProjectTombstoneInspection {
  status:"present"|"missing"|"ambiguous"|"not_checked";
  recordedCommentFound:boolean|null;
  markerMatchesTaskAndCalendar:boolean|null;
  recordedCommentCount:number;
  foundCommentCount:number;
  explanation:string;
}
export interface RecordedTombstoneExpectation {
  profile:ErasureOperation["profile"];
  projectId:string;
  taskId:string;
  commentIds:readonly string[];
  eventIds:readonly string[];
}

/** Evaluate only the operation's exact recorded comment IDs, never a fuzzy
 * match on task title or a different comment with similar content. */
export function inspectRecordedProjectTombstone(
  comments:readonly TodoistCommentRecord[],expected:RecordedTombstoneExpectation,
  now=Date.now(),
):ProjectTombstoneInspection {
  const ids=expected.commentIds;
  const unavailable=(explanation:string):ProjectTombstoneInspection=>({
    status:"not_checked",recordedCommentFound:null,markerMatchesTaskAndCalendar:null,
    recordedCommentCount:ids.length,foundCommentCount:0,explanation,
  });
  if(ids.length===0)return unavailable("The original operation did not record a project comment to inspect.");
  if(new Set(ids).size!==ids.length || ids.some(id=>!id))
    return {status:"ambiguous",recordedCommentFound:false,markerMatchesTaskAndCalendar:false,
      recordedCommentCount:ids.length,foundCommentCount:0,
      explanation:"The recorded project-comment inventory is not unique or complete."};
  const expectedEvents=[...new Set(expected.eventIds)].sort();
  const matching=comments.filter(item=>ids.includes(item.id));
  const foundIds=new Set(matching.map(item=>item.id));
  const foundCount=foundIds.size;
  if(foundCount===0)return {status:"missing",recordedCommentFound:false,markerMatchesTaskAndCalendar:null,
    recordedCommentCount:ids.length,foundCommentCount:0,
    explanation:"No exact recorded project comment was found. A different comment cannot substitute for it."};
  if(foundCount!==ids.length||matching.length!==ids.length)
    return {status:"ambiguous",recordedCommentFound:foundCount>0,markerMatchesTaskAndCalendar:false,
      recordedCommentCount:ids.length,foundCommentCount:foundCount,
      explanation:"Only part of the recorded comment set was found, or provider identities were duplicated."};
  const valid=matching.every(item=>{
    const marker=parseDeletionTombstoneComment(item);
    return Boolean(item.project_id===expected.projectId && !item.task_id && !item.is_deleted
      &&marker && marker.profile===expected.profile &&marker.projectId===expected.projectId
      &&marker.taskId===expected.taskId
      &&Date.parse(marker.expiresAt)>now
      &&JSON.stringify([...marker.eventIds].sort())===JSON.stringify(expectedEvents));
  });
  return {status:valid?"present":"ambiguous",recordedCommentFound:true,
    markerMatchesTaskAndCalendar:valid,recordedCommentCount:ids.length,foundCommentCount:foundCount,
    explanation:valid
      ?"The exact recorded project comment has an active 18-day deletion marker matching the operation's task and complete Calendar alias set."
      :"A recorded comment exists, but its marker, scope, expiry or recorded task/Calendar identities do not match. Treat it as changed or uncertain."};
}

const stages=["comments","todoist","calendar","state","finalize_comments","verify"] as const;
function advancedPast(operation:ErasureOperation,stage:typeof stages[number]):boolean {
  const current=operation.lifecycle?.deletionProgress?.stage;
  return Boolean(current && stages.indexOf(current)>stages.indexOf(stage));
}
function same(left:unknown,right:unknown):boolean {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical)
    :value&&typeof value==="object"?Object.fromEntries(Object.entries(value)
      .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
  return JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
}
function subsetOfOriginal(original:ErasureOperation["inventory"],current:ErasurePreviewResult["inventory"]):boolean {
  const key=(r:{key:{pk:string;sk:string}})=>JSON.stringify([r.key.pk,r.key.sk]);
  const rows=new Map(original.map(row=>[key(row),row]));
  return current.every(row=>{
    const expected=rows.get(key(row));
    return Boolean(expected&&expected.type===row.type
      &&(expected.digest===row.digest
        || (expected.receiptCleanup==="scrub_identity_refs"
          && expected.scrubbedDigest===row.digest)));
  });
}
const count=(value:unknown[]|undefined)=>Array.isArray(value)?value.length:0;
function detail(expected:string,observed:string,result:InspectionOutcome,explanation:string):InspectionComparison {
  return {expected,observed,result,explanation};
}
/** Distinguish observations from proof of a safe recovery. In particular,
 * an empty actionPlan without an explicit provider 404/410 is NOT absence proof. */
export function inspectRecoveryComparisons(
  operation:ErasureOperation,snapshot:ErasurePreviewResult,
):InspectionComparisons {
  const old=operation.actionPlan,cur=snapshot.actionPlan;
  const known=snapshot.knownTargetReadback;
  const audit=snapshot.crossProfileEvidence;
  const complete=!audit||(audit.allProfilesQueried===true
    &&audit.stateScan?.allPagesReceived===true&&audit.stateScan?.stronglyConsistent===true);
  const taskMatches=same(old.todoistTask,cur.todoistTask);
  const calendarMatches=same(old.calendarEvent,cur.calendarEvent);
  const commentMatches=same(old.comments,cur.comments);
  const projectMatches=same(old.projectCommentIds,cur.projectCommentIds);
  const aliasMatches=same({a:old.knownCalendarAliases,complete:old.knownCalendarAliasesComplete},
    {a:cur.knownCalendarAliases,complete:cur.knownCalendarAliasesComplete});
  const stateMatches=same(operation.inventory,snapshot.inventory);
  const taskGone=known?.todoist==="absent";
  const calendarGone=known?.calendar==="absent";
  const observedTask=known?.todoist==="present"?"Present on exact read"
    :taskGone?"Explicitly absent on exact read":"Exact read not proven";
  const observedCalendar=known?.calendar==="present"?"Present on exact read"
    :calendarGone?"Explicitly absent on exact read"
    :known?.calendar==="not_recorded"?"Not selected":"Exact read not proven";
  const missed="Current evidence cannot establish whether a lifecycle change is expected. Keep the fence and repeat the exact read.";
  const originalTask=old.todoistTask?"Present at confirmation":"Not recorded at confirmation";
  const originalCalendar=old.calendarEvent?"Present at confirmation":"Not selected for a provider change";
  const task=taskMatches
    ?detail(originalTask,observedTask,"unchanged","Original task identity and content summary matches.")
    :taskGone&&advancedPast(operation,"todoist")
      ?detail(originalTask,observedTask,"expected_lifecycle_change","The recorded checkpoint passed Todoist deletion; an explicit not-found read is consistent with that stage, not proof of recovery.")
      :!known||known.todoist==="unknown"
        ?detail(originalTask,observedTask,"missing_evidence",missed)
        :detail(originalTask,observedTask,"unexpected_drift","The exact task differs before its recorded deletion checkpoint, or the read contains a different revision.");
  const calendar=calendarMatches
    ?detail(originalCalendar,observedCalendar,"unchanged","Original Calendar summary matches.")
    :calendarGone&&operation.selectedActions.deleteCalendar&&advancedPast(operation,"calendar")
      ?detail(originalCalendar,observedCalendar,"expected_lifecycle_change","The deletion checkpoint passed Calendar deletion and the exact event read is absent.")
      :!known||known.calendar==="unknown"
        ?detail(originalCalendar,observedCalendar,"missing_evidence",missed)
        :detail(originalCalendar,observedCalendar,"unexpected_drift","Calendar changed outside the proven deletion sequence. A separate guarded Calendar-drift review may be available.");
  const originalCommentCount=count(old.comments),currentCommentCount=count(cur.comments);
  const comments=commentMatches
    ?detail("Original mapping/task comments: "+originalCommentCount,
      "Current mapping/task comments: "+currentCommentCount,"unchanged","Original comment identities and contents match.")
    :advancedPast(operation,"comments")&&currentCommentCount===0
      ?detail("Original mapping/task comments: "+originalCommentCount,
        "Current mapping/task comments: 0","expected_lifecycle_change","The durable comment checkpoint passed rewriting project comments as bounded tombstones and removing legacy task comments. Verify the marker separately below.")
      :detail("Original mapping/task comments: "+originalCommentCount,
        "Current mapping/task comments: "+currentCommentCount,"unexpected_drift","Recorded comments differ and their lifecycle transition has not been independently proven.");
  const oldIds=count(old.projectCommentIds),newIds=count(cur.projectCommentIds);
  const project=projectMatches
    ?detail("Original project mapping comments: "+oldIds,
      "Current mapping-format comments: "+newIds,"unchanged","Mapping-format comment identities match; this does not establish tombstone presence.")
    :advancedPast(operation,"comments")&&newIds===0
      ?detail("Original project mapping comments: "+oldIds,
        "Current mapping-format comments: 0","expected_lifecycle_change","After tombstone conversion, a project comment is no longer indexed as a mapping. Its exact recorded ID must still be inspected.")
      :detail("Original project mapping comments: "+oldIds,
        "Current mapping-format comments: "+newIds,"unexpected_drift","The project mapping-comment identities changed outside a proven conversion checkpoint.");
  const oldAlias=count(old.knownCalendarAliases),newAlias=count(cur.knownCalendarAliases);
  const aliasOriginal="Original scoped Calendar aliases: "+oldAlias+
    (old.knownCalendarAliasesComplete===false?" (incomplete)":"");
  const aliasCurrent="Current scoped Calendar aliases: "+newAlias+
    (cur.knownCalendarAliasesComplete===false?" (incomplete)":"");
  const aliases=aliasMatches
    ?detail(aliasOriginal,aliasCurrent,"unchanged","Recorded alias identities and completeness match.")
    :!complete||cur.knownCalendarAliasesComplete===false
      ?detail(aliasOriginal,aliasCurrent,"missing_evidence","The cross-profile or alias inventory is incomplete. Do not infer that the difference is a deletion.")
      :advancedPast(operation,"calendar")
        &&newAlias<=oldAlias
        &&(cur.knownCalendarAliases||[]).every(item=>(old.knownCalendarAliases||[]).some(x=>same(item,x)))
        ?detail(aliasOriginal,aliasCurrent,"expected_lifecycle_change","Only recorded aliases disappeared after the Calendar checkpoint; no new alias appeared. This is not global Calendar absence proof.")
        :detail(aliasOriginal,aliasCurrent,"unexpected_drift","An alias was added, modified or removed outside the verified lifecycle expectation.");
  const oldCount=operation.inventory.length,newCount=snapshot.inventory.length;
  const stateExpected="Original attributable state rows: "+oldCount;
  const stateObserved="Current attributable state rows: "+newCount;
  const state=stateMatches
    ?detail(stateExpected,stateObserved,"unchanged","Original row identity and content digests match.")
    :!complete
      ?detail(stateExpected,stateObserved,"missing_evidence","The independent strongly consistent state scan did not complete.")
      :advancedPast(operation,"state")&&subsetOfOriginal(operation.inventory,snapshot.inventory)
        ?detail(stateExpected,stateObserved,"expected_lifecycle_change","Only originally attributed rows were removed or eligible completed delivery receipts were scrubbed. A separate absence check is still required.")
        :detail(stateExpected,stateObserved,"unexpected_drift","State rows were added or changed outside the recorded plan; inspect exact keys privately, not in the public UI.");
  return {todoistTask:task,calendarEvent:calendar,comments,projectCommentIds:project,
    calendarAliases:aliases,stateInventory:state};
}
